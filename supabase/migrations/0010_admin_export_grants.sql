-- Used only by the admin-results Edge Function after it has verified the
-- caller's administrator role.
grant select on table public.suppression_entries to service_role;
grant select on table public.dead_domains to service_role;
