-- =============================================================================
-- Список известных доменов отправителей — для выпадающего списка на странице
-- "Проверка списков" (поле "Для какого домена проверяем"). Сами домены не
-- чувствительны (это собственные отправляющие домены организации, не email
-- получателей), поэтому в отличие от check_suppression_hashes/upsert_*
-- эта функция безопасна для прямого вызова любым авторизованным
-- пользователем — отдельная Edge Function не нужна.
-- =============================================================================

create or replace function public.list_sender_domains()
returns table (sender_domain text)
language sql
security definer
set search_path = public
stable
as $$
  select distinct se.sender_domain
  from public.suppression_entries se
  where se.sender_domain <> ''
  order by se.sender_domain;
$$;

revoke execute on function public.list_sender_domains() from public;
revoke execute on function public.list_sender_domains() from anon;
grant execute on function public.list_sender_domains() to authenticated;
