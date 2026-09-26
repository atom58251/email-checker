-- =============================================================================
-- Разделение блокировок по "виновности" (обсуждение с пользователем в чате):
-- bounce-факт про сам адрес (не существует, переполнен и т.п.) и спам-жалоба
-- (ok_fbl) блокируют ГЛОБАЛЬНО, как и раньше — это факт про адрес или про
-- репутацию отправителя в целом (спам-жалоба бьёт по репутации домена у
-- почтового провайдера получателя независимо от того, какая именно рассылка
-- её вызвала). А вот ОТПИСКА (COMPLAINT_UNSUBSCRIBE, статус ok_unsubscribed)
-- — это согласие относится к КОНКРЕТНОМУ отправителю: у админа 10 разных
-- проектов с разными доменами, и отписка от рассылки course1.ru не должна
-- блокировать отправку с домена course2.ru.
--
-- sender_domain = '' (пустая строка, НЕ null) — сентинел "глобальная
-- запись", используется для всех bounce/spam/trap записей. NULL здесь не
-- подошёл бы: в уникальном constraint два NULL никогда не считаются
-- дубликатами, а два '' — считаются, что нам и нужно для конфликта upsert.
-- Непустое значение sender_domain — только у записей COMPLAINT_UNSUBSCRIBE.
-- =============================================================================

alter table public.suppression_entries
  add column if not exists sender_email text,
  add column if not exists sender_domain text not null default '';

-- Старый unique был просто на email_hash — теперь один и тот же адрес может
-- легитимно иметь НЕСКОЛЬКО строк одновременно: одну глобальную
-- (sender_domain = '') и по одной на каждый домен, от рассылок которого
-- отписался.
alter table public.suppression_entries
  drop constraint if exists suppression_entries_email_hash_key;

alter table public.suppression_entries
  add constraint suppression_entries_hash_domain_key unique (email_hash, sender_domain);

create index if not exists idx_suppression_sender_domain
  on public.suppression_entries (sender_domain) where sender_domain <> '';

-- ---------------------------------------------------------------------------
-- upsert_suppression_batch: конфликт теперь по (email_hash, sender_domain),
-- а не по email_hash — иначе запись об отписке от домена B перезаписала бы
-- глобальную bounce-запись того же адреса (и наоборот).
-- ---------------------------------------------------------------------------
create or replace function public.upsert_suppression_batch(entries jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.suppression_entries
    (email_hash, domain, reason, category, action, is_trap, sender_email, sender_domain,
     first_seen, last_seen, bounce_count, added_by)
  select
    e->>'email_hash',
    e->>'domain',
    e->>'reason',
    e->>'category',
    e->>'action',
    coalesce((e->>'is_trap')::boolean, false),
    e->>'sender_email',
    coalesce(e->>'sender_domain', ''),
    (e->>'last_seen')::date,
    (e->>'last_seen')::date,
    1,
    (e->>'added_by')::uuid
  from jsonb_array_elements(entries) as e
  on conflict (email_hash, sender_domain) do update set
    last_seen = excluded.last_seen,
    bounce_count = suppression_entries.bounce_count + 1,
    sender_email = excluded.sender_email,
    -- reason/category/action/is_trap обновляются ТОЛЬКО если запись ещё не
    -- была помечена как trap — иначе более мягкая категория из нового
    -- отчёта могла бы "снять" опасный статус с адреса (как и раньше).
    reason = case when suppression_entries.is_trap then suppression_entries.reason else excluded.reason end,
    category = case when suppression_entries.is_trap then suppression_entries.category else excluded.category end,
    action = case when suppression_entries.is_trap then suppression_entries.action else excluded.action end,
    is_trap = suppression_entries.is_trap or excluded.is_trap;
end;
$$;

-- ---------------------------------------------------------------------------
-- check_suppression_hashes: добавлен параметр p_sender_domain. Глобальные
-- записи (sender_domain = '') блокируют всегда, как и раньше (с той же
-- логикой retry/is_trap/28-дневного окна из 0008). Записи с непустым
-- sender_domain (отписки) блокируют ТОЛЬКО если проверка идёт для ТОГО ЖЕ
-- домена — если p_sender_domain не передан, отписки вообще не учитываются
-- (безопаснее промолчать, чем случайно заблокировать по чужому домену).
-- Меняем сигнатуру функции — старую версию с одним параметром удаляем
-- явно, чтобы не остались две перегруженные функции с одним и тем же
-- именем.
-- ---------------------------------------------------------------------------
drop function if exists public.check_suppression_hashes(text[]);

create or replace function public.check_suppression_hashes(hashes text[], p_sender_domain text default '')
returns table (email_hash text)
language sql
security definer
set search_path = public
stable
as $$
  select se.email_hash
  from public.suppression_entries se
  where se.email_hash = any(hashes)
    and (
      se.sender_domain = ''
      or se.sender_domain = coalesce(p_sender_domain, '')
    )
    and (
      se.is_trap
      or se.action is null
      or se.action not ilike '%retry%'
      or se.last_seen > (current_date - interval '28 days')
    );
$$;

revoke execute on function public.check_suppression_hashes(text[], text) from public;
revoke execute on function public.check_suppression_hashes(text[], text) from anon;
revoke execute on function public.check_suppression_hashes(text[], text) from authenticated;
grant execute on function public.check_suppression_hashes(text[], text) to service_role;
