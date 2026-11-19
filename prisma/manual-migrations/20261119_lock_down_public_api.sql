-- APPLIED to production (guestbook, zeebymukudjbqiziwajb) on 2026-11-19 at Ruslan's request.
-- P0 fix: guestbook_* views ran as their owner (postgres), bypassing deny-all RLS on the
-- base tables, and anon/authenticated held full DML on every public table. The publishable
-- key could read 42,985 people (email, phone, notes, raw Luma) and 43,443 email addresses.
-- The app connects as postgres via Prisma and does not use the Supabase REST API,
-- so API roles need no access to public.
--
-- Rollback (re-opens the exposure; only if something unexpected depended on it):
--   GRANT ALL ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public TO anon, authenticated;
--   ALTER VIEW <view> RESET (security_invoker);

BEGIN;
-- 1. Views run with the caller's rights, so base-table RLS (deny-all) applies to API roles.
ALTER VIEW public.guestbook_active_people                SET (security_invoker = true);
ALTER VIEW public.guestbook_inactive_people              SET (security_invoker = true);
ALTER VIEW public.guestbook_human_inactive_people        SET (security_invoker = true);
ALTER VIEW public.guestbook_person_email_addresses       SET (security_invoker = true);
ALTER VIEW public.guestbook_human_person_email_addresses SET (security_invoker = true);
-- 2. The app connects as postgres via Prisma; the public API roles need nothing in public.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
-- 3. Stop future tables/views/functions created by postgres from re-granting them.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
COMMIT;
