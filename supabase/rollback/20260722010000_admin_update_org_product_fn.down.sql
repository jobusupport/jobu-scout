-- Down migration for 20260722010000_admin_update_org_product_fn.sql.
-- See supabase/README.md's "Down migrations" section -- reference file for
-- the pre-adoption window only, not a general-purpose rollback tool.
--
-- Unlike the organizations columns from 20260721140000 (see §9 of the RFC
-- for that migration's adoption-boundary rollback distinction), dropping
-- this function is safe at any point, before or after adoption: it removes
-- only the ability to make further product-access changes through this
-- path. Any organizations/admin_audit_log rows it already wrote stay
-- exactly as they are -- this function never deletes or reverts data, it
-- only stops being callable.

drop function if exists public.admin_update_org_product(uuid, text, text, uuid, text, text, text, text, text);
