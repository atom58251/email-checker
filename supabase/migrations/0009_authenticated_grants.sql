-- RLS policies define which rows a user may access, but PostgreSQL grants are
-- still required before those policies can be evaluated by PostgREST.
grant select, insert, update, delete on table public.checks to authenticated;
grant select, insert, update, delete on table public.checks to service_role;

-- The client reads only its own profile; its RLS policy remains in force.
grant select on table public.profiles to authenticated;
grant select on table public.profiles to service_role;
