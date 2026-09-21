// =============================================================================
// Edge Function: resolve-mx
//
// Принимает список УНИКАЛЬНЫХ доменов (клиент сам делает set() перед
// отправкой). Резолвит через DoH (см. _shared/mxCheck.ts) — HTTPS, не сырой
// UDP DNS, поэтому не спотыкается о сетевые особенности Docker.
//
// КЭШ МЁРТВЫХ ДОМЕНОВ (dead_domains, см. миграцию 0007):
//   1) перед DNS-резолвом сверяем домены с кэшем — уже подтверждённые
//      домены отдаём мгновенно, без единого сетевого запроса;
//   2) домены, для которых DNS свежо подтвердил DELETE_DOMAIN_NOT_EXISTS,
//      сразу пишем обратно в кэш — следующая проверка (даже другого
//      пользователя) для этого же домена не потребует сети вообще.
// Это и ускоряет повторные проверки, и делает результат стабильным между
// запусками (раньше DELETE_DOMAIN_NOT_EXISTS каждый раз резолвился заново
// вживую и мог чуть отличаться от прогона к прогону).
//
// Размер батча сознательно небольшой (300 по умолчанию): на каждый домен,
// не найденный в кэше, может уйти от 1 до 4 DoH-запросов, так что батч в
// 3000 доменов рисковал не уложиться в время жизни одного HTTP-запроса и
// давать 504 — то, с чем вы столкнулись. Плюс внутри resolveMxForDomains
// есть мягкий дедлайн (softDeadlineMs) — даже если что-то резко замедлится,
// функция гарантированно ответит 200, а недообработанные домены получат
// DNS_INCONCLUSIVE вместо того, чтобы обрушить весь запрос.
// =============================================================================
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { resolveMxForDomains, type MxResult } from "../_shared/mxCheck.ts";
import { handleCorsPreflight, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_DOMAINS_PER_REQUEST = 300;
const SOFT_DEADLINE_MS = 40000; // должно быть меньше таймаута платформы
const CACHE_FRESHNESS_DAYS = 90; // старше — перепроверяем на всякий случай

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

  const { domains } = await req.json();
  if (!Array.isArray(domains) || domains.length === 0) {
    return jsonResponse({ error: "domains: непустой массив обязателен" }, { status: 400 });
  }
  if (domains.length > MAX_DOMAINS_PER_REQUEST) {
    return jsonResponse({ error: `максимум ${MAX_DOMAINS_PER_REQUEST} доменов за один запрос` }, { status: 400 });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const uniqueDomains = Array.from(new Set(domains as string[]));
    const out: Record<string, MxResult> = {};

    // --- шаг 1: сверяем с кэшем мёртвых доменов ---
    const { data: cached, error: cacheErr } = await admin.rpc("check_dead_domains", {
      domains: uniqueDomains,
    });
    if (cacheErr) throw new Error(`check_dead_domains: ${cacheErr.message}`);

    const freshCutoff = Date.now() - CACHE_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
    const cachedFresh = new Set<string>();
    for (const row of cached ?? []) {
      const age = new Date(row.last_confirmed_at as string).getTime();
      if (age >= freshCutoff) {
        cachedFresh.add(row.domain as string);
        out[row.domain as string] = {
          category: "DELETE_DOMAIN_NOT_EXISTS",
          detail: "ранее подтверждено как несуществующий домен (кэш, две проверки DNS)",
        };
      }
      // устаревшие записи кэша просто пропускаем — домен уйдёт на обычный
      // резолв ниже и кэш обновится свежим результатом
    }

    // --- шаг 2: то, чего нет в свежем кэше — резолвим через DNS ---
    const toResolve = uniqueDomains.filter((d) => !cachedFresh.has(d));
    if (toResolve.length > 0) {
      const results = await resolveMxForDomains(toResolve, SOFT_DEADLINE_MS);
      for (const [domain, r] of results) out[domain] = r;

      // --- шаг 3: свежеподтверждённые мёртвые домены — сохраняем в кэш ---
      const newlyDead = Array.from(results.entries())
        .filter(([, r]) => r.category === "DELETE_DOMAIN_NOT_EXISTS")
        .map(([domain, r]) => ({ domain, reason: r.detail }));

      if (newlyDead.length > 0) {
        const { error: addErr } = await admin.rpc("add_dead_domains", { entries: newlyDead });
        if (addErr) {
          // не проваливаем весь запрос из-за сбоя кэширования — это просто
          // упущенная оптимизация на будущее, результат для пользователя
          // при этом остаётся корректным
          console.error("add_dead_domains failed:", addErr.message);
        }
      }
    }

    return jsonResponse({ results: out });
  } catch (e) {
    // любая непредвиденная ошибка тоже должна прийти как JSON с понятным
    // текстом, а не как голый 500 без тела — иначе на клиенте не видно причины
    return jsonResponse({ error: `resolve-mx: ${String(e?.message ?? e)}` }, { status: 500 });
  }
});
