// =============================================================================
// Офлайн-проверки email — работают в браузере пользователя, не на сервере.
// Идентично supabase/functions/_shared/emailUtils.ts по логике (это
// сознательное дублирование: Edge Function по-прежнему использует свою
// копию для check-suppression/import-bounces/resolve-mx, а здесь —
// копия для клиента, чтобы разбор 100k+ строк не упирался в CPU time
// limit Edge Functions).
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

export function checkSyntax(email: string): boolean {
  if (typeof email !== "string") return false;
  const e = email.trim();
  if (e.split("@").length !== 2) return false;
  return EMAIL_RE.test(e);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
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

/** SHA-256 хэш через Web Crypto API — тот же интерфейс crypto.subtle
 *  доступен и в браузере, и в Deno, поэтому хэш всегда совпадает. */
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

export function offlinePrecheck(emailRaw: unknown, disposableDomains: Set<string>): OfflineResult {
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

// Статусы, которые НЕ удаляются автоматически, но требуют внимания:
// NO_MAIL_SUSPECTED   — оба резолвера согласны: ни MX, ни A/AAAA нет, но
//   это не равно "домена нет" — может быть нестандартная настройка.
// DNS_INCONCLUSIVE    — резолвер(ы) не дали содержательного ответа
//   (SERVFAIL/REFUSED/таймаут) — технический сбой, не сигнал о домене.
// DNS_INCONSISTENT    — резолверы дали два РАЗНЫХ содержательных ответа
//   (например, один говорит NXDOMAIN, другой — что домен существует).
export const REVIEW_STATUSES = new Set(["NO_MAIL_SUSPECTED", "DNS_INCONCLUSIVE", "DNS_INCONSISTENT"]);
