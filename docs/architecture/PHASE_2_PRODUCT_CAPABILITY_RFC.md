# Phase 2 RFC: Product Capability Foundation

**Status:** Reviewed and revised — awaiting approval, not implemented
**Branch context:** written against `frontend/dashboard-debundle` @ `f33ef7dbc3d5f1825a33b1588636d89110ae96cb` (Phase 1.5 complete)
**Authoritative inputs:** `JOBU_SCOUT_V2_ARCHITECTURE_BLUEPRINT.md`, the Phase 1 repository audit
**Scope:** shared product-capability foundation only — no dashboard changes, no product screens, no pricing changes

**Revision note (self-review pass):** this document was critically reviewed against itself, the Blueprint, the Phase 1 audit, and the live repository. Nine concrete changes were made as a result — the schema now enforces the customer-type/product correlation at the database layer instead of by convention, the precedence rules are now an explicit fail-closed algorithm, the API contract separates billing/override state from product/feature state, the middleware scope was cut from three to one, the admin route no longer accepts a client-supplied `enabledProducts` array, rollback guidance now distinguishes pre-adoption from post-adoption safety, and the implementation-slice plan was consolidated from five slices to two. Each change is marked inline with **`[Revised: ...]`** at its location, and summarized in the accompanying review.

---

## 1. Executive summary

This RFC specifies the smallest additive, reversible slice that gives every organization an explicit, server-enforced product identity (Travel / High School / Hybrid / Internal) without changing anything a current customer sees or does today.

The slice is four things: four new columns on `organizations` (all defaulted so every existing row is immediately valid), one new module (`src/product-capabilities.js`) that becomes the single place capability logic is computed, one read endpoint (`GET /api/product/capabilities`) that nothing in the current dashboard calls, and one new admin route that reuses the existing admin-authorization and audit-logging machinery verbatim. Three middleware functions (`requireProductAccess`, `requireFeature`, `requireEntitlement`) are specified and unit-testable but are not wired into any existing route — there is nothing yet in this repository that needs to gate on product, so wiring them in now would be gating access to pages that don't exist.

Every existing Travel workflow, every existing route, the Stripe webhook, and the dashboard itself require zero code changes to keep working after this ships. That's not an incidental property — it's the design constraint the rest of this document optimizes for.

## 2. Current-state findings from the repository

Verified directly against the repository at the commit above (line numbers are exact as of this commit):

- **Auth**: `requireAuth` (`server.js:644-660`) verifies a Supabase JWT via `adminClient.auth.getUser(jwt)` and sets `req.user`. There is no separate concept of a "product-scoped" session — auth is purely identity, tenant resolution is separate.
- **Tenant resolution**: `getRequestOrgId(req)` (`server.js:489-584`) is the single source of org binding for every customer route. It tries, in order, `app_metadata`/`user_metadata` org id, then `profiles.org_id`, then `org_members.org_id`, then `memberships.org_id`, then a single-org fallback — and memoizes the result onto `req._orgId`. **This is the field the capability service must read `req._orgId` from, not re-derive independently**, so it composes correctly with support-session pinning (below).
- **Org-admin gate**: `requireOrgAdmin` (`server.js:629-641`) checks `org_members.role === 'admin'` — used today only for billing routes. Not the same thing as platform-admin.
- **Suspension gate**: `assertOrgActive` (`server.js:604-619`) blocks resource-consuming actions for `status !== 'active'` orgs — a precedent for a narrowly-scoped, fail-closed async guard called at the top of a handler, which the new middleware in §13 follows structurally.
- **Platform-admin auth**: `isJobuAdmin`/`requireJobuAdmin` (`src/admin-lib.js:24-58`) query a dedicated `platform_admins` table by `user_id`, fail closed on any error (`admin-lib.js:33-37`), and are mounted once for the whole admin router (`src/admin-api.js:51`: `router.use(requireAuth, requireJobuAdmin)`), with only `/status` (`admin-api.js:46-49`) exempted for client-side UI gating. The admin router itself is mounted at `server.js:662`: `app.use('/api/admin', createAdminRouter({ requireAuth }))`.
- **Support-view sessions**: `resolveSupportSession` (`admin-lib.js:139-173`) reads `X-Support-Session`, validates token/owner/expiry/live-admin-status, and — critically — sets `req._orgId = session.org_id`, the *same* field `getRequestOrgId` memoizes into. `blockWriteDuringReadOnlySupport` (`admin-lib.js:178-185`) then blocks writes. This means **any handler that calls `getRequestOrgId(req)` already transparently serves the support-view tenant** — the capability service gets this for free by following the same pattern, and must not add a second, competing notion of "which org."
- **Existing entitlement overrides**: `org_entitlement_overrides` (used at `admin-api.js:139-186`) is shaped for *numeric limit deltas* — `metric_key` / `previous_value` / `override_value` / `is_unlimited`, constrained to a fixed `METRIC_KEYS` list (`admin-api.js:20-26`: `max_opponent_teams`, `max_reports_per_month`, `max_users`, `max_self_scout_reports_per_month`, `max_matchup_reports_per_month`). It is **not** shaped for enum or array fields. This matters for §14: product-access changes should not be shoehorned into this table.
- **`max_users` has no Stripe-derived default** (it's in `METRIC_KEYS` but absent from `PLAN_LIMITS` in `stripe.js:33-37`) — i.e. there's already precedent in this schema for a column that is admin-managed only, with no plan-driven default. `customer_type`/`enabled_products` will be the same shape of field.
- **`feature_flags`** (`admin-api.js:372-414`) is a *global*, plan-keyed toggle table (`key`, `is_globally_enabled`, `enabled_plans`) — not per-organization. It answers "is feature X on for plan Y platform-wide," not "does org Z have product W." Distinct concern from this RFC's `enabled_products`.
- **Stripe has no product axis today**: `PRICE_IDS` (`stripe.js:8-17`) maps only `coach`/`organization` tiers to price env vars; `limitsColumnsForTier` (`stripe.js:39-47`) maps a tier to the four numeric limit columns. There is no price → product mapping anywhere. Confirmed by grep — no code references a Stripe price metadata field for product. This means, correctly, that **product access cannot be Stripe-derived in this release** — see §16.
- **`[Revised again, post-implementation]` RLS is confirmed enabled on `public.organizations`.** The earlier revision of this finding inferred RLS was "likely configured" from `src/supabase.js:14-20`'s `userClient(jwt)` comment (*"RLS applies — users only see their own org's data"*) — real evidence, but still an inference. Directly querying the live project's table metadata during Slice 1's final review confirms it as fact: `organizations` has `rls_enabled: true`. `userClient(jwt)` itself remains dead code — grepping the codebase for `userClient(` still finds exactly one match, its own definition, called from nowhere. **Slice 1's implementation uses the service-role `adminClient` exclusively (via a lazy `require` inside `getOrganizationCapabilities`, so importing `src/product-capabilities.js` never requires Supabase env vars to be set) and does not depend on, read, or need any RLS policy on `organizations`** — a service-role client bypasses RLS unconditionally regardless of whether it's enabled or what policies exist. That conclusion is unchanged by this correction. What *is* new: before `userClient()` is ever activated for anything real, the actual `SELECT` policies (if any) on `organizations` need to be inspected directly — RLS being *enabled* with no matching policy defined means zero rows are visible to that client by default (Postgres's fail-closed behavior), which would need to be confirmed one way or the other before relying on it, not assumed either way.
- There is a comment in `admin-lib.js:9-11` referencing an `is_jobu_admin()` SQL function, which — if it exists at all — lives only in the live Supabase project, not in this repository (consistent with the Phase 1 finding that the live schema has no in-repo migration history). Unrelated to product capabilities; not touched by this RFC.
- **No existing per-org fetch helper**: every route that needs an organization row (`enforceReportQuota` at `server.js:933-974`, the webhook handler, the admin customer-detail route) writes its own inline `.from('organizations').select(...)`. There is no `getOrganization()` to reuse or conflict with — `src/product-capabilities.js` will be the first centralized read path for this concern, which is the point of this RFC, not a departure from existing style.
- **No migration convention exists yet**: confirmed in the Phase 1 audit and unchanged since — `migrations/` holds a legacy SQLite schema (pre-rebrand "Voodoo Scout"), and the live Supabase/Postgres schema has zero in-repo migration files. This RFC is the first to establish `supabase/migrations/`, per Blueprint §11.1.
- **No test runner is wired up**: `package.json`'s `test` script is literally `echo "Error: no test specified" && exit 1`. This RFC's test plan (§21) has to account for that rather than assume an existing suite.

## 3. Goals

- Every organization has an explicit, queryable product identity; no product access is ever inferred from name, team data, or client state.
- A single module is the only place capability logic is computed — no route independently reinterprets subscription or product state.
- The change is invisible to every existing customer and every existing route on day one.
- The migration and the code are both cleanly, independently reversible.
- The foundation is testable in isolation, without requiring the routes that will eventually consume it to exist yet.

## 4. Non-goals

- No dashboard, `dashboard-src/`, or `admin/index.html` changes.
- No product switcher, onboarding screen, or any customer-facing UI.
- No Travel or High School page work of any kind.
- No pricing or Stripe integration changes.
- No new admin UI (contract only, per the task's own instruction).
- No RLS introduction — stays consistent with the all-application-layer enforcement model already in use.
- No durable job table, no report-template work, no `canonical_teams`/`canonical_players`/etc. — those are Phase 5+ per the Blueprint and out of scope here. (The `canonical_team_id` schema gap flagged in the Phase 1 blueprint review remains open and unresolved — it doesn't block this RFC, which touches only `organizations`.)

## 5. Proposed data model

Four new columns on `organizations`, additive only:

| Column | Type | Default | Nullable |
|---|---|---|---|
| `customer_type` | `text` | `'travel'` | not null |
| `primary_product` | `text` | `'travel'` | not null |
| `enabled_products` | `text[]` | `array['travel']` | not null |
| `onboarding_completed_at` | `timestamptz` | none | nullable |

No other table changes. No FKs point at these columns. Nothing else in the schema depends on them existing, so this is the lowest-blast-radius schema change possible for this feature.

## 6. Exact SQL migration design

Establishes the `supabase/` migration convention from Blueprint §11.1, deliberately separate from the legacy `migrations/` directory to avoid repeating the exact naming collision that caused the Phase 1 confusion.

`supabase/migrations/20260722000000_add_organization_product_fields.sql`:

```sql
-- Phase 2: organization product-capability foundation.
-- Additive only. Every existing row becomes valid the instant this runs —
-- no follow-up backfill statement is required because every default below
-- is a constant, not computed from existing data.

alter table organizations
  add column if not exists customer_type text not null default 'travel',
  add column if not exists primary_product text not null default 'travel',
  add column if not exists enabled_products text[] not null default array['travel']::text[],
  add column if not exists onboarding_completed_at timestamptz;

-- Grandfather existing orgs past any future onboarding-selection gate.
-- New signups after this migration get NULL here by design (see §15).
update organizations
  set onboarding_completed_at = now()
  where onboarding_completed_at is null;

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

-- [Revised] The self-review found that the four constraints above do NOT
-- prevent a contradictory label: nothing stopped customer_type='high_school'
-- from coexisting with enabled_products=['travel']. The original draft left
-- this correlation as an unenforced "admin convention" (see the struck-through
-- reasoning preserved in §8). That's a real gap, not a stylistic choice, so
-- it is now a fifth, enforced constraint. Uses containment (@>) + cardinality
-- rather than array equality (=) specifically to stay insertion-order-safe —
-- array['travel','high_school'] = array['high_school','travel'] is FALSE in
-- Postgres, which would have been a silent footgun.
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
  'Phase 2: travel | high_school | hybrid | internal. Set by admin action only — never inferred from team/name data. See src/product-capabilities.js.';
comment on column organizations.enabled_products is
  'Products this org may access. Fully determined by customer_type as of Phase 2 (see organizations_products_match_customer_type_check) — stored as its own column for forward-compatibility with a future 3rd product, not because it is independently settable today. Never derived from Stripe (see RFC §16).';
```

**Consequence of this revision, worth stating plainly**: with only two possible products, `enabled_products` is now *fully determined by* `customer_type` — there is no state where they can legitimately disagree. That raises a fair question of whether `enabled_products` needs to be a stored column at all right now versus a value computed on read from `customer_type`. The recommendation is to keep it stored (not computed), because the Blueprint's own data model treats it as independently meaningful for a future 3rd product, and a generated/computed column would need to change shape the day that happens, whereas a stored, constrained column does not — only the constraint's `CASE` needs a new branch. The redundancy is deliberate and cheap; the alternative (an unconstrained, independently-settable column) is what created the actual gap this revision fixes.

Down migration `supabase/migrations/20260722000000_add_organization_product_fields.down.sql` (kept alongside, not auto-run — see §9):

```sql
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
```

**`[Revised]` This file is safe to run only before real usage begins — see the "adoption boundary" in §9.** It is kept in-repo as a reference for the pre-adoption window, not as a general-purpose rollback tool. `supabase/README.md` documents the post-adoption procedure as prose instructions instead of a second runnable script (§9, §24, §review-area-9 in the accompanying review explain why).

`supabase/README.md` (new) documents this as the canonical migration path going forward, mirroring `dashboard-src/README.md`'s role from Phase 1.5.

### `enabled_products`: array vs. jsonb vs. join table

**Recommendation: `text[]`.**

- **vs. `jsonb`**: `jsonb` buys flexibility (per-product metadata later) that nothing today needs, at the cost of a weaker, harder-to-express `CHECK` constraint and less idiomatic containment queries. Array containment (`<@`, `= any()`) is a direct, indexable, constraint-expressible fit for "is this value in a small closed set," which is exactly the shape of this field.
- **vs. a normalized join table** (`org_products(org_id, product, enabled_at, enabled_by)`): more "correct" relationally, but it buys exactly one thing this codebase doesn't need built twice — an audit trail of when a product was enabled — because `admin_audit_log` already provides that for every admin-driven change via `logAdminAction` (§18). A join table also means capability resolution needs a join instead of a single-row read, working against the "one cheap request-scoped lookup" design in §10, and against precedent: every other per-org config in this schema (`max_opponent_teams`, `plan`, `status`) is a plain column on `organizations`, not a satellite table.
- If per-product metadata becomes genuinely necessary later (e.g., a trial-expiry date scoped to one product), that's a clean, additive migration from `text[]` to a join table at that time — not a reason to build it speculatively now.

## 7. Backfill behavior for existing organizations

Every existing row gets `customer_type = 'travel'`, `primary_product = 'travel'`, `enabled_products = ['travel']` via constant column defaults applied in the same `ALTER TABLE` (Postgres 11+ applies a constant default without a full table rewrite — no downtime, no batch backfill script needed).

`onboarding_completed_at` is explicitly backfilled to `now()` (not `created_at`) via the `UPDATE` statement in §6. Rationale: this field's only stated purpose is gating a future onboarding-selection prompt (Blueprint §7's onboarding UI, out of scope here). Its correct semantics are "no onboarding action is pending," not a historical record of when the org first signed up — `created_at` would be answering a question nobody's asking and would misrepresent orgs that signed up under the pre-Phase-2 single-product flow as having gone through product selection, which they didn't. `now()` honestly means "grandfathered as of this migration." Flagged as a judgment call in §26 in case the team prefers otherwise — either value produces identical behavior (no gate exists yet either way), so there's no correctness risk in this choice, only semantic accuracy.

## 8. Constraints and validation rules

Enforced at the database layer (§6) as the source of truth, re-validated at the application layer (§14) for early rejection with a useful error message:

- `customer_type` ∈ `{travel, high_school, hybrid, internal}` — DB `CHECK`.
- `primary_product` ∈ `{travel, high_school}` — DB `CHECK`. `internal` and `hybrid` are *customer types*, not valid *products*.
- `enabled_products` is a non-empty subset of `{travel, high_school}` — two DB `CHECK`s.
- `primary_product` must be a member of `enabled_products` — DB `CHECK`.
- **`[Revised]` `customer_type` ↔ `enabled_products` ↔ `primary_product` correlation is now a DB constraint, not a convention.** The original draft treated this correlation as deliberately unenforced "admin-tooling policy," reasoning that the schema should "stay permissive so policy can evolve without a migration." The self-review rejected that reasoning: it directly contradicts three explicit requirements this same document is supposed to satisfy — "high_school organizations cannot accidentally receive Travel access unless explicitly enabled," "hybrid organizations must have both products," and "internal organizations have clearly defined behavior." A permissive schema cannot *guarantee* any of those; it can only be configured correctly by an admin route that happens to be careful. The two new constraints in §6 (`organizations_products_match_customer_type_check`, `organizations_primary_matches_type_check`) close this gap at the only layer that can actually guarantee it. See §26 for the narrower question this still leaves open (whether a 3rd product should force a schema change or a data-only change — deferred, not blocking).
- New-organization signup (`server.js:709-717`) requires **zero code changes** — the column defaults alone make every newly-inserted row valid. Deliberate: nothing needs to change at signup time until an onboarding-selection screen exists (Phase 3/4+).

### Constraint truth table (required by the review)

| `customer_type` | `enabled_products` | `primary_product` | Valid? | Why |
|---|---|---|---|---|
| `travel` | `['travel']` | `travel` | ✅ | Default state; every pre-existing org lands here |
| `high_school` | `['high_school']` | `high_school` | ✅ | Pure High School org |
| `hybrid` | `['travel','high_school']` | `travel` | ✅ | Hybrid, landing on Travel by default |
| `hybrid` | `['high_school','travel']` | `high_school` | ✅ | Same as above, reversed insertion order — `@>` containment makes order irrelevant |
| `internal` | `['travel','high_school']` | `travel` | ✅ | House/support/demo org |
| `travel` | `['travel','high_school']` | `travel` | ❌ | **Blocked** — a `travel` org can never carry High School access; this is the exact gap the revision closes |
| `high_school` | `['travel']` | `travel` | ❌ | **Blocked** — a `high_school` org can never be silently Travel-only |
| `hybrid` | `['travel']` | `travel` | ❌ | **Blocked** — hybrid must have *both*, not one |
| `travel` | `[]` | `travel` | ❌ | **Blocked** by the non-empty constraint independently of the correlation constraint |
| `travel` | `['travel']` | `high_school` | ❌ | **Blocked** — primary product not a member of (and, for `travel`, not equal to) enabled products |
| `travel` | `['travel','bogus']` | `travel` | ❌ | **Blocked** by the subset constraint — unknown product name |
| `hybrid` | `['travel','high_school','travel']` (dup) | `travel` | ❌ | **Blocked** — `cardinality(...) = 2` fails on a 3-element array even if the extra element is a duplicate |

## 9. Rollback strategy

**`[Revised]` The original draft treated schema rollback as uniformly safe "at any point before any other table gains an FK to these columns." That's incomplete — it only accounts for referential-integrity risk, not usage risk.** There is a real adoption boundary this document needs to name explicitly:

- **Before Slice 2 ships (§27) — no organization has ever been set to anything other than the migration's default (`travel`/`['travel']`)**: a schema rollback (the down migration in §6) is lossless. Dropping the columns loses nothing, because every row's value is identical to what it would be if the columns had never existed.
- **After Slice 2 ships and at least one organization has been assigned `high_school`, `hybrid`, or `internal` by an admin**: a schema rollback is **destructive**. It permanently deletes the only live record of that assignment. The change is recoverable in principle — `admin_audit_log` retains the `old_values`/`new_values` of every change (§18) — but only via a manual reconstruction script that replays the latest audit entry per organization; there is no automatic replay. Worse, if by that point any real route has started gating behavior on these columns (Phase 3/4+), a schema rollback stops being a "clean up an unused feature" action and becomes a **functional regression for real, currently-served customers**.

**Two independent rollback paths, correctly distinguished by that boundary:**

1. **Code rollback (recommended default, always safe, at any point)**: revert the application commit. `src/product-capabilities.js`, the new route(s), and the new middleware are all net-new and imported by nothing else — removing them has zero effect on any existing route, before or after adoption. The `organizations` columns remain in place, inert. **This is the only rollback path that should ever be used as an incident response**, at any stage.
2. **Schema rollback (deliberate cleanup, never an incident-response tool)**: run the down migration in §6, but **only** either (a) before Slice 2 ships, or (b) after exporting the current `customer_type`/`primary_product`/`enabled_products` value for every organization where it differs from the default, as a documented, deliberate decommission — not a reflexive rollback.

## 10. Product-capability service design

`src/product-capabilities.js` exports two layers, split specifically so the interesting logic is unit-testable without touching a database (see §21):

```js
// Pure — no I/O. Takes already-fetched data, returns the capability object.
// This is what unit tests exercise directly.
function resolveProductCapabilities(orgRow, { supportSession = null } = {}) { ... }

// Request-aware wrapper. Fetches the org row via the same req._orgId that
// getRequestOrgId(req) / resolveSupportSession already populate, then
// delegates to the pure resolver above. This is what routes and
// middleware call.
async function getProductCapabilitiesForRequest(req) { ... }

// Middleware factories, §13, built on top of getProductCapabilitiesForRequest.
function requireProductAccess(product) { ... }
function requireFeature(featureKey) { ... }
function requireEntitlement(entitlementKey) { ... }

module.exports = {
  resolveProductCapabilities,
  getProductCapabilitiesForRequest,
  requireProductAccess,
  requireFeature,
  requireEntitlement,
};
```

`getProductCapabilitiesForRequest` reads `req._orgId` (via the *existing* `getRequestOrgId(req)` from `server.js`, imported rather than duplicated) and selects exactly the four new columns plus the existing `plan` and the four `max_*` limit columns in one query — the same shape of single-row read `enforceReportQuota` already does at `server.js:939`, so this introduces no new query pattern into the codebase.

## 11. Capability resolution precedence

Exact order, as required:

1. **Database organization product fields** — `customer_type`, `primary_product`, `enabled_products` on the resolved org row. This is the base truth for *product* access.
2. **Stripe-derived plan entitlements** — affects only the `limits` block (existing `max_*` columns, already written by the webhook at `server.js:1093`). Stripe has no product axis today (§2, §16), so it has **no influence on `enabledProducts`/`customerType` in this release.**
3. **Admin overrides** — changes to `customer_type`/`primary_product`/`enabled_products` happen through the new admin route (§14), which writes directly to the `organizations` columns (audited) — **not** through `org_entitlement_overrides`, whose schema is purpose-built for numeric deltas and doesn't fit an enum/array field (§2).
4. **Internal/platform-admin access** — being a platform admin does **not**, by itself, grant broader product access to the admin's *own* organization. An admin's own org gets whatever `enabled_products` its row says, same as any customer. (An internal/house org would typically be configured with `customer_type = 'internal'` and both products enabled via the same admin route everyone else uses.)
5. **Support-session restrictions** — **hard rule, explicitly tested (§22): a support session must never expand entitlements.** When `req._supportSession` is set (via `resolveSupportSession`), `req._orgId` is already pinned to the *target* org (`admin-lib.js:167`). The capability service resolves capabilities purely from that target org's own row — never from the admin's own org, and never a superset. Support view exists to reproduce exactly what the customer sees, not an expanded debugging view.
6. **Application defaults** — if a field is unexpectedly null or malformed (shouldn't happen given the `NOT NULL`/`CHECK` constraints from §6/§8 — Postgres enforces those unconditionally, even against `adminClient`'s service-role writes, so this branch is realistically only reachable via an out-of-band manual DB edit that bypassed the constraints), fall back to Travel-only. Fails toward the smallest currently-functional product set, never toward "allow everything."

### `[Revised]` Final resolution algorithm (pseudocode, fail-closed)

The prose precedence above is now backed by one explicit algorithm, added because the original draft's §11.6 ("fall back to Travel-only" for nulls) didn't cover malformed-but-non-null values, and didn't state precisely enough that the resolver re-validates rather than trusting the DB blindly:

`[Revised again, post-Slice-1 security review]` The original text below said `getRequestOrgId(req)` "never accepts client-supplied org... state" -- true of `req.body`/`req.query`/`req.params`, but **false** as originally implemented: `getRequestOrgId` trusted `user.app_metadata.org_id` and `user.user_metadata.org_id` ahead of any database lookup, and `user_metadata` is Supabase Auth's *user-editable* metadata field (writable by the account owner via the standard `supabase.auth.updateUser()` client call, with no admin privilege required). Any signed-up user could set their own `user_metadata.org_id` to another organization's id and be treated as a member of it by every route that calls `getRequestOrgId` -- not just this one. Found and fixed as part of this Slice's own security review, before merge; see `getRequestOrgId`'s header comment in `server.js` for the fix's full reasoning and `test/api-product-capabilities.test.js`'s "Tenant-isolation regression tests" section for the tests that pin this shut. The pseudocode below now describes the fixed behavior, which is what actually ships:

```text
function resolveCapabilities(req):
    # ── Identity: never accepts client-supplied org or product state ──
    # orgId comes ONLY from getRequestOrgId(req), which trusts exactly two
    # sources: req._orgId already pinned by a validated support session
    # (resolveSupportSession), or a fresh org_members row keyed on
    # req.user.id (the verified JWT's own subject, never anything else on
    # the user object). No parameter of this function, no field of
    # req.body/req.query/req.params, and -- as of the fix above -- no
    # field of user.app_metadata/user.user_metadata, ever supplies orgId
    # or a product name directly.
    orgId = getRequestOrgId(req)
    if orgId is null:
        fail closed -> 400 "organization could not be resolved"

    orgRow = fetchOrganizationRow(orgId)   # single-row read via adminClient;
                                            # customer_type, primary_product,
                                            # enabled_products, onboarding_completed_at,
                                            # plan, status, max_* columns
    if orgRow is null:
        fail closed -> 404 "organization not found"

    # ── Defense in depth: re-validate even though DB constraints (§6, §8)
    # should make these branches unreachable in normal operation. Only a
    # manual, out-of-band DB edit that bypassed constraints could trigger
    # them. Correcting here, rather than trusting the row, means a single
    # bad row can never silently grant more than Travel-only. ──
    if orgRow.customer_type not in {travel, high_school, hybrid, internal}:
        log_warning("malformed customer_type", orgId, orgRow.customer_type)
        orgRow = { customer_type: travel, primary_product: travel, enabled_products: [travel] }

    else if orgRow.enabled_products is empty or contains a value outside {travel, high_school}:
        log_warning("malformed enabled_products", orgId, orgRow.enabled_products)
        orgRow.enabled_products = [travel]
        orgRow.primary_product = travel

    else if orgRow.primary_product not in orgRow.enabled_products:
        log_warning("primary_product not in enabled_products", orgId)
        orgRow.primary_product = orgRow.enabled_products[0]   # smallest safe correction, not a guess

    # ── Stripe/plan influence is scoped to limits ONLY, never to product
    # access. This is the algorithmic guarantee behind "existing Stripe
    # plans continue to behave as Travel": nothing in this block can ever
    # add to enabled_products, no matter what plan or webhook event fired. ──
    limits = computeLimitsFromPlanColumns(orgRow)   # existing max_* columns only

    # ── Admin/platform-admin status of the CALLER is not an input to this
    # function at all. There is no "isRequesterPlatformAdmin" parameter
    # here — this function only ever sees orgRow, which is the TARGET
    # org's own row (already pinned correctly upstream by
    # resolveSupportSession when a support session is active). A platform
    # admin's own elevated status literally cannot reach this function in
    # a way that could widen orgRow's product set. ──

    features = computeFeatureGates(orgRow.enabled_products)   # §12

    return {
        customerType: orgRow.customer_type,
        primaryProduct: orgRow.primary_product,
        enabledProducts: orgRow.enabled_products,
        onboardingCompleted: orgRow.onboarding_completed_at is not null,
        features: features,
        limits: limits,
        billing: { plan: orgRow.plan, status: orgRow.status },
        overridesActive: any(orgRow.max_* differs from limitsColumnsForTier(orgRow.plan)),
    }
```

Explicit confirmations required by the review:
- **Browser-supplied product state cannot grant access** — the function has no input path for it; see the identity comment at the top of the algorithm.
- **Support sessions do not expand entitlements** — the algorithm has no branch keyed on "is there a support session," because it doesn't need one: it always resolves whatever `orgId` is currently pinned to, and `resolveSupportSession` already guarantees that's the *target* org, never the admin's own.
- **Admin status does not accidentally grant the viewed org additional products** — the algorithm never receives the caller's admin/role status as an input at all.
- **Existing Stripe plans continue to behave as Travel** — the Stripe/plan block is scoped to `limits` only, structurally incapable of touching `enabled_products`.
- **Unknown or malformed database values fail safely** — the three explicit correction branches, each logged, each collapsing toward the minimum viable (Travel-only) state, never toward a broader one.

## 12. API contract

`GET /api/product/capabilities` — `requireAuth`, then (mounted the same way other customer routes are) `resolveSupportSession` so support-view inherits pinning for free. **This is a customer-facing endpoint** — any authenticated org member can call it, not just admins — which is why no admin-only detail (override reasons, admin user IDs, raw audit rows) ever appears in the response.

**`[Revised]` Recommended v1 response — now separates product/feature access from billing state and override visibility, per the review's explicit requirement:**

```json
{
  "customerType": "travel",
  "primaryProduct": "travel",
  "enabledProducts": ["travel"],
  "onboardingCompleted": true,
  "features": {
    "travel.enabled": true,
    "highSchool.enabled": false
  },
  "limits": {
    "opponentTeams": 10,
    "travelReportsPerMonth": 15,
    "selfScoutReportsPerMonth": 5,
    "matchupReportsPerMonth": 5
  },
  "billing": {
    "plan": "coach",
    "status": "active"
  },
  "overridesActive": false
}
```

`billing` and `overridesActive` are new in this revision:
- `billing: { plan, status }` — sourced directly from the existing `organizations.plan`/`status` columns already read for `limits`, no new query. Kept minimal: plan name and account status, nothing from raw Stripe objects.
- `overridesActive` — a single boolean, computed by comparing the org's current `max_*` values against what `limitsColumnsForTier(org.plan)` would produce for a non-overridden org of that plan (both already in hand from the same single-row read — zero extra query). `true` means an admin has manually adjusted at least one limit away from plan defaults. This tells a customer "your limits aren't standard" without exposing *why*, *who*, or *when* (that detail stays admin-only, in `admin_audit_log` and `org_entitlement_overrides`, neither of which this customer-facing endpoint touches).

**Required behavior definitions:**

| Scenario | Response |
|---|---|
| Organization cannot be resolved | `[Revised]` `401` if the caller's identity itself couldn't be determined, `403` if the caller is a verified user with no accepted `org_members` row (or, ambiguously, more than one) for their account, `500` (generic message, no internal detail) if the `org_members` lookup itself fails at the database level — three distinct `getRequestOrgId` failure modes, each carrying its own explicit `.statusCode`, per the fail-closed rewrite described in §11's and §25's revision notes. Route handlers forward `err.message` only when `err.statusCode` was set explicitly this way; anything else is treated as unexpected and replaced with a generic message (see `GET /api/product/capabilities`'s catch block in `server.js`) |
| Organization row not found | `404` |
| Product fields missing | Not reachable in normal operation — `NOT NULL` constraints prevent it. If ever reached (manual DB edit), handled identically to "malformed" below |
| Product fields malformed | Also not reachable via any application code path, since Postgres enforces `CHECK` constraints unconditionally, even for `adminClient`'s service-role writes — only a manual, constraint-bypassing edit could produce this. The §11 algorithm's defensive branches handle it: safe fallback to Travel-only, logged, `200` returned (not an error — a degraded-but-safe response is more useful to the caller than a hard failure for what is, functionally, a data-quality incident, not a request-quality one) |
| User is in a support session | Response reflects the *target* org exactly, per §11.5. No support-session indicator is added to this payload — the dashboard already has its own, separate support-session-banner mechanism (`dashboard-src/modules/support-session.js`); duplicating that state here would be two sources of truth for the same fact |
| Subscription inactive (`status` = `suspended`/`cancelled`) | Response still reports the org's *true* product configuration — `billing.status` surfaces the inactive state, but this endpoint does not itself enforce it. Enforcement of "you can't actually use this because you're suspended" remains `assertOrgActive`'s job (`server.js:604`), called separately by whichever route performs the resource-consuming action. Conflating "what are you entitled to" with "can you act right now" would blur two checks this codebase already deliberately keeps apart |
| Admin override exists | `overridesActive: true`, per above |

Three deliberate deviations from the task's example shape (unchanged from the original draft, still stand after review):

- **Dropped `activeProduct`.** The Blueprint's own §6.4 example includes it for Hybrid product-switching state, but that's inherently client/session state (which product is currently selected), not something derivable from the organization row alone. Inventing a server-side "current selection" concept now, before any client exists that sets or reads it, would be exactly the kind of premature structure flagged in the Phase 1 blueprint review. Add it when the product switcher (non-goal here) is actually built.
- **Trimmed `features` to two keys.** The task's example includes granular keys like `travel.opponents`, `travel.tournaments`, `highSchool.programProfiles` — but none of those pages exist in this repository yet (Phase 3/4 scope). Returning granular feature flags for pages that don't exist is speculative and will need renaming/reshaping once those pages are actually designed. v1 returns only the two product-level gates that are true today: whether each product is enabled at all, computed directly from `enabledProducts`. Phase 3/4 add granular keys as real pages land.
- **Omitted `highSchoolReportsPerMonth` entirely rather than sending `0`.** There is no High School report type in the schema yet (`reports.report_type` today only ever holds `opponent`/`self-scout`/`matchup` values). Sending a fabricated `0` would misrepresent "this doesn't exist yet" as "you have a zero quota," which is a *fabricated-completeness* problem (Blueprint §3.6) applied to an API contract rather than enrichment data. Kept the `travel`-prefixed limit key names (rather than unprefixing them, which would be simpler today) specifically so that client code written against this v1 contract doesn't need a breaking rename once High School limits become real in a later phase — the field is just absent until then.

## 13. Middleware and authorization model

### `[Revised]` Scope cut from three middleware to one

The original draft specified and unit-tested all three (`requireProductAccess`, `requireFeature`, `requireEntitlement`) as Slice D. The self-review found that two of the three would currently be pointless abstractions:

- **`requireFeature(featureKey)`** — in the v1 API contract (§12), `features` contains exactly two keys, `travel.enabled`/`highSchool.enabled`, which are *definitionally* identical to what `requireProductAccess('travel')`/`requireProductAccess('high_school')` already check. A second middleware that does the same membership check under a different name, with no granular feature keys yet to justify it, is the "unused abstraction" the review explicitly asked to avoid. It has no distinct job until Phase 3/4 introduce real per-page feature keys — which §12 deliberately deferred for the same reason (inventing feature flags for pages that don't exist).
- **`requireEntitlement(entitlementKey)`** — has no concrete entitlement keys to check against yet, and its relationship to the *already-working* `enforceReportQuota` (`server.js:933`) is an explicit open question (§26), not a settled design. Building it now means guessing at a shape that Phase 6/7's report-platform convergence work would likely just redesign.

**Only `requireProductAccess(product)` has an unambiguous, already-fully-specified job** — membership check against `enabledProducts`, which §8's revised constraints and §11's resolver both already fully define. It's implemented, unit-tested, and unmounted in this RFC.

```js
requireProductAccess(product)   // 'travel' | 'high_school' — implemented now, Slice 1
requireFeature(featureKey)      // deferred — build when Phase 3/4 defines real feature keys
requireEntitlement(entitlementKey)  // deferred — build when §26's Q4 is actually decided
```

`requireProductAccess` runs after `requireAuth` (and `resolveSupportSession` where mounted), calls `getProductCapabilitiesForRequest(req)`, and checks `product` against the resolved `enabledProducts`. **Fails closed** on every path — an error resolving capabilities or a missing org denies (403), mirroring the existing fail-closed pattern in `isJobuAdmin` (`admin-lib.js:33-37`). It never trusts a client-supplied product value — the `product` argument is always a literal baked into a route definition by the developer, never read from `req.body`/`req.query`/`req.params`.

**It is not wired into any existing route in this RFC.** It's net-new, unit-tested (§21), and ready for Phase 3/4 to import — there is no route yet that needs to gate on product.

## 14. Admin integration

New route in `src/admin-api.js`, inside the existing router (already gated by `router.use(requireAuth, requireJobuAdmin)` at `admin-api.js:51` — no new authorization code needed).

### `[Revised]` Request shape simplified — `enabledProducts` is no longer a client-supplied field

The original draft accepted `enabledProducts` directly in the request body. Now that §6/§8 make `enabled_products` *fully determined* by `customer_type`, accepting it as independent client input would let a caller request an inconsistent combination that the server would then have to reject — an entire class of validation that the revised schema makes unnecessary to have in the first place. The route now derives it server-side from a fixed lookup, the same one the §6 `CASE` constraint encodes:

```
PATCH /api/admin/customers/:orgId/product
Body: { customerType, primaryProduct?, reason }
```

- `customerType` — **required**, ∈ `{travel, high_school, hybrid, internal}`.
- `primaryProduct` — required **only** when `customerType` ∈ `{hybrid, internal}` (there's a real choice); ∈ `{travel, high_school}`. For `customerType` ∈ `{travel, high_school}`, any supplied `primaryProduct` that disagrees with `customerType` is rejected (400) rather than silently overridden — silent overriding could mask a client bug.
- `enabledProducts` — **not accepted**. Derived server-side: `travel → ['travel']`, `high_school → ['high_school']`, `hybrid`/`internal` → `['travel','high_school']`.
- `reason` — **required** (400 if missing/empty) — matches existing precedent exactly: the sibling `POST /customers/:orgId/overrides` route already requires it identically (`admin-api.js:143`: `if (!reason || !reason.trim()) return res.status(400)...`).

**Every call sets the full new state.** There is no partial-update mode — an admin who wants to change only `primaryProduct` for an already-hybrid org still sends `customerType: 'hybrid'` again alongside the new `primaryProduct`. This removes any ambiguity about what an omitted field means.

**`[Revised]` New rule: this route is unreachable during an active support session.** If `req._supportSession` is set, the route returns `403` regardless of the caller's platform-admin status — **before** any other validation runs. Rationale, from the review: a support session exists to let an admin view a customer's experience read-only; using that same request context to also *change* the customer's product configuration would blur the audit trail (was this admin acting as themselves, or "as" the support session?) and contradicts the read-only-by-default posture `blockWriteDuringReadOnlySupport` already enforces for every other write. Changing product access is a platform-admin action taken as the admin, never as a support session.

### Validation order (mirrors the existing overrides route's structure exactly — `admin-api.js:139-162`)

1. `requireAuth` + `requireJobuAdmin` (router-level, already applied).
2. **`req._supportSession` present** → `403`, stop. *(new, §-above)*
3. `customerType` ∈ allowed set → else `400`.
4. If `customerType` ∈ `{hybrid, internal}`: `primaryProduct` present and ∈ `{travel, high_school}` → else `400`. If `customerType` ∈ `{travel, high_school}`: any supplied `primaryProduct` must equal `customerType` → else `400`.
5. `reason` present and non-empty → else `400`.
6. Fetch current org row (for the audit diff, and to confirm existence) → `404` if not found.
7. Derive `enabledProducts` from `customerType` (fixed lookup, no branching on request data beyond the already-validated `customerType`).
8. **One** atomic `.update({ customer_type, primary_product, enabled_products }).eq('id', orgId)` call — all three columns in a single statement, never sequential per-field writes, so the row is never briefly in a partially-updated (and, under the new constraints, potentially constraint-violating) state.
9. `logAdminAction` (`admin-lib.js:66`) — `action: 'product_access_changed'`, `resourceType: 'organization'`, `resourceId: orgId`, `oldValues`/`newValues` capturing all three fields before/after, `reason`.
10. `200` with the updated `{customerType, primaryProduct, enabledProducts}`.

**Expected HTTP status codes**: `200` success · `400` invalid/missing body fields · `401` no auth · `403` not a platform admin, **or** an active support session is present · `404` org not found · `500` unexpected DB error.

**Confirmed**: no generic "update an organization" route exists anywhere in `src/admin-api.js` today — every mutation route is narrowly scoped to specific columns (`POST .../status` → `status` only; `POST .../overrides` → one `METRIC_KEYS` column at a time via a constrained lookup; `POST .../notes` → `org_support_notes` only; full route inventory confirmed via the Phase 1 audit). This new route follows that same narrow-scope precedent — product fields cannot be changed through any route other than this one.

**No new admin UI is designed here**, per the task's instruction. The natural home for one later is the existing customer-detail "overview" sub-tab (`admin/index.html:476`, next to the existing plan dropdown at `admin/index.html:393-398`) — noted for Phase 7, not built now.

## 15. Onboarding implications

`onboarding_completed_at` exists and is correctly populated (§7: `now()` for every pre-existing org) but **this RFC does not build an onboarding-selection screen** — that's explicitly out of scope. New signups after this migration ships get `onboarding_completed_at = NULL` by column default (no default specified — §6), which is semantically correct (they haven't gone through a product-selection step that doesn't exist yet) and has **zero visible effect**, because nothing in the current dashboard reads this field or gates on it. It's there, correctly populated, ready for Phase 3/4 to build against — that's the entire scope of this RFC's involvement with onboarding.

## 16. Billing and entitlement interaction

Confirmed via `stripe.js` (§2): there is no product axis in Stripe pricing today — `PRICE_IDS` only distinguishes `coach`/`organization` tiers, and the webhook (`server.js:1093`) only ever writes `plan` plus the four numeric limit columns. **This RFC changes nothing about Stripe integration.** Product access (`enabled_products`) is entirely admin/database-driven in this release, independent of billing — consistent with Blueprint §22.2 ("UI does not hard-code plan pricing") and with the Blueprint's own roadmap placement of product-specific pricing at Phase 8.

Follow-on risk, not addressed here: once High School has its own price, something needs to map a Stripe price to a product (a metadata key on the Stripe price object is the most likely mechanism, paralleling how `tierForPriceId` already works in `stripe.js:23-28`). Flagged as an open question (§26) so the admin-driven design in this RFC doesn't need rework later, but not designed now.

## 17. Caching strategy

**None, deliberately.** Capability resolution is a single indexed-primary-key row read — exactly as cheap as the existing, uncached `enforceReportQuota` read at `server.js:939`, which this codebase already runs on every report-generation request with no caching. Adding a cache here would be optimizing a query that has no demonstrated cost problem, while introducing a real correctness risk exactly where it matters most: an admin disables a product and a stale cache keeps serving the old capability set. If `GET /api/product/capabilities` turns out to be hot enough to matter once real pages call it (Phase 3/4+), the safe next step is a short-TTL in-memory cache explicitly invalidated by the admin PATCH route (§14) being the only mutation path — not built speculatively now.

## 18. Audit logging requirements

Every admin-driven change to `customer_type`/`primary_product`/`enabled_products` goes through `logAdminAction` (`admin-lib.js:66-90`), reusing the existing `admin_audit_log` table (no new table). `action: 'product_access_changed'`, `resourceType: 'organization'`, `resourceId: orgId`, `oldValues`/`newValues` as full before/after snapshots of all three fields, `reason` required. `[Revised]`: verified directly against `admin-api.js:143` that the sibling overrides route enforces `reason` identically (`if (!reason || !reason.trim()) return res.status(400)...`) — this isn't a stricter-than-precedent choice, it's matching precedent exactly.

## 19. Observability and logging

No new metrics infrastructure — relies on standard request logging plus `admin_audit_log` for change history, consistent with what exists today (`ai_usage_events` is the only other metrics-adjacent table, and it's out of scope here). Recommended, not built: once Phase 3/4 wire real routes to `requireProductAccess`, track its 403 rate as an early signal of misconfigured entitlements. Meaningless to build before those routes exist.

## 20. Files expected to change

```
supabase/migrations/20260722000000_add_organization_product_fields.sql   (new)
supabase/migrations/20260722000000_add_organization_product_fields.down.sql (new)
supabase/README.md                                                        (new)
src/product-capabilities.js                                               (new)
src/admin-api.js                    (+1 route: PATCH /customers/:orgId/product)
server.js                           (+1 mount: GET /api/product/capabilities)
```

Explicitly **not** expected to change: `src/admin-lib.js` (existing helpers reused as-is), `dashboard/index.html`, any file under `dashboard-src/`, `admin/index.html`, `package.json` (no new dependency — see §21), `src/stripe.js`, any report-generation or scraping file.

`[Revised]` `requireProductAccess` (only — see §13) lives inside `src/product-capabilities.js` rather than `server.js`, deliberately — `server.js` is already 2,337 lines, and this RFC's own goal is incremental maintainability; new self-contained concerns get their own module, following the precedent `admin-lib.js` already set for admin/support-session logic.

## 21. Test plan

**No test runner currently exists** (`package.json`'s `test` script errors intentionally). Recommend adding Node's built-in `node --test` runner as part of implementing this RFC — zero new dependency, consistent with Phase 1.5's "no dependencies beyond the standard library" precedent for `scripts/build-dashboard.js`. Scoped only to the tests below, not a general test-infrastructure project.

**Unit tests** (against `resolveProductCapabilities`, the pure function from §10 — no database needed):
- Travel-only, High-School-only, Hybrid, and Internal org rows each resolve to the correct `enabledProducts`/`features`.
- A support session present in the input always resolves against the *target* org's row, never a broader set, regardless of what the calling admin's own org looks like (see §22).
- `[Revised]` Malformed/null `customer_type`, malformed/empty `enabled_products`, and `primaryProduct` absent from `enabledProducts` each independently exercise one of the three correction branches in §11's algorithm — never throw, always resolve to Travel-only-or-safer, never grant.
- `overridesActive` correctly flags `true`/`false` against representative `max_*` vs. plan-default combinations.

**Integration tests** (against a seeded test org — repository already has `scripts/test-user-setup.js` as a precedent for this kind of fixture):
- `GET /api/product/capabilities` returns the documented v1 shape for a real org; 401 with no auth.
- A valid `X-Support-Session` header correctly pins the response to the target org; an expired or ended session 401s (inherited from `resolveSupportSession`, not reimplemented).
- `requireProductAccess('high_school')` denies a Travel-only org and allows a Hybrid org, exercised against a throwaway test route defined only inside the test file (since no real route consumes this middleware yet).
- `[Revised]` Admin `PATCH .../product`: valid change persists and produces an `admin_audit_log` row with correct `oldValues`/`newValues`; invalid `customerType` 400s before any write; `primaryProduct` omitted for a `hybrid` request 400s; a non-platform-admin caller 403s; **a caller with an active support session 403s even if they are a platform admin** (new test, §14).

## 22. Security test cases

- Cross-tenant: user A's JWT cannot retrieve org B's capabilities through any request manipulation — this RFC introduces no new way to specify an org id from the client; it relies entirely on the existing `getRequestOrgId`/`req.user` resolution. `[Revised]` That existing resolution itself had a client-supplied path (`user_metadata.org_id`) until this Slice's own review found and closed it — see §11's revision note. Required regression tests, now in `test/api-product-capabilities.test.js`: a forged `user_metadata.org_id` and a forged `app_metadata.org_id` must each fail to select another tenant; a user with zero `org_members` rows must get 403, not a guessed org; at least one other pre-existing `getRequestOrgId`-dependent route (not just this one) must be spot-checked against the same forged-metadata attempt.
- **Support session does not expand entitlements** (explicit, required test): seed an org with `enabled_products = ['travel']`; have a platform admin (whose own org, if any, might be `internal` with both products) open a valid support session for that org and call `GET /api/product/capabilities` — response must show `enabledProducts: ['travel']`, never the admin's own broader access.
- `[Revised]` **A support session cannot be used to change product access**: with a valid, active support session header present, `PATCH /api/admin/customers/:orgId/product` must 403 even for a genuine platform admin (§14) — distinct from, and in addition to, the existing "read-only support blocks writes" behavior, since this route is blocked unconditionally in a support-session context, not just when the session happens to be read-only mode.
- `[Revised]` Invalid `customerType` in the admin PATCH body (unknown string, wrong type) → 400, rejected before reaching the database, backstopped by the DB `CHECK`s if application validation is ever bypassed. Since `enabledProducts` is no longer client-supplied (§14), there's no longer a "malformed enabledProducts in the request body" case to test — that entire class of input was eliminated, not just validated.
- A non-admin user attempting the PATCH route → 403 (existing `requireJobuAdmin` coverage, exercised again here as a regression guard).
- A normal (non-admin) authenticated request that includes `customerType`/`enabledProducts` fields in its body to *any* other route must have those fields silently ignored — only the admin PATCH route can ever change them.

## 23. Deployment sequence

`[Revised to match the 2-slice plan, §27]`

**Slice 1** (migration + capability service + read endpoint + `requireProductAccess`):
1. Apply the migration (§6) to the live Supabase project. Purely additive — the running (pre-Slice-1) application code never selects or writes the new columns, so this is safe to apply with old code still live; no coordinated deploy window required.
2. Deploy application code: `src/product-capabilities.js` (resolver + `requireProductAccess`) and the new `GET` route. Net-new and unmounted from any existing route — deploying this changes zero existing request-handling behavior.
3. Smoke test: `GET /api/product/capabilities` with a real token against an arbitrary pre-existing org returns `{customerType: "travel", enabledProducts: ["travel"], ...}`.
4. No dashboard deploy is needed or expected.

**Slice 2** (admin write route), only after Slice 1 has been running without issue:
1. Deploy the `PATCH /api/admin/customers/:orgId/product` route.
2. Smoke test: round-trip against a **test/internal org only**, never a real paying customer, and confirm the expected `admin_audit_log` entry.
3. This is the point at which the §9 "adoption boundary" begins — from here on, schema rollback is no longer costless (§9, §24).

Rolling-deployment safety (both slices): because the new columns are all defaulted and no pre-Phase-2 code path references them, old and new application instances can run simultaneously against the migrated schema with zero errors on either side.

## 24. Rollback sequence

`[Revised]` — see §9 for the full "adoption boundary" reasoning this now reflects:

1. **Default path, always safe, at any point**: revert/undeploy the application commit only. Zero database operation required. Nothing else imports the new module or routes, so removal is a clean, isolated diff — true whether the rollback happens during Slice 1 or after Slice 2 has been live for months.
2. **Schema cleanup, safe only under one of two conditions**: (a) before Slice 2 ships — no organization has ever been assigned anything but the default, so the down migration (§6) is lossless — or (b) after exporting the current product fields for every organization that differs from the default, as a deliberate, documented decommission decision, never as a reflexive incident response.

## 25. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Admin sets `enabled_products = []` on a live org, locking them out entirely | DB `CHECK (cardinality(enabled_products) > 0)` + the same validation in the admin route before any write |
| `primary_product` not a member of `enabled_products` (inconsistent state) | DB `CHECK` (§6) + the admin route validates the combined new state atomically, not field-by-field |
| Support session leaking broader access into the target org's capability view | Explicit precedence rule (§11.5) + dedicated required test (§22) |
| A future route bypasses `product-capabilities.js` and queries `organizations.enabled_products` directly, reviving the scattered `if (isHighSchool)` anti-pattern this whole effort exists to avoid | Process mitigation, not a technical one this RFC can fully enforce by itself: keep the file list in §20 as the review checklist — any future `.select()` touching these three columns outside `src/product-capabilities.js` should be a code-review flag |
| No automated test runner exists today, so "test plan" has nowhere to run | Add `node --test` as part of implementing this RFC — zero dependency, scoped to this feature's tests only |
| `supabase/migrations/` drifts from what's actually live if someone applies a change via the Supabase dashboard UI instead of committing a migration — the exact failure mode that produced the original "no migration history" problem | Apply this migration via the Supabase CLI/MCP tooling, then confirm `list_migrations` reflects it in-repo before considering the slice done; this is a discipline this RFC can start but not fully guarantee going forward |
| `[Found and fixed during this Slice's own security review]` `getRequestOrgId` trusted `user.app_metadata.org_id`/`user.user_metadata.org_id` ahead of any database lookup. `user_metadata` is end-user-editable via the standard Supabase Auth client, so this was a full cross-tenant authorization bypass reachable by any signed-up user against every route that calls `getRequestOrgId`, not only this Slice's new endpoint | Removed entirely. `getRequestOrgId` now trusts exactly two sources: `req._orgId` already pinned by a validated support session, or a fresh `org_members` row keyed on the caller's own verified `req.user.id` (accepted-membership only, and failing closed — not just defaulting to travel-only — on zero or more-than-one matching row). See `server.js`'s `getRequestOrgId` header comment and the "Tenant-isolation regression tests" section of `test/api-product-capabilities.test.js` |

## 26. Open questions

1. ~~Should `customer_type = 'internal'` mechanically force `enabled_products` to contain both products?~~ **`[Resolved by this review]`**: yes, enforced by DB constraint now (§6, §8) — `internal` and `hybrid` both require the full product set, no longer a convention.
2. Long-term Stripe → product mapping mechanism (price metadata key vs. a dedicated mapping table) — doesn't block this RFC, but worth a directional decision before Phase 8 so the admin-driven design here doesn't need rework.
3. `onboarding_completed_at` backfill value: `now()` (this RFC's recommendation, §7) vs. `created_at` — genuinely no behavioral difference today; flagging for a quick explicit call rather than assuming.
4. Should a future, real `requireEntitlement` eventually subsume `enforceReportQuota`'s numeric-quota logic (`server.js:933`), or remain a permanently separate, narrower boolean/feature check? No longer blocking this RFC at all (§13) — `requireEntitlement` isn't being built in this slice — but still worth a deliberate decision before Phase 6/7 report-platform convergence.
5. The `canonical_team_id` schema gap raised in the earlier blueprint review remains open and is not addressed by this RFC (out of scope — `organizations` only).
6. `[Updated — no longer a guess]` The unused `userClient(jwt)` helper (`src/supabase.js:14-20`) is confirmed dead code, and RLS is confirmed enabled on `organizations` (see §2). Worth a deliberate decision on whether `userClient()` is an abandoned direction to remove, or a live one to eventually finish wiring in — and if the latter, the actual `SELECT` policies on `organizations` need to be inspected first, since "RLS enabled" does not by itself confirm any row is visible to that client. Not urgent, not blocking Slice 1 or Slice 2, but worth not leaving ambiguous indefinitely.
7. `[New]` The live Supabase project has 22 migrations already applied (confirmed via `list_migrations` during Slice 1's final review — `admin_platform_admins`, `org_entitlement_overrides`, `feature_flags`, `admin_support_sessions`, etc., all pre-dating this RFC), tracked entirely inside Supabase's own migration history with **zero corresponding files anywhere in this repository**. `supabase/migrations/` (established by Slice 1) begins repository-tracked migration history starting from Phase 2 onward — it does not, and was never intended to, reconstruct the 22 migrations that came before it. Worth a deliberate decision on whether that prior history is ever worth backfilling into the repo (e.g. via `supabase db pull`) as a separate piece of work, independent of Phase 2.

## 27. Recommended implementation slices

### `[Revised]` Consolidated from five slices to two

The original draft split this into five slices (migration / capability service / read endpoint / middleware / admin route), reasoning that maximum granularity minimizes review surface per PR. The review reconsidered this against the review's own framing: "a schema-only production change can be safe, but it can also create unnecessary deployment separation." Concretely — a migration-only PR with **no code that exercises it** is not really independently verifiable; the only way to prove it does what's intended is to manually query columns after applying it. Bundling it with the (also fully inert, zero-existing-behavior-change) capability service and read endpoint makes the PR self-verifying via the smoke test in §23, without adding any production risk beyond what the migration alone already carries — none of that code touches any existing route.

The one piece that *is* qualitatively different risk is the admin write route: it's the only thing in this RFC that lets a human change a real customer's state, and it earned its own dedicated validation logic, support-session exclusion rule, and security test pass in this review (§14, §22). Bundling it with the read-only foundation work would blur that focus and mean a bug found in the write route forces reverting the read endpoint along with it, unnecessarily.

**Two slices:**

- **Slice 1 — Foundation (read-only).** §6's migration (+ `supabase/` convention), `src/product-capabilities.js` (resolver + `requireProductAccess`, §13), `GET /api/product/capabilities` (§12), unit + integration tests (§21). Nothing in this slice can change any organization's state — it's the schema plus everything needed to prove the schema works, in one reviewable, self-verifying PR. Zero effect on any existing route or the dashboard.
- **Slice 2 — Admin write path.** The `PATCH /api/admin/customers/:orgId/product` route (§14), its audit logging, and the security tests in §22. The one slice that grants write power — reviewed and shipped on its own, after Slice 1 has run without issue. This is also where the §9 rollback "adoption boundary" begins.

Recommend landing Slice 1, letting it sit in production for at least one deploy cycle with nothing depending on it, then Slice 2.

## 28. Acceptance criteria

- Migration applies cleanly to the live Supabase project with zero downtime; `list_migrations` reflects it in-repo afterward.
- Every existing organization reads back `customer_type = 'travel'`, `enabled_products = ['travel']`, `onboarding_completed_at` populated, immediately after the migration — verified by query, not assumption.
- `[New]` The truth table in §8 has been exercised directly against the live constraint (attempt each ❌ row, confirm it's rejected) before Slice 1 is considered done — not just reviewed on paper.
- Every existing route, the Stripe webhook, report generation, and scraping continue to function with **zero code changes** to any of them.
- `GET /api/product/capabilities` returns the documented v1 shape, correctly reflecting the authenticated user's actual org state.
- The support-session non-expansion test (§22) passes, for both the read endpoint and — once Slice 2 ships — the confirmation that the admin write route 403s during a support session.
- Every admin-driven product-access change produces a correctly-shaped `admin_audit_log` row.
- No customer-facing behavior changes as a result of this release — the dashboard continues to load and behave exactly as it does today.
- The rollback path (§9, §24) has been reviewed line-by-line, with the pre-/post-adoption distinction explicitly acknowledged, and — if a Supabase branch is available via the MCP tooling — exercised there before Slice 1 ships to production.

---

## Summary

`[Revised after self-review — see the accompanying decision package for the full list of changes.]`

A four-column additive migration on `organizations` — now with the customer-type/product correlation enforced at the database layer, not left to convention — one capability-resolution module, one read endpoint, one unmounted-but-tested middleware (`requireProductAccess` only; `requireFeature`/`requireEntitlement` deferred until a route needs them), and one admin write route with an explicit support-session exclusion rule — reusing the existing auth, audit-logging, and support-session machinery at every point rather than building parallel versions of any of it. Nothing a current customer does changes. Nothing in Stripe changes. No dashboard code changes.

**Proposed migration shape:** `organizations` gains `customer_type text not null default 'travel'`, `primary_product text not null default 'travel'`, `enabled_products text[] not null default array['travel']`, `onboarding_completed_at timestamptz` — all constant-defaulted, so every existing row is valid the instant the migration runs — with **seven** `CHECK` constraints (five original + two new correlation constraints from this review) guaranteeing that `travel`/`high_school` orgs can never carry the other product's access, and `hybrid`/`internal` orgs always carry both.

**Proposed API response** (`GET /api/product/capabilities`):
```json
{
  "customerType": "travel",
  "primaryProduct": "travel",
  "enabledProducts": ["travel"],
  "onboardingCompleted": true,
  "features": { "travel.enabled": true, "highSchool.enabled": false },
  "limits": { "opponentTeams": 10, "travelReportsPerMonth": 15, "selfScoutReportsPerMonth": 5, "matchupReportsPerMonth": 5 },
  "billing": { "plan": "coach", "status": "active" },
  "overridesActive": false
}
```

**Expected implementation files (unchanged from the original draft):**
```
supabase/migrations/20260722000000_add_organization_product_fields.sql
supabase/migrations/20260722000000_add_organization_product_fields.down.sql
supabase/README.md
src/product-capabilities.js
src/admin-api.js   (+1 route)
server.js          (+1 mount)
```

**Highest-risk decision:** keeping `enabled_products` as a plain admin-managed field with *no* Stripe-derived source of truth in this release (§16). Still the right call for the smallest safe slice — Stripe genuinely has no product axis today — but it means every High School (and future Hybrid) customer's access is 100% a manual admin action until billing catches up, a real operational dependency on admin diligence rather than just a technical detail.

**Recommended first implementation slice:** `[Revised]` Slice 1 — migration + capability service + read endpoint + `requireProductAccess`, together, as one self-verifying, still-fully-inert PR. See §27 for why this replaced the original five-slice plan.

Stopping here — not modifying application code, migrations, package files, or dashboard files, and not committing this document. Awaiting approval.
