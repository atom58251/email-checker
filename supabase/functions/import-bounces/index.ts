// =============================================================================
// Edge Function: import-bounces
//
// Только для админа. Принимает bounce-отчёт (файл, который админ загрузил
// в bucket 'uploads' под своим user_id) и пополняет suppression_entries.
// Email хэшируются перед записью в БД — открытый адрес в базе не остаётся.
//
// Поддерживает оба формата, с которыми уже сталкивались:
//   - отдельная колонка email/address/recipient
//   - только smtp_response, адрес извлекается регуляркой (если провайдер
//     его туда публикует; Gmail/Yandex — нет, такие строки пропускаются
//     и возвращаются в ответе как unresolvedCount, без попытки угадать)
// =============================================================================
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { hashEmail, checkSyntax, EMAIL_IN_TEXT_RE, classifyCategory, normalizeReportDate } from "../_shared/emailUtils.ts";
import { parseUploadedFile } from "../_shared/parseFile.ts";
import { handleCorsPreflight, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonResponse({ error: "Не авторизован" }, { status: 401 });
  }
  const adminUserId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // проверяем роль admin на сервере — не доверяем клиенту
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", adminUserId)
    .single();
  if (profile?.role !== "admin") {
    return jsonResponse({ error: "Требуются права администратора" }, { status: 403 });
  }

  const { storagePath, filename, emailColumn } = await req.json();
  if (!storagePath) {
    return jsonResponse({ error: "storagePath обязателен" }, { status: 400 });
  }

  try {
    const { data: fileBlob, error: dlErr } = await admin.storage.from("uploads").download(storagePath);
    if (dlErr || !fileBlob) throw new Error(`Не удалось скачать файл: ${dlErr?.message}`);

    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    const rows = parseUploadedFile(bytes, filename ?? "report.csv");

    if (rows.length === 0) throw new Error("Файл пуст");
    if (!("category" in rows[0])) {
      throw new Error(`В отчёте нет колонки 'category'. Найдены: ${Object.keys(rows[0]).join(", ")}`);
    }

    const candidates = [emailColumn, "email", "address", "recipient", "recipient_email"].filter(Boolean);
    const foundEmailCol = candidates.find((c) => c in rows[0]);

    let resolvedFromColumn = 0;
    let resolvedFromText = 0;
    let unresolved = 0;
    let trapsFound = 0;
    let dateFallbackCount = 0;
    const senderIssueCounts: Record<string, number> = {};
    const upserts: Array<{
      email_hash: string;
      domain: string;
      reason: string;
      category: string;
      action: string;
      is_trap: boolean;
      last_seen: string;
      added_by: string;
    }> = [];

    for (const row of rows) {
      const category = String(row["category"] ?? "").trim();
      // ВАЖНО: action НЕ берём дословно из файла. У разных источников разные
      // слова для одного и того же смысла — у Postal action='RETRY in 2-4
      // weeks' (содержит 'retry'), у Listmonk та же по сути ситуация
      // называется action='review' (НЕ содержит 'retry'). Если хранить
      // чужое слово как есть, 28-дневное автоистечение (см. миграцию 0008,
      // проверяет action ILIKE '%retry%') могло бы не сработать для
      // Listmonk-записей, которые классификатор считает временными —
      // запись осела бы в базе навсегда вопреки своей же категории.
      // Поэтому action всегда выводим из НАШЕЙ классификации категории —
      // она единый источник истины и для "хранить или нет", и для
      // "навсегда или временно".
      const dateRaw = String(row["sent_utc"] ?? row["added_utc"] ?? "").trim();
      const dateNormalized = normalizeReportDate(dateRaw);
      if (dateRaw && !dateNormalized) dateFallbackCount++;
      const text = String(row["smtp_response"] ?? row["last_response"] ?? "");

      const bucket = classifyCategory(category);
      const action = bucket === "RETRY_LATER" ? "RETRY in 2-4 weeks" : "DELETE from list";

      // SENDER_ISSUE: проблема отправителя (throttling, временная
      // недоступность сервера, отказ по политике) — НЕ повод удалять
      // адрес получателя. Не трогаем suppression-list, только считаем
      // для сводки в ответе (например, чтобы предупредить про throttling).
      if (bucket === "SENDER_ISSUE") {
        senderIssueCounts[category] = (senderIssueCounts[category] ?? 0) + 1;
        continue;
      }

      let email: string | null = null;
      if (foundEmailCol) {
        const val = String(row[foundEmailCol] ?? "").trim();
        if (val && checkSyntax(val)) email = val;
      }
      if (email) {
        resolvedFromColumn++;
      } else {
        const matches = text.match(EMAIL_IN_TEXT_RE);
        if (matches?.[0]) {
          email = matches[0];
          resolvedFromText++;
        }
      }

      if (email) {
        const emailNorm = email.toLowerCase();
        const domain = emailNorm.split("@")[1];
        const isTrap = bucket === "TRAP";
        if (isTrap) trapsFound++;
        upserts.push({
          email_hash: await hashEmail(emailNorm),
          domain,
          reason: text.trim() || category,
          category,
          action,
          is_trap: isTrap,
          last_seen: dateNormalized ?? new Date().toISOString().slice(0, 10),
          added_by: adminUserId,
        });
      } else {
        unresolved++;
      }
    }

    // upsert по email_hash: если запись уже есть — обновляем last_seen/bounce_count
    // через RPC (простой upsert с increment пишем как отдельный SQL-вызов)
    const CHUNK = 500;
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const chunk = upserts.slice(i, i + CHUNK);
      const { error: upsertErr } = await admin.rpc("upsert_suppression_batch", {
        entries: chunk,
      });
      if (upsertErr) throw new Error(`Ошибка записи в suppression-list: ${upsertErr.message}`);
    }

    await admin.from("admin_audit_log").insert({
      admin_id: adminUserId,
      action: "import_bounces",
      details: {
        filename, resolvedFromColumn, resolvedFromText, unresolved,
        total: rows.length, trapsFound, senderIssueCounts, dateFallbackCount,
      },
    });

    // исходный отчёт можно удалить — он больше не нужен после импорта
    await admin.storage.from("uploads").remove([storagePath]);

    return jsonResponse({
      ok: true,
      resolvedFromColumn,
      resolvedFromText,
      unresolved,
      totalAddedOrUpdated: upserts.length,
      trapsFound,
      senderIssueCounts,
      dateFallbackCount,
    });
  } catch (e) {
    return jsonResponse({ error: String(e?.message ?? e) }, { status: 500 });
  }
});
