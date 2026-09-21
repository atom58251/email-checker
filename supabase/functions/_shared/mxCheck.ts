// =============================================================================
// Резолв MX через DNS-over-HTTPS (DoH) — Google + Cloudflare, две независимые
// проверки для каждого "опасного" исхода.
//
// ПЯТЬ ИТОГОВЫХ КАТЕГОРИЙ (важно различать причину, а не просто "не ОК"):
//
//   OK                        — есть MX (или implicit MX через A/AAAA,
//                                RFC 5321). Оставить.
//   DELETE_DOMAIN_NOT_EXISTS  — ОБА резолвера независимо подтвердили
//                                NXDOMAIN. Единственная категория с
//                                автоудалением.
//   NO_MAIL_SUSPECTED         — ОБА резолвера согласны: домен существует
//                                (успешный ответ), но нет ни MX, ни A/AAAA.
//                                Не равно "домена нет" — не удалять
//                                автоматически, требует ручного решения.
//   DNS_INCONCLUSIVE          — резолвер(ы) НЕ СМОГЛИ дать содержательный
//                                ответ: SERVFAIL, REFUSED, таймаут, сетевая
//                                ошибка. Технический сбой, а не сигнал о
//                                домене. Пример из практики: sibmail.com —
//                                и Google, и Cloudflare независимо вернули
//                                SERVFAIL ("No Reachable Authority at
//                                delegation") — это проблема авторитетного
//                                DNS-сервера домена, а не повод удалять
//                                адрес. Не удалять.
//   DNS_INCONSISTENT          — резолверы дали ДВА РАЗНЫХ содержательных
//                                (успешных) ответа: например, Google говорит
//                                NXDOMAIN, а Cloudflare — что домен
//                                существует (Status=0). Это не техническая
//                                неудача одного из них, а реальное
//                                расхождение достоверных данных — может
//                                быть из-за неполной репликации DNS,
//                                гео-специфичной делегации и т.п. Не удалять,
//                                показывать отдельно для ручного разбора.
//
// Ключевое отличие DNS_INCONCLUSIVE от DNS_INCONSISTENT:
//   INCONCLUSIVE — резолвер(ы) ни на что не ответили содержательно.
//   INCONSISTENT — резолверы ОТВЕТИЛИ, но по-разному.
// Обе категории объединяет то, что ни одна не даёт достаточных оснований
// для удаления — но для диагностики (например, если один и тот же домен
// массово попадает в INCONSISTENT — стоит присмотреться к его DNS-настройке)
// их стоит различать в отчёте, а не сваливать в одну кучу.
//
// БЕЗОПАСНОСТЬ ДЛЯ IP: единственный сетевой "собеседник" — публичный
// DNS-резолвер (Google, Cloudflare) по HTTPS, НЕ сервер получателя почты.
// =============================================================================

export type MxCategory =
  | "OK"
  | "DELETE_DOMAIN_NOT_EXISTS"
  | "NO_MAIL_SUSPECTED"
  | "DNS_INCONCLUSIVE"
  | "DNS_INCONSISTENT";

export type MxResult = { category: MxCategory; detail: string };

const QUERY_TIMEOUT_MS = 4000;
const CONCURRENCY_LIMIT = 15;

type DoHAnswer = { name: string; type: number; TTL: number; data: string };
type DoHResponse = { Status: number; Answer?: DoHAnswer[] };

const TYPE_MX = 15;
const TYPE_A = 1;
const STATUS_NOERROR = 0;
const STATUS_NXDOMAIN = 3;

async function dohFetch(url: string, headers?: Record<string, string>): Promise<DoHResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) throw new Error(`DoH HTTP ${resp.status}`);
    return (await resp.json()) as DoHResponse;
  } finally {
    clearTimeout(timeout);
  }
}

function queryGoogle(domain: string, type: "MX" | "A"): Promise<DoHResponse> {
  return dohFetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`);
}

function queryCloudflare(domain: string, type: "MX" | "A"): Promise<DoHResponse> {
  return dohFetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
    { accept: "application/dns-json" }
  );
}

type Provider = (domain: string, type: "MX" | "A") => Promise<DoHResponse>;

/** Одна попытка + один повтор при сетевой ошибке/таймауте. null = резолвер недоступен. */
async function queryWithRetry(provider: Provider, domain: string, type: "MX" | "A"): Promise<DoHResponse | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await provider(domain, type);
    } catch {
      // сетевая ошибка/таймаут — один повтор, потом сдаёмся
    }
  }
  return null;
}

function hasRecordType(resp: DoHResponse | null, type: number): boolean {
  return !!resp && resp.Status === STATUS_NOERROR && (resp.Answer ?? []).some((a) => a.type === type);
}

/** "Содержательный" ответ — резолвер реально что-то сказал про домен (не ошибка транспорта/сервера). */
function isDefinitive(resp: DoHResponse | null): boolean {
  return resp !== null && (resp.Status === STATUS_NOERROR || resp.Status === STATUS_NXDOMAIN);
}

async function classifyDomain(domain: string): Promise<MxResult> {
  let primary = await queryWithRetry(queryGoogle, domain, "MX");
  let primaryName = "Google";
  let confirmProvider: Provider = queryCloudflare;
  let confirmName = "Cloudflare";

  if (primary === null) {
    primary = await queryWithRetry(queryCloudflare, domain, "MX");
    primaryName = "Cloudflare";
    confirmProvider = queryGoogle;
    confirmName = "Google";
  }

  if (primary === null) {
    return { category: "DNS_INCONCLUSIVE", detail: "оба DNS-резолвера недоступны (сетевая ошибка/таймаут)" };
  }

  // --- Первичный ответ — NXDOMAIN: нужно подтверждение второго резолвера ---
  if (primary.Status === STATUS_NXDOMAIN) {
    const confirm = await queryWithRetry(confirmProvider, domain, "MX");
    if (confirm === null) {
      return {
        category: "DNS_INCONCLUSIVE",
        detail: `${primaryName}=NXDOMAIN, но ${confirmName} не ответил для подтверждения`,
      };
    }
    if (confirm.Status === STATUS_NXDOMAIN) {
      return {
        category: "DELETE_DOMAIN_NOT_EXISTS",
        detail: `NXDOMAIN подтверждён двумя резолверами (${primaryName} + ${confirmName})`,
      };
    }
    if (isDefinitive(confirm)) {
      // второй резолвер ответил содержательно, но НЕ NXDOMAIN — реальное расхождение
      return {
        category: "DNS_INCONSISTENT",
        detail: `${primaryName}=NXDOMAIN, но ${confirmName}=NOERROR (домен существует по его данным)`,
      };
    }
    // confirm ответил, но с кодом ошибки (SERVFAIL/REFUSED) — не расхождение, а сбой
    return {
      category: "DNS_INCONCLUSIVE",
      detail: `${primaryName}=NXDOMAIN, но ${confirmName} вернул ошибку (Status=${confirm.Status}) вместо подтверждения`,
    };
  }

  // --- Первичный ответ — код ошибки (SERVFAIL/REFUSED и т.п.), не NOERROR и не NXDOMAIN ---
  if (primary.Status !== STATUS_NOERROR) {
    const fallback = await queryWithRetry(confirmProvider, domain, "MX");
    if (fallback === null || !isDefinitive(fallback)) {
      // оба резолвера не смогли дать содержательный ответ — классический
      // случай sibmail.com: SERVFAIL с обеих сторон
      return {
        category: "DNS_INCONCLUSIVE",
        detail: `оба резолвера не дали содержательного ответа (${primaryName} Status=${primary.Status}` +
          (fallback ? `, ${confirmName} Status=${fallback.Status})` : `, ${confirmName} недоступен)`),
      };
    }
    // fallback ответил содержательно (NOERROR или NXDOMAIN) — используем его,
    // но помним, что подтверждения ВТОРЫМ резолвером у него самого ещё нет
    if (fallback.Status === STATUS_NXDOMAIN) {
      // только один резолвер подтвердил NXDOMAIN (primary был недоступен по
      // существу) — по правилу "нужны оба" этого недостаточно для удаления
      return {
        category: "DNS_INCONCLUSIVE",
        detail: `${confirmName}=NXDOMAIN, но ${primaryName} вернул ошибку (Status=${primary.Status}) — только одно подтверждение, этого недостаточно для удаления`,
      };
    }
    primary = fallback;
    primaryName = confirmName;
    confirmProvider = primaryName === "Google" ? queryCloudflare : queryGoogle;
    confirmName = confirmProvider === queryCloudflare ? "Cloudflare" : "Google";
  }

  // --- Status 0 (NOERROR): проверяем наличие MX ---
  if (hasRecordType(primary, TYPE_MX)) {
    return { category: "OK", detail: `MX-запись найдена (${primaryName})` };
  }

  // NODATA на MX — проверяем A-запись того же резолвера (implicit MX, RFC 5321)
  const aRecord = await queryWithRetry(primaryName === "Google" ? queryGoogle : queryCloudflare, domain, "A");
  if (hasRecordType(aRecord, TYPE_A)) {
    return {
      category: "OK",
      detail: `MX-записи нет, но есть A-запись — неявный MX по RFC 5321 (${primaryName})`,
    };
  }

  // Ни MX, ни A у основного резолвера — перепроверяем вторым
  const confirmMx = await queryWithRetry(confirmProvider, domain, "MX");
  if (confirmMx === null || !isDefinitive(confirmMx)) {
    return {
      category: "DNS_INCONCLUSIVE",
      detail: `${primaryName}: ни MX, ни A не найдено, но ${confirmName} не дал содержательного ответа для подтверждения`,
    };
  }
  if (confirmMx.Status === STATUS_NXDOMAIN) {
    // primary считает домен существующим (NOERROR/NODATA), confirm говорит NXDOMAIN — расхождение
    return {
      category: "DNS_INCONSISTENT",
      detail: `${primaryName}=NOERROR (домен существует), но ${confirmName}=NXDOMAIN`,
    };
  }
  if (hasRecordType(confirmMx, TYPE_MX)) {
    return {
      category: "DNS_INCONSISTENT",
      detail: `${primaryName}: MX не найден, но ${confirmName} нашёл MX-запись — расхождение данных`,
    };
  }
  const confirmA = await queryWithRetry(confirmProvider, domain, "A");
  if (hasRecordType(confirmA, TYPE_A)) {
    return {
      category: "OK",
      detail: `MX-записи нет, но есть A-запись по ${confirmName} (неявный MX, RFC 5321)`,
    };
  }

  return {
    category: "NO_MAIL_SUSPECTED",
    detail: `ни MX, ни A/AAAA не найдено — подтверждено двумя резолверами (${primaryName} + ${confirmName})`,
  };
}

/**
 * Резолвит батч уникальных доменов с ограниченным параллелизмом и мягким
 * дедлайном на весь батч — недообработанные домены получают
 * DNS_INCONCLUSIVE вместо того, чтобы функция упёрлась в таймаут платформы.
 */
export async function resolveMxForDomains(
  domains: string[],
  softDeadlineMs = 40000
): Promise<Map<string, MxResult>> {
  const results = new Map<string, MxResult>();
  const queue = [...domains];
  const start = Date.now();

  async function worker() {
    while (queue.length > 0) {
      if (Date.now() - start > softDeadlineMs) {
        let d: string | undefined;
        while ((d = queue.shift())) {
          results.set(d, {
            category: "DNS_INCONCLUSIVE",
            detail: "не успели проверить в отведённое время — повторите проверку позже",
          });
        }
        return;
      }
      const domain = queue.shift();
      if (!domain) continue;
      results.set(domain, await classifyDomain(domain));
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY_LIMIT, domains.length) }, worker);
  await Promise.all(workers);
  return results;
}
