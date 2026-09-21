-- =============================================================================
-- Добавляет флаг is_trap — постоянная метка "это spam trap", которая не
-- может быть снята более мягкой категорией при повторном импорте
-- (см. upsert_suppression_batch ниже). Подробности — в комментариях
-- Python-версии, CATEGORY_RULES в check_emails.py: та же логика.
-- =============================================================================
alter table public.suppression_entries
  add column if not exists is_trap boolean not null default false;

create index if not exists idx_suppression_is_trap
  on public.suppression_entries (is_trap) where is_trap = true;

-- Переопределяем upsert-функцию: если запись уже помечена is_trap=true,
-- повторный импорт с более мягкой категорией НЕ должен её перезаписывать
-- (кроме last_seen/bounce_count — это можно обновлять всегда).
create or replace function public.upsert_suppression_batch(entries jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.suppression_entries
    (email_hash, domain, reason, category, action, is_trap, first_seen, last_seen, bounce_count, added_by)
  select
    e->>'email_hash',
    e->>'domain',
    e->>'reason',
    e->>'category',
    e->>'action',
    coalesce((e->>'is_trap')::boolean, false),
    (e->>'last_seen')::date,
    (e->>'last_seen')::date,
    1,
    (e->>'added_by')::uuid
  from jsonb_array_elements(entries) as e
  on conflict (email_hash) do update set
    last_seen = excluded.last_seen,
    bounce_count = suppression_entries.bounce_count + 1,
    -- reason/category/action/is_trap обновляются ТОЛЬКО если запись ещё
    -- не была помечена как trap — иначе более мягкая категория из
    -- нового отчёта могла бы "снять" опасный статус с адреса
    reason = case when suppression_entries.is_trap then suppression_entries.reason else excluded.reason end,
    category = case when suppression_entries.is_trap then suppression_entries.category else excluded.category end,
    action = case when suppression_entries.is_trap then suppression_entries.action else excluded.action end,
    is_trap = suppression_entries.is_trap or excluded.is_trap;
end;
$$;
