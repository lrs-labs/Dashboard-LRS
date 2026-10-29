-- The event trigger remains installed and continues enabling RLS for new
-- public tables. Its SECURITY DEFINER function does not need to be callable
-- through the Supabase Data API by browser roles.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;
