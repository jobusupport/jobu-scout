-- Phase 2 Slice 2: PATCH /api/admin/customers/:orgId/product support function.
--
-- See docs/architecture/PHASE_2_PRODUCT_CAPABILITY_RFC.md §14 for the admin
-- route this backs, and src/admin-product-route.js's header comment for the
-- full reasoning. Summary: the application only talks to Postgres through
-- @supabase/supabase-js (a PostgREST client -- src/supabase.js), where every
-- `.from(...).update()/.insert()` call is its own independent HTTP
-- request/statement with no shared transaction. A product-access change is
-- required to never persist without its admin_audit_log record (and vice
-- versa) -- that guarantee is only available inside a single Postgres
-- function body, which executes as one implicit transaction.
--
-- admin_update_org_product performs both the organizations UPDATE and the
-- admin_audit_log INSERT here, atomically: if either statement fails
-- (including a CHECK-constraint violation from
-- 20260721140000_add_organization_product_fields.sql -- an independent
-- second backstop, see the enabled_products derivation below), the whole
-- call rolls back and neither write persists. No exception handler
-- anywhere in this function catches or absorbs an error -- every failure
-- (the explicit organization_not_found raise, an invalid customer_type, or
-- a CHECK-constraint violation on the UPDATE) propagates all the way out
-- and aborts the whole call, which is what makes the atomicity guarantee
-- hold: there is no code path here where a partial write can commit.
--
-- SELECT ... FOR UPDATE locks the target row for the duration of the call,
-- both to serialize concurrent admin changes to the same organization and
-- to give a race-safe existence check (raises organization_not_found,
-- SQLSTATE P0002, mapped to a 404 by the caller) -- a defense-in-depth
-- backstop for the route's own pre-fetch existence check, covering the
-- window between that check and this call. The old customer_type /
-- primary_product / enabled_products captured here, from the row locked
-- inside this same transaction, are the ONLY source for the audit
-- entry's old_values -- never a value passed in from the JS layer, and
-- never a second, separate read outside this transaction that could
-- observe a different row state.
--
-- enabled_products is derived here, from customer_type alone, via the CASE
-- statement below -- it is not accepted as a parameter at all, so there is
-- no calling convention through which a caller (correct or buggy) could
-- ever pass a mismatched value in. This mirrors, and is independently
-- backstopped by, organizations_products_match_customer_type_check's own
-- CASE in 20260721140000_add_organization_product_fields.sql: if this
-- function's derivation and that constraint's mapping were ever edited out
-- of sync with each other, the UPDATE below would fail its CHECK rather
-- than silently persisting a mismatch.
--
-- ── Independent validation inside this function (not merely assumed) ───────
-- This function does not depend exclusively on src/admin-product-route.js
-- having already validated its inputs -- everything below was checked
-- directly against the actual table definitions
-- (20260620000001_tracked_migration_replay_objects.sql,
-- 20260721140000_add_organization_product_fields.sql), not assumed:
--
-- - customerType/primaryProduct correlation (travel -> primaryProduct must
--   be travel; high_school -> must be high_school; hybrid/internal -> must
--   be travel or high_school): already guaranteed by
--   organizations_primary_matches_type_check (below) plus organizations.
--   primary_product's own `not null` -- both fire unconditionally on the
--   UPDATE in this function, for any caller, so no redundant plpgsql check
--   is added here for this rule specifically:
--     alter table organizations add constraint
--       organizations_primary_matches_type_check check (
--         case customer_type
--           when 'travel'      then primary_product = 'travel'
--           when 'high_school' then primary_product = 'high_school'
--           else primary_product in ('travel', 'high_school')
--         end
--       );
--   (organizations.primary_product is `text not null default 'travel'` --
--   a NULL primary_product is rejected by that NOT NULL constraint
--   directly, independent of the CHECK above, which treats a NULL
--   comparison as non-violating per standard SQL three-valued logic.)
--
-- - reason and admin_user_id/admin_email/admin_role: admin_audit_log has
--   NO not-null constraint on any of these four columns (verified directly
--   against admin_audit_log's own table definition in
--   20260620000001_tracked_migration_replay_objects.sql: `"admin_user_id"
--   uuid,` / `"admin_email" text,` / `"admin_role" text,` / `"reason"
--   text,` -- none carry `not null`, unlike e.g. org_entitlement_overrides.
--   reason, which does). Nothing at the database layer already guarantees
--   any of these, so all four are validated explicitly below, before this
--   function does any read or write.
--
-- action/resource_type are hardcoded here rather than accepted as
-- parameters -- this function only ever records one kind of change, and
-- hardcoding it means the audit action can't be mis-set (accidentally or
-- otherwise) from the calling JS layer. admin_user_id/admin_email/
-- admin_role are always the caller's own authenticated identity (req.user /
-- req.adminRole in src/admin-api.js, populated by requireAuth/
-- requireJobuAdmin before this route ever runs) -- this function has no
-- notion of "acting as" anyone else. reason is trimmed and validated
-- inside this function (see below) independent of
-- src/admin-product-route.js's own identical trim/reject-blank check --
-- the database-trimmed value is what's actually stored.
--
-- SET search_path = '' + fully schema-qualified references to every
-- table this function touches (public.organizations,
-- public.admin_audit_log) -- the standard hardening for a SECURITY DEFINER
-- function (see the Postgres docs' own SECURITY DEFINER writeup, and
-- Supabase's "Function Search Path Mutable" advisor lint). With an empty
-- search_path, pg_catalog remains implicitly searched (Postgres always
-- searches it, regardless of what search_path is set to) but `public` does
-- not -- so an unqualified `organizations` inside this function body could
-- never be hijacked by an attacker-created same-named object in `public`
-- or any other schema, even though this function runs as its
-- (elevated-privilege) owner rather than as its caller. Built-in functions
-- called below (jsonb_build_object, to_jsonb) and built-in types in the
-- signature (uuid, text, text[], jsonb) are pg_catalog objects and need no
-- qualification for this same reason -- pg_catalog is unconditionally
-- searched first, empty search_path or not.
--
-- SECURITY DEFINER + explicit grants below, matching the existing
-- admin_dashboard_metrics()/is_jobu_admin() precedent in
-- 20260620000002_foundational_functions.sql: this project auto-grants
-- EXECUTE to anon/authenticated on newly created functions, independently
-- of the plain Postgres PUBLIC grant -- all three must be revoked
-- explicitly, or an authenticated end user could call this function
-- directly via the PostgREST RPC endpoint with their own JWT, bypassing
-- requireJobuAdmin entirely (which is Express-layer only and never runs
-- for a direct RPC call). Only service_role needs EXECUTE at the
-- application level -- the grant to `postgres` below matches the verified
-- production grant shape for the sibling functions above (their own
-- comments note this was confirmed via information_schema, not assumed);
-- src/admin-api.js's adminClient is the only caller and always connects as
-- service_role, never as postgres.

create or replace function public.admin_update_org_product(
  p_org_id uuid,
  p_customer_type text,
  p_primary_product text,
  p_admin_user_id uuid,
  p_admin_email text,
  p_admin_role text,
  p_reason text,
  p_ip_address text,
  p_user_agent text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_customer_type text;
  v_old_primary_product text;
  v_old_enabled_products text[];
  v_enabled_products text[];
  v_reason text;
begin
  -- ── Actor-identity + reason validation -- independent of the Express
  -- route, checked before this function does any read or write (see the
  -- top-of-file comment for why admin_audit_log itself can't guarantee
  -- any of these). trim() is used for the blank checks below rather than
  -- a bare `= ''` comparison so a whitespace-only value is treated the
  -- same as an empty one.
  if p_admin_user_id is null then
    raise exception 'admin_user_id is required';
  end if;

  if p_admin_email is null or trim(p_admin_email) = '' then
    raise exception 'admin_email is required';
  end if;

  if p_admin_role is null or trim(p_admin_role) = '' then
    raise exception 'admin_role is required';
  end if;

  -- reason is trimmed HERE, inside Postgres, independent of
  -- src/admin-product-route.js's own trim -- v_reason (not p_reason) is
  -- what's actually stored in admin_audit_log.reason below, so the
  -- database-trimmed value is always the one persisted and audited, not
  -- whatever whitespace shape the caller happened to send.
  v_reason := trim(p_reason);
  if p_reason is null or v_reason = '' then
    raise exception 'reason is required';
  end if;

  -- Lock + read the CURRENT row inside this transaction. This is the only
  -- source for old_values below, and the only existence check this
  -- function trusts -- both the audit trail and the not-found signal come
  -- from this one read, never from a value handed in by the caller.
  select customer_type, primary_product, enabled_products
    into v_old_customer_type, v_old_primary_product, v_old_enabled_products
    from public.organizations
    where id = p_org_id
    for update;

  if not found then
    raise exception 'organization_not_found: %', p_org_id using errcode = 'P0002';
  end if;

  -- enabled_products is derived here, inside Postgres, from customer_type
  -- alone -- see the top-of-file comment. An unrecognized customer_type
  -- (should be unreachable: src/admin-product-route.js validates this
  -- before ever calling this function, and organizations_customer_type_check
  -- would also reject it on the UPDATE below) fails closed via the ELSE
  -- branch rather than falling through to some default product set.
  case p_customer_type
    when 'travel'      then v_enabled_products := array['travel'];
    when 'high_school' then v_enabled_products := array['high_school'];
    when 'hybrid'      then v_enabled_products := array['travel', 'high_school'];
    when 'internal'    then v_enabled_products := array['travel', 'high_school'];
    else
      raise exception 'invalid customer_type: %', p_customer_type;
  end case;

  update public.organizations
     set customer_type = p_customer_type,
         primary_product = p_primary_product,
         enabled_products = v_enabled_products
   where id = p_org_id;

  insert into public.admin_audit_log (
    admin_user_id, admin_email, admin_role, org_id, action,
    resource_type, resource_id, old_values, new_values, reason,
    ip_address, user_agent
  ) values (
    p_admin_user_id, p_admin_email, p_admin_role, p_org_id,
    'product_access_changed', 'organization', p_org_id::text,
    jsonb_build_object(
      'customerType', v_old_customer_type,
      'primaryProduct', v_old_primary_product,
      'enabledProducts', to_jsonb(v_old_enabled_products)
    ),
    jsonb_build_object(
      'customerType', p_customer_type,
      'primaryProduct', p_primary_product,
      'enabledProducts', to_jsonb(v_enabled_products)
    ),
    v_reason, p_ip_address, p_user_agent
  );

  return jsonb_build_object(
    'customerType', p_customer_type,
    'primaryProduct', p_primary_product,
    'enabledProducts', to_jsonb(v_enabled_products)
  );
end;
$function$;

revoke execute on function public.admin_update_org_product(uuid, text, text, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_update_org_product(uuid, text, text, uuid, text, text, text, text, text) to postgres, service_role;
