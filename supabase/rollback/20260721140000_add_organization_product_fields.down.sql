-- Down migration for 20260721140000_add_organization_product_fields.sql.
--
-- SAFE ONLY BEFORE ANY ORGANIZATION HAS BEEN ASSIGNED SOMETHING OTHER THAN
-- THE DEFAULT (customer_type='travel', enabled_products=['travel']) BY AN
-- ADMIN ACTION. Phase 2 Slice 1 (this migration's companion code change)
-- ships no admin write route, so at the point Slice 1 alone is live, this
-- file is lossless -- every row is identical to what it would be if these
-- columns had never existed.
--
-- Once a future Slice 2 (admin write route, not part of this migration's
-- companion change) ships and any real organization is assigned
-- high_school/hybrid/internal, running this file destroys the only live
-- record of that assignment. At that point, do not run this file blindly --
-- see supabase/README.md for the post-adoption procedure (export affected
-- rows first, as a deliberate decommission decision, not an incident
-- response).

alter table organizations
  drop constraint if exists organizations_primary_matches_type_check,
  drop constraint if exists organizations_products_match_customer_type_check,
  drop constraint if exists organizations_primary_in_enabled_check,
  drop constraint if exists organizations_enabled_products_nonempty_check,
  drop constraint if exists organizations_enabled_products_subset_check,
  drop constraint if exists organizations_primary_product_check,
  drop constraint if exists organizations_customer_type_check,
  drop column if exists onboarding_completed_at,
  drop column if exists enabled_products,
  drop column if exists primary_product,
  drop column if exists customer_type;
