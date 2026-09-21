-- =============================================================================
-- Storage buckets и policies.
--
-- uploads  — сырые файлы пользователей (private). Живут недолго: Edge Function
--            check-emails читает файл, обрабатывает и сразу удаляет исходник
--            (принцип минимизации данных — сырой файл с чужими email не должен
--            лежать дольше, чем нужно для обработки).
-- results  — обработанные результаты (private), доступны только своему
--            владельцу, автоочистка через expires_at в таблице checks.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('results', 'results', false)
on conflict (id) do nothing;

-- Файлы кладутся по пути "<user_id>/<check_id>.xlsx" — это позволяет
-- построить policy строго по владельцу через (storage.foldername(name))[1].

create policy "uploads: пользователь загружает только в свою папку"
  on storage.objects for insert
  with check (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "uploads: пользователь читает только свою папку"
  on storage.objects for select
  using (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "uploads: пользователь удаляет только свою папку"
  on storage.objects for delete
  using (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "results: пользователь читает только свою папку"
  on storage.objects for select
  using (
    bucket_id = 'results'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "results: пользователь удаляет только свою папку"
  on storage.objects for delete
  using (
    bucket_id = 'results'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Запись в 'results' делает только Edge Function через service_role key
-- (обходит RLS) — у пользователя нет insert-policy на этот bucket, и это
-- осознанно: результат должен формироваться только сервером, а не
-- подменяться клиентом.
