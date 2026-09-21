-- =============================================================================
-- Батч-upsert для suppression_entries: если хэш уже есть — обновляем
-- last_seen/reason/category/action и увеличиваем bounce_count (аналог
-- upsert_suppression() из Python-версии, где повторный bounce того же
-- адреса не создаёт дубль, а увеличивает счётчик).
-- =============================================================================
create or replace function public.upsert_suppression_batch(entries jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.suppression_entries
    (email_hash, domain, reason, category, action, first_seen, last_seen, bounce_count, added_by)
  select
    e->>'email_hash',
    e->>'domain',
    e->>'reason',
    e->>'category',
    e->>'action',
    (e->>'last_seen')::date,
    (e->>'last_seen')::date,
    1,
    (e->>'added_by')::uuid
  from jsonb_array_elements(entries) as e
  on conflict (email_hash) do update set
    last_seen = excluded.last_seen,
    reason = excluded.reason,
    category = excluded.category,
    action = excluded.action,
    bounce_count = suppression_entries.bounce_count + 1;
end;
$$;

-- Вызывается только из Edge Function через service_role — не выставляем
-- эту функцию для authenticated/anon явно (execute privilege по умолчанию
-- у security definer функций Supabase обычно даёт всем ролям; на всякий
-- случай сознательно ограничиваем):
revoke execute on function public.upsert_suppression_batch(jsonb) from public;
revoke execute on function public.upsert_suppression_batch(jsonb) from authenticated;
revoke execute on function public.upsert_suppression_batch(jsonb) from anon;
grant execute on function public.upsert_suppression_batch(jsonb) to service_role;
