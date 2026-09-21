-- =============================================================================
-- Проблема: check-suppression делал admin.from('suppression_entries')
--   .select('email_hash').in('email_hash', hashes) — а .in() в PostgREST
--   собирает GET-запрос, вставляя ВСЕ значения прямо в URL. На батче
--   в 2000 SHA-256 хэшей (по 64 символа) URL получается ~130 000+
--   символов — это либо не парсится URL-конструктором в рантайме
--   (TypeError: Invalid URL), либо упирается в лимит заголовков у
--   прокси/шлюза (Kong) ещё до того, как дойдёт до Postgres.
--
-- Решение: RPC-вызов. В PostgREST любой вызов hranimoy функции идёт
-- ЧЕРЕЗ POST с телом запроса, а не через query string — значит объём
-- передаваемых хэшей больше не ограничен длиной URL вообще.
-- =============================================================================
create or replace function public.check_suppression_hashes(hashes text[])
returns table (email_hash text)
language sql
security definer
set search_path = public
stable
as $$
  select se.email_hash
  from public.suppression_entries se
  where se.email_hash = any(hashes);
$$;

revoke execute on function public.check_suppression_hashes(text[]) from public;
revoke execute on function public.check_suppression_hashes(text[]) from anon;
-- authenticated тоже не нужен напрямую — вызывается только из Edge Function
-- под service_role, но т.к. Edge Function сама аутентифицирует пользователя
-- перед вызовом (см. index.ts), можно смело ограничить только service_role:
revoke execute on function public.check_suppression_hashes(text[]) from authenticated;
grant execute on function public.check_suppression_hashes(text[]) to service_role;
