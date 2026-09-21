// =============================================================================
// Оркестрирует полную проверку файла в браузере:
//   1) разбор файла (parseFile.ts) — CPU, но без лимита, в отличие от Edge Function
//   2) офлайн-проверки построчно (emailUtils.ts) — тоже CPU, локально
//   3) сверка хэшей с suppression-list — батчами через Edge Function check-suppression
//   4) группировка уникальных доменов + MX — батчами через Edge Function resolve-mx
//   5) сборка итоговой таблицы + xlsx — в браузере
//
// Прогресс отдаётся через onProgress, чтобы интерфейс не выглядел
// подвисшим на больших файлах (100k+ строк).
// =============================================================================
import { supabase } from "./supabaseClient";
import { parseUploadedFile, buildXlsxBlob, type ParsedRow } from "./parseFile";
import {
  offlinePrecheck,
  hashEmail,
  BUILTIN_DISPOSABLE_DOMAINS,
} from "./emailUtils";

export type ProgressStage = "parsing" | "offline" | "suppression" | "mx" | "assembling" | "done";
export type ProgressCallback = (stage: ProgressStage, done: number, total: number) => void;

const SUPPRESSION_BATCH = 10000; // должно совпадать с MAX_HASHES_PER_REQUEST на сервере (RPC, не .in() — не ограничено длиной URL)
const MX_BATCH = 300; // должно совпадать с MAX_DOMAINS_PER_REQUEST на сервере (DoH — несколько запросов на домен)
const YIELD_EVERY = 3000; // строк между отдачей контроля event loop, чтобы UI не подвисал

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function callEdgeFunction<T>(name: string, body: unknown): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const resp = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionData.session?.access_token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error ?? `Ошибка сервера (${resp.status}) в ${name}`);
  return json as T;
}

export type CheckOutcome = {
  outputRows: ParsedRow[];
  stats: Record<string, number>;
};

export async function runCheck(
  file: File,
  emailColumn: string,
  onProgress: ProgressCallback
): Promise<CheckOutcome> {
  onProgress("parsing", 0, 0);
  const rows = await parseUploadedFile(file);
  if (rows.length === 0) {
    throw new Error("Файл пуст");
  }

  // Ищем колонку без учёта регистра и пробелов по краям — реальные файлы
  // часто приходят с 'Email', 'E-mail', 'email ' и т.п. вместо точного 'email'.
  const actualColumns = Object.keys(rows[0]);
  const wanted = emailColumn.trim().toLowerCase();
  const resolvedColumn = actualColumns.find((c) => c.trim().toLowerCase() === wanted);
  if (!resolvedColumn) {
    throw new Error(
      `В файле нет колонки '${emailColumn}'. Найдены колонки: ${actualColumns.join(", ")}`
    );
  }

  // --- ФАЗА 1: офлайн-проверки (без сети, но с периодическими "вдохами"
  // для event loop, чтобы вкладка не казалась зависшей на 100k+ строк) ---
  type PendingRow = { rowIndex: number; emailNorm: string; domain: string };
  const pendingSuppression: PendingRow[] = [];
  const statusByRow = new Map<number, { status: string; comment: string; suggestedDomain?: string }>();

  for (let i = 0; i < rows.length; i++) {
    const email = rows[i][resolvedColumn];
    const r = offlinePrecheck(email, BUILTIN_DISPOSABLE_DOMAINS);
    if (r.status === "NEEDS_SUPPRESSION_CHECK") {
      pendingSuppression.push({ rowIndex: i, emailNorm: r.emailNorm, domain: r.domain });
    } else {
      statusByRow.set(i, r);
    }
    if (i % YIELD_EVERY === 0) {
      onProgress("offline", i, rows.length);
      await yieldToUI();
    }
  }
  onProgress("offline", rows.length, rows.length);

  // --- ФАЗА 2: хэшируем и сверяем с suppression-list батчами ---
  const hashToRows = new Map<string, PendingRow[]>();
  for (let i = 0; i < pendingSuppression.length; i++) {
    const p = pendingSuppression[i];
    const h = await hashEmail(p.emailNorm);
    const arr = hashToRows.get(h) ?? [];
    arr.push(p);
    hashToRows.set(h, arr);
    if (i % YIELD_EVERY === 0) {
      onProgress("suppression", i, pendingSuppression.length);
      await yieldToUI();
    }
  }

  const allHashes = Array.from(hashToRows.keys());
  const suppressedHashes = new Set<string>();
  const hashBatches = chunk(allHashes, SUPPRESSION_BATCH);
  for (let i = 0; i < hashBatches.length; i++) {
    const { suppressed } = await callEdgeFunction<{ suppressed: string[] }>(
      "check-suppression",
      { hashes: hashBatches[i] }
    );
    for (const h of suppressed) suppressedHashes.add(h);
    onProgress("suppression", (i + 1) * SUPPRESSION_BATCH, allHashes.length);
  }

  const pendingMx: PendingRow[] = [];
  for (const [hash, rowsForHash] of hashToRows) {
    if (suppressedHashes.has(hash)) {
      for (const p of rowsForHash) {
        statusByRow.set(p.rowIndex, {
          status: "DELETE_SUPPRESSED",
          comment: "уже известен как мёртвый (suppression-list из прошлых bounce)",
        });
      }
    } else {
      pendingMx.push(...rowsForHash);
    }
  }

  // --- ФАЗА 3: группировка уникальных доменов + MX батчами ---
  // Категории теперь точнее, чем просто "ok/не ok" — см. _shared/mxCheck.ts
  // на сервере: NXDOMAIN и NODATA больше не смешиваются в одну корзину.
  type MxResult = { category: string; detail: string };
  const uniqueDomains = Array.from(new Set(pendingMx.map((p) => p.domain)));
  const mxResults = new Map<string, MxResult>();
  const domainBatches = chunk(uniqueDomains, MX_BATCH);
  for (let i = 0; i < domainBatches.length; i++) {
    const { results } = await callEdgeFunction<{ results: Record<string, MxResult> }>(
      "resolve-mx",
      { domains: domainBatches[i] }
    );
    for (const [domain, r] of Object.entries(results)) mxResults.set(domain, r);
    onProgress("mx", (i + 1) * MX_BATCH, uniqueDomains.length);
  }

  for (const p of pendingMx) {
    const mx = mxResults.get(p.domain);
    if (!mx) {
      statusByRow.set(p.rowIndex, { status: "DNS_INCONCLUSIVE", comment: "результат по домену не получен" });
      continue;
    }
    // Категория с сервера уже и есть финальный статус — mxCheck.ts на
    // сервере отдаёт готовые OK / DELETE_DOMAIN_NOT_EXISTS /
    // NO_MAIL_SUSPECTED / DNS_INCONCLUSIVE / DNS_INCONSISTENT напрямую,
    // транслировать их через switch не нужно (и не нужно поддерживать
    // список вручную при добавлении новых категорий).
    statusByRow.set(p.rowIndex, { status: mx.category, comment: mx.detail });
  }

  // --- ФАЗА 4: сборка итоговой таблицы ---
  onProgress("assembling", 0, rows.length);
  const stats: Record<string, number> = {};
  const outputRows: ParsedRow[] = rows.map((row, idx) => {
    const r = statusByRow.get(idx)!;
    stats[r.status] = (stats[r.status] ?? 0) + 1;
    return { ...row, status: r.status, comment: r.comment, suggested_domain: r.suggestedDomain ?? "" };
  });

  onProgress("done", rows.length, rows.length);
  return { outputRows, stats };
}

export { buildXlsxBlob };
