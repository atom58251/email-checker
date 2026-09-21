-- =============================================================================
-- Проблема: check_suppression_hashes возвращал ЛЮБОЕ совпадение по хэшу,
-- не глядя на action. Из-за этого mailbox_full (action='retry_later') блокировал
-- адрес НАВСЕГДА — хотя переполненный ящик это временная ситуация: человек
-- почистит почту, и адрес снова станет рабочим. Мы это обсуждали как
-- намерение ("не финальный вердикт"), но сама сверка эту разницу не
-- учитывала.
--
-- Исправление: RETRY-записи (action содержит 'retry') автоматически
-- перестают считаться активной блокировкой через RETRY_WINDOW_DAYS дней
-- после last_seen. Постоянные записи (action='delete') и все is_trap
-- продолжают блокировать всегда, независимо от возраста.
--
-- Важно: сама строка в suppression_entries НЕ удаляется по истечении
-- окна — это сохраняет историю/аудит и bounce_count. Она просто перестаёт
-- возвращаться из check_suppression_hashes как "активная" причина
-- исключить адрес из рассылки. Если тот же адрес снова забаунсится с
-- mailbox_full — last_seen обновится и 28-дневное окно отсчитается заново
-- (см. upsert_suppression_batch).
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
  where se.email_hash = any(hashes)
    and (
      se.is_trap
      or se.action is null
      or se.action not ilike '%retry%'
      or se.last_seen > (current_date - interval '28 days')
    );
$$;
