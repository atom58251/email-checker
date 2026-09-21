// =============================================================================
// Общие утилиты проверки email — портированы из check_emails.py.
// Используются в Edge Functions check-emails и import-bounces.
// =============================================================================

export const KNOWN_DOMAINS = [
  "mail.ru", "inbox.ru", "bk.ru", "list.ru", "internet.ru",
  "yandex.ru", "yandex.com", "yandex.by", "yandex.kz", "ya.ru",
  "rambler.ru", "lenta.ru", "autorambler.ru", "myrambler.ru", "ro.ru",
  "gmail.com", "googlemail.com",
  "ukr.net", "i.ua", "meta.ua", "email.ua", "bigmir.net",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "protonmail.com", "proton.me",
  "gmx.com", "gmx.net", "zoho.com", "mail.com",
  "tutanota.com", "yandex.ua",
];

export const KNOWN_TLDS = [
  "com", "ru", "ua", "net", "org", "by", "kz", "info", "biz",
  "co", "io", "me", "edu", "gov", "рф",
];

export const BUILTIN_DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "maildrop.cc", "guerrillamail.com", "guerrillamail.info",
  "10minutemail.com", "10minutemail.net", "yopmail.com", "yopmail.fr",
  "temp-mail.org", "tempmail.dev", "tempmail.com", "throwawaymail.com",
  "trashmail.com", "trashmail.net", "fakeinbox.com", "getnada.com",
  "dispostable.com", "sharklasers.com", "mailcatch.com", "mohmal.com",
  "mytemp.email", "emailondeck.com", "inboxbear.com", "spamgourmet.com",
  "mailnesia.com", "mailinator.net", "mailinator.org", "mintemail.com",
  "moakt.com", "moakt.cc", "burnermail.io", "fake-mail.net",
  "discard.email", "discardmail.com", "spam4.me", "tempinbox.com",
]);

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function checkSyntax(email: string): boolean {
  if (typeof email !== "string") return false;
  const e = email.trim();
  if (e.split("@").length !== 2) return false;
  return EMAIL_RE.test(e);
}

// простая метрика похожести строк (Левенштейн), достаточно для опечаток
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function closestMatch(value: string, candidates: string[], cutoff: number): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = similarity(value, c);
    if (score >= cutoff && score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

export function findDomainTypo(domainRaw: string): string | null {
  const domain = domainRaw.toLowerCase();
  if (KNOWN_DOMAINS.includes(domain)) return null;

  const closeWhole = closestMatch(domain, KNOWN_DOMAINS, 0.77);
  if (closeWhole) return closeWhole;

  const dotIdx = domain.lastIndexOf(".");
  if (dotIdx > 0) {
    const name = domain.slice(0, dotIdx);
    const tld = domain.slice(dotIdx + 1);
    const knownNames = KNOWN_DOMAINS.map((d) => d.slice(0, d.lastIndexOf(".")));
    const closeName = closestMatch(name, knownNames, 0.86);
    if (closeName) {
      const matchedDomain = KNOWN_DOMAINS[knownNames.indexOf(closeName)];
      if (!KNOWN_TLDS.includes(tld)) return matchedDomain;
      if (name !== closeName) return matchedDomain;
    }
    if (!KNOWN_TLDS.includes(tld)) {
      const closeTld = closestMatch(tld, KNOWN_TLDS, 0.6);
      if (closeTld) return `${name}.${closeTld}`;
    }
  }
  return null;
}

/**
 * SHA-256 хэш нормализованного email (lowercase + trim) в hex.
 * Используется для suppression-list, чтобы НЕ хранить сами адреса в БД.
 */
export async function hashEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type OfflineResult =
  | { status: "EMPTY" | "INVALID_SYNTAX" | "DELETE_DISPOSABLE" | "TYPO_SUSPECTED"; comment: string; suggestedDomain?: string }
  | { status: "NEEDS_SUPPRESSION_CHECK"; emailNorm: string; domain: string };

/**
 * Офлайн-проверки, которые не требуют ни сети, ни базы данных:
 * синтаксис, disposable-домен, опечатка. Suppression и MX проверяются
 * отдельно (suppression — батчем через БД, MX — батчем через DNS),
 * см. index.ts команды check-emails.
 */
export function offlinePrecheck(emailRaw: string, disposableDomains: Set<string>): OfflineResult {
  if (typeof emailRaw !== "string" || !emailRaw.trim()) {
    return { status: "EMPTY", comment: "пустое значение" };
  }
  const email = emailRaw.trim();
  if (!checkSyntax(email)) {
    return { status: "INVALID_SYNTAX", comment: "некорректный синтаксис адреса" };
  }
  const emailNorm = email.toLowerCase();
  const domain = emailNorm.split("@")[1];

  if (disposableDomains.has(domain)) {
    return { status: "DELETE_DISPOSABLE", comment: `одноразовый почтовый сервис (${domain})` };
  }

  const suggestion = findDomainTypo(domain);
  if (suggestion) {
    return {
      status: "TYPO_SUSPECTED",
      comment: `похоже на опечатку, возможно имелось в виду '${suggestion}'`,
      suggestedDomain: suggestion,
    };
  }

  return { status: "NEEDS_SUPPRESSION_CHECK", emailNorm, domain };
}

export const DELETE_STATUSES = new Set([
  "INVALID_SYNTAX", "DELETE_SUPPRESSED", "DELETE_DISPOSABLE",
  "DELETE_DOMAIN_NOT_EXISTS", "TYPO_SUSPECTED", "EMPTY",
]);

export const REVIEW_STATUSES = new Set(["NO_MAIL_SUSPECTED", "DNS_INCONCLUSIVE", "DNS_INCONSISTENT"]);

// =============================================================================
// Классификация категорий bounce-отчётов — три уровня строгости.
// Портировано из check_emails.py (CATEGORY_RULES / classify_category).
// Не всё, что попадает в bounce-отчёт, говорит о проблеме АДРЕСА:
// часть категорий (mail_server_unreachable, server_refuses_mail,
// gmail_throttling) говорит о проблеме ВАШЕЙ отправки — заблокировать
// по ним адрес получателя навсегда значит наказать невиновного.
// А disposable_or_trap — наоборот, самая опасная категория, её нельзя
// разрешить "смягчить" повторным импортом с другой категорией
// (см. is_trap и upsert_suppression_batch в 0004_trap_protection.sql).
// =============================================================================
export type CategoryBucket = "PERMANENT_BLOCK" | "TRAP" | "RETRY_LATER" | "SENDER_ISSUE";

const CATEGORY_RULES: Array<[string, CategoryBucket]> = [
  ["address does not exist", "PERMANENT_BLOCK"],
  ["invalid_mailbox", "PERMANENT_BLOCK"],
  ["invalid mailbox", "PERMANENT_BLOCK"],
  ["domain_has_no_mail_server", "PERMANENT_BLOCK"],
  ["broken mx record", "PERMANENT_BLOCK"],
  ["yandex account blocked by yandex", "PERMANENT_BLOCK"],
  ["disposable inbox service", "PERMANENT_BLOCK"],

  ["disposable_or_trap", "TRAP"],

  ["mailbox full", "RETRY_LATER"],
  ["mailbox_full", "RETRY_LATER"],

  ["mail_server_unreachable", "SENDER_ISSUE"],
  ["server_refuses_mail", "SENDER_ISSUE"],
  ["gmail_throttling", "SENDER_ISSUE"],
];

/**
 * Сравнение — по вхождению подстроки (без учёта регистра), не точное
 * равенство: реальные отчёты добавляют уточнения в скобках, например
 * "address does not exist (mail.com)". Если категория не распознана —
 * возвращаем SENDER_ISSUE: безопаснее пропустить неизвестный статус,
 * чем удалить живой адрес по формулировке, которую мы ещё не видели.
 */
export function classifyCategory(category: string): CategoryBucket {
  const text = category.trim().toLowerCase();
  for (const [key, bucket] of CATEGORY_RULES) {
    if (text.includes(key)) return bucket;
  }
  return "SENDER_ISSUE";
}
