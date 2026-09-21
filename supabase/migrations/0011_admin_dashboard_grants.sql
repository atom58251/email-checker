-- Read access is used only by the admin-results Edge Function after it checks
-- the caller's role.  Browser clients still rely on the existing RLS policy.
grant select on table public.admin_audit_log to service_role;
