-- =============================================================================
-- Email Checker Service — начальная схема (Supabase / Postgres)
--
-- ПРИНЦИПЫ БЕЗОПАСНОСТИ, заложенные в схему (см. README.md, раздел "Security"):
--   1. Suppression-list хранит SHA-256 хэш email, а не сам email в открытом
--      виде — это данные о чужих неудачных доставках, максимально
--      чувствительные, и они не нужны пользователям в открытом виде вообще,
--      только для точного сравнения "совпадает / не совпадает".
--   2. Каждый пользователь видит через RLS ТОЛЬКО свои проверки и результаты.
--   3. Roles: admin (может пополнять suppression_list и видеть агрегаты),
--      authenticated (обычный пользователь, видит только своё).
--   4. Загруженные файлы и результаты — в Storage с собственными policies
--      (см. миграцию 0002_storage.sql), не в этой таблице.
--   5. Ничего не хранится "вечно по умолчанию" — есть колонка expires_at
--      для автоочистки (см. функцию purge_expired ниже + pg_cron).
-- =============================================================================

-- --- РОЛИ -------------------------------------------------------------------
-- Роль admin выдаётся вручную конкретным пользователям через таблицу profiles.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: пользователь видит только свой профиль"
  on public.profiles for select
  using (auth.uid() = id);

-- профиль создаётся автоматически при регистрации через триггер
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role) values (new.id, 'user');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- удобная функция проверки "текущий пользователь — admin?"
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;


-- --- SUPPRESSION LIST (хэши, не сами адреса) --------------------------------
create table if not exists public.suppression_entries (
  id bigint generated always as identity primary key,
  email_hash text not null unique,        -- sha256(lower(trim(email)))
  domain text not null,                    -- домен в открытом виде — не PII сам по себе,
                                            -- нужен для агрегатной статистики/отчётов
  reason text,
  category text,
  action text,                             -- 'DELETE from list' / 'RETRY in 2-4 weeks'
  first_seen date,
  last_seen date,
  bounce_count int not null default 1,
  added_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_suppression_email_hash on public.suppression_entries (email_hash);
create index if not exists idx_suppression_domain on public.suppression_entries (domain);

alter table public.suppression_entries enable row level security;

-- ВАЖНО: обычные пользователи НЕ имеют прямого доступа к этой таблице —
-- ни на чтение, ни на запись. Сверка происходит только внутри Edge Function
-- с service_role key (обходит RLS полностью, работает на сервере, ключ
-- никогда не попадает на фронтенд). Так что здесь мы явно НЕ создаём select
-- policy для authenticated — по умолчанию RLS блокирует всё, что не разрешено.

create policy "suppression: admin может добавлять"
  on public.suppression_entries for insert
  with check (public.is_admin());

create policy "suppression: admin может читать агрегаты"
  on public.suppression_entries for select
  using (public.is_admin());

create policy "suppression: admin может обновлять"
  on public.suppression_entries for update
  using (public.is_admin());


-- --- ПРОВЕРКИ (метаданные загрузки, не сами файлы) --------------------------
create table if not exists public.checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  original_filename text,
  status text not null default 'pending' check (status in ('pending','processing','done','error')),
  total_rows int,
  stats jsonb,                              -- {"OK": 162279, "DELETE_NO_MX": 702, ...}
  error_message text,
  upload_storage_path text,                 -- путь в bucket 'uploads', удаляется после обработки
  result_storage_path text,                 -- путь в bucket 'results'
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days')
);

create index if not exists idx_checks_user on public.checks (user_id);
create index if not exists idx_checks_expires on public.checks (expires_at);

alter table public.checks enable row level security;

create policy "checks: пользователь видит только свои"
  on public.checks for select
  using (auth.uid() = user_id);

create policy "checks: пользователь создаёт только свои"
  on public.checks for insert
  with check (auth.uid() = user_id);

create policy "checks: пользователь может удалить свою проверку"
  on public.checks for delete
  using (auth.uid() = user_id);

-- обновлять статус/результат имеет право только сервер (service_role,
-- используется Edge Function) — нет отдельной update policy для user,
-- значит RLS запрещает пользователю менять статус/результат самому.


-- --- ЖУРНАЛ ДЕЙСТВИЙ АДМИНА (аудит) -----------------------------------------
create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_id uuid references auth.users(id),
  action text not null,                     -- 'import_bounces', 'manual_add', ...
  details jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit_log enable row level security;

create policy "audit: admin может читать журнал"
  on public.admin_audit_log for select
  using (public.is_admin());


-- --- АВТООЧИСТКА ПРОСРОЧЕННЫХ ДАННЫХ (data retention) -----------------------
-- Реализация принципа "не хранить дольше необходимого". Саму очистку
-- storage-объектов делает Edge Function purge-expired (см. functions/),
-- эта функция только чистит строки метаданных в БД.
create or replace function public.purge_expired_checks()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.checks where expires_at < now();
end;
$$;

-- Подключить через pg_cron (Supabase Dashboard -> Database -> Cron Jobs):
--   select cron.schedule('purge-expired-checks', '0 3 * * *',
--     $$ select public.purge_expired_checks(); select net.http_post(
--          url:='https://<project>.functions.supabase.co/purge-expired',
--          headers:='{"Authorization": "Bearer <service_role_key>"}'::jsonb); $$);
