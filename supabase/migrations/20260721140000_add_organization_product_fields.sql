-- Phase 2 Slice 1: organization product-capability foundation.
--
-- Additive only. Every existing organization row becomes valid the instant
-- this runs, because every default below is a constant, not derived from
-- existing data.
--
-- customer_type describes ORGANIZATION IDENTITY -- what kind of baseball
-- program this organization is (travel / high_school / hybrid / internal).
-- It is not itself a license grant.
--
-- enabled_products is the LICENSING field -- what this organization is
-- actually authorized to use. As of this migration it is fully determined
-- by customer_type (see organizations_products_match_customer_type_check
-- below), because there are currently only two products and every
-- customer_type maps to exactly one valid product set. That coupling is a
-- deliberate v1 simplification, not a permanent fusion of the two concepts:
-- enabled_products remains its own stored column, not a value computed from
-- customer_type at read time, specifically so a future third product (or
-- partial/trial licensing within one customer_type) doesn't require
-- reshaping every place that reads it.
--
-- onboarding_completed_at is deliberately left NULL for every organization,
-- including ones that pre-date this migration. No backfill is performed.
-- There is no onboarding-selection flow yet (Phase 3/4, out of scope) for
-- this column to gate, so its value has no observable effect today.

alter table organizations
  add column if not exists customer_type text not null default 'travel',
  add column if not exists primary_product text not null default 'travel',
  add column if not exists enabled_products text[] not null default array['travel']::text[],
  add column if not exists onboarding_completed_at timestamptz;

alter table organizations
  add constraint organizations_customer_type_check
    check (customer_type in ('travel', 'high_school', 'hybrid', 'internal')),
  add constraint organizations_primary_product_check
    check (primary_product in ('travel', 'high_school')),
  add constraint organizations_enabled_products_subset_check
    check (enabled_products <@ array['travel', 'high_school']::text[]),
  add constraint organizations_enabled_products_nonempty_check
    check (cardinality(enabled_products) > 0),
  add constraint organizations_primary_in_enabled_check
    check (primary_product = any(enabled_products));

-- Ties enabled_products/primary_product to customer_type so a row can never
-- carry a label that disagrees with its actual product access (e.g.
-- customer_type='high_school' with enabled_products=['travel']). Uses
-- containment (@>) + cardinality rather than array equality (=), because
-- array['travel','high_school'] = array['high_school','travel'] is FALSE in
-- Postgres -- an insertion-order footgun equality would have introduced.
alter table organizations
  add constraint organizations_products_match_customer_type_check check (
    case customer_type
      when 'travel'      then enabled_products = array['travel']::text[]
      when 'high_school'  then enabled_products = array['high_school']::text[]
      when 'hybrid'        then enabled_products @> array['travel','high_school']::text[]
                              and cardinality(enabled_products) = 2
      when 'internal'      then enabled_products @> array['travel','high_school']::text[]
                              and cardinality(enabled_products) = 2
      else false
    end
  ),
  add constraint organizations_primary_matches_type_check check (
    case customer_type
      when 'travel'      then primary_product = 'travel'
      when 'high_school'  then primary_product = 'high_school'
      else primary_product in ('travel', 'high_school')  -- hybrid/internal: real choice
    end
  );

comment on column organizations.customer_type is
  'Organization identity: travel | high_school | hybrid | internal. Describes what kind of baseball program this is -- it is NOT a license grant. Set by admin action only, never inferred from team/name data. See src/product-capabilities.js.';
comment on column organizations.primary_product is
  'Which product this org lands on by default. For travel/high_school orgs this always equals customer_type (see organizations_primary_matches_type_check). For hybrid/internal orgs it is a real, admin-set choice between the two.';
comment on column organizations.enabled_products is
  'Licensing/entitlement field: which products this org may access. Fully determined by customer_type as of this migration (see organizations_products_match_customer_type_check) -- stored as its own column for forward-compatibility with a future 3rd product, not because it is independently settable today.';
comment on column organizations.onboarding_completed_at is
  'NULL for every organization as of this migration, including pre-existing ones -- no backfill was performed. Reserved for a future onboarding-selection flow (Phase 3/4); has no observable effect until that flow exists.';
