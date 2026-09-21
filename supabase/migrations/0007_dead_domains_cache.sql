-- =============================================================================
-- dead_domains — растущий кэш ДОМЕНОВ (не email!), для которых NXDOMAIN был
-- подтверждён двумя независимыми DNS-резолверами при проверке через
-- resolve-mx. В отличие от suppression_entries (которая пополняется только
-- вручную админом из реальных bounce-отчётов и хранит per-email данные),
-- эта таблица растёт АВТОМАТИЧЕСКИ из обычных проверок любого пользователя
-- и работает на уровне домена — если домен не существует, это верно для
-- абсолютно любого адреса на нём, а не только для того, что встретился в
-- чьём-то конкретном файле.
--
-- Приватность: тут нет email-адресов вообще, только доменные имена и
-- технические детали DNS-ответа — это не персональные данные.
--
-- Эффект: то, что один пользователь один раз подтвердил через DNS, больше
-- никогда не потребует повторного сетевого запроса — ни для него самого
-- при повторном прогоне, ни для любого другого пользователя сервиса.
-- =============================================================================
create table if not exists public.dead_domains (
  domain text primary key,
  reason text,
  first_confirmed_at timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  confirm_count int not null default 1
);

alter table public.dead_domains enable row level security;
-- Специально НЕ даём select/insert обычным пользователям и даже admin —
-- эта таблица полностью служебная, работает только изнутри Edge Function
-- через service_role. RLS включён с нулём policy = по умолчанию заблокировано
-- для всех, кроме service_role (он всегда обходит RLS).

-- Пакетная проверка: какие из переданных доменов уже в кэше как мёртвые.
-- Возвращает last_confirmed_at — Edge Function сама решает, доверять ли
-- кэшу (см. FRESHNESS_DAYS в resolve-mx), чтобы не полагаться вечно на
-- очень старую запись (редкий, но возможный случай: домен освободился и
-- был выкуплен заново под другую почту).
create or replace function public.check_dead_domains(domains text[])
returns table (domain text, last_confirmed_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query select d.domain, d.last_confirmed_at from public.dead_domains d where d.domain = any(domains);
end;
$$;

-- Пакетное добавление свежеподтверждённых мёртвых доменов (upsert).
create or replace function public.add_dead_domains(entries jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.dead_domains (domain, reason)
  select e->>'domain', e->>'reason'
  from jsonb_array_elements(entries) as e
  on conflict (domain) do update set
    last_confirmed_at = now(),
    confirm_count = dead_domains.confirm_count + 1,
    reason = excluded.reason;
end;
$$;

revoke execute on function public.check_dead_domains(text[]) from public, anon, authenticated;
revoke execute on function public.add_dead_domains(jsonb) from public, anon, authenticated;
grant execute on function public.check_dead_domains(text[]) to service_role;
grant execute on function public.add_dead_domains(jsonb) to service_role;
