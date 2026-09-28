-- =============================================================================
-- Спам-жалобы (ok_fbl) и попадание в папку "Спам" (ok_spam_folder) — глобальные.
--
-- По договорённости по домену отправителя делится только ОТПИСКА. Первая версия
-- импорта привязывала к домену все записи бакета COMPLAINT_UNSUBSCRIBE, включая
-- жалобы. Приводим уже загруженные записи к договорённости: sender_domain = ''.
-- =============================================================================

-- 1) Если у адреса уже есть глобальная запись — доменную жалобу удаляем (адрес и
--    так блокируется глобально, а строка с тем же (email_hash, '') не поместится).
delete from public.suppression_entries d
where d.sender_domain <> ''
  and (d.category ilike '%ok_fbl%' or d.category ilike '%ok_spam_folder%')
  and exists (
    select 1 from public.suppression_entries g
    where g.email_hash = d.email_hash and g.sender_domain = ''
  );

-- 2) Если жалоба на один адрес была привязана к нескольким доменам — оставляем одну.
delete from public.suppression_entries d
using public.suppression_entries k
where d.sender_domain <> '' and k.sender_domain <> ''
  and (d.category ilike '%ok_fbl%' or d.category ilike '%ok_spam_folder%')
  and (k.category ilike '%ok_fbl%' or k.category ilike '%ok_spam_folder%')
  and d.email_hash = k.email_hash
  and d.id > k.id;

-- 3) Остальные делаем глобальными.
update public.suppression_entries
set sender_domain = ''
where sender_domain <> ''
  and (category ilike '%ok_fbl%' or category ilike '%ok_spam_folder%');
