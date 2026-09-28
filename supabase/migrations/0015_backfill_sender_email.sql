-- =============================================================================
-- Дозаполнение sender_email у старых записей.
--
-- Записи, добавленные до миграции 0013 (глобальные bounce-факты), не имеют
-- sender_email (NULL). Когда такой адрес снова встречается в новом импорте,
-- где отправитель уже указан (поле обязательное), запись обновляется:
-- если sender_email пустой — заполняется отправителем текущего импорта.
--
-- Если sender_email у записи уже есть, он НЕ затирается (остаётся тот, кто
-- сообщил о проблеме первым): раньше при каждом повторе он перезаписывался
-- последним импортом, и информация о первом источнике терялась.
--
-- Остальная логика (счётчик, last_seen, защита is_trap) без изменений
-- относительно 0013.
-- =============================================================================

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
    sender_email = coalesce(suppression_entries.sender_email, excluded.sender_email),
    reason = case when suppression_entries.is_trap then suppression_entries.reason else excluded.reason end,
    category = case when suppression_entries.is_trap then suppression_entries.category else excluded.category end,
    action = case when suppression_entries.is_trap then suppression_entries.action else excluded.action end,
    is_trap = suppression_entries.is_trap or excluded.is_trap;
end;
$$;
