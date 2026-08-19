# HS 2D: Opponent-game ingestion and verified publication — design contract

Amends the Slice 2C persistence boundary (`20260814190557_add_hs_engine_persistence_boundary.sql`,
`20260817151031_close_hs_engine_service_role_update_privileges.sql`).

Scope: opponent-game ingestion, deterministic reconstruction, validation, identity
reconciliation, and atomic publication. **Out of scope:** opponent-game analysis (2E),
opponent-player/pitcher analysis (2F), coach notes (2G), report generation (2H),
coach-facing UI (2I), launch hardening (2J), opponent roster acquisition, standings,
postseason, and season rollover.

## 1. Why Slice 2C could not absorb this unchanged

Slice 2C's publication boundary is structurally bound to an *own-team* subject:

* `hs_import_runs.team_id` is `NOT NULL` and references `hs_teams(org_id, id)`; every
  `hs_teams` row is one of the organization's own teams.
* `persist_hs_engine_collection` inserts `hs_games` with `team_id = context.teamId`.
* Every `canonicalPlayers` entry must satisfy `hs_roster_memberships` for that team and
  season, or the RPC raises `player_not_on_roster`.
* `idx_hs_stat_generations_current_per_team_season` is
  `unique (org_id, team_id, season_id) where is_current` — exactly one current generation
  per own team and season.

An opponent's game is played between the monitored opponent team and an arbitrary third
school. It has no valid own-team `team_id`, its players are on no roster of ours, and
scouting N opponents in one season requires N simultaneous current generations. Publishing
opponent collections under the organization's own `team_id` would violate all three
invariants at once.

This contract therefore adds a **parallel opponent-subject lineage** and widens the
existing RPC with a discriminated subject, rather than making the own-team tables
polymorphic or introducing a second publication mechanism.

## 2. Own-team vs opponent-team collection

| | own-team collection | opponent-team collection |
|---|---|---|
| Subject | `hs_teams` row (ours) | `hs_opponent_teams` row (monitored) |
| Import run | `hs_import_runs` | `hs_opponent_import_runs` |
| Canonical games | `hs_games` | `hs_opponent_games` |
| Generation | `hs_stat_generations` | `hs_opponent_stat_generations` |
| Current-generation scope | `(org_id, team_id, season_id)` | `(org_id, opponent_team_id, season_id)` |
| Canonical player stats | `hs_player_advanced_stats` / `hs_pitcher_advanced_stats`, roster-gated | **none — forbidden** |
| Noncanonical player stats | `hs_noncanonical_player_stats` | `hs_opponent_noncanonical_player_stats` |
| Source-identity gate | `hs_team_source_registrations` (not enforced by this slice) | `hs_opponent_source_links.status = 'linked'` (enforced) |

An opponent collection **must** carry zero `canonicalPlayers`. The RPC rejects a non-empty
`canonicalPlayers` array on the opponent branch (`opponent_collection_forbids_canonical_players`).
This is the structural guarantee that HS 2D never invents opponent roster membership; opponent
player lines are preserved only as noncanonical observations. Opponent roster modelling belongs
to HS 2F.

The two lineages share no mutable row. An opponent publication cannot read, write, supersede,
or lock own-team publication state, and the reverse likewise.

### Side vocabulary inside an opponent collection

The engine's own/opponent vocabulary is reused unchanged so that no second statistics
algorithm is introduced. Inside an opponent collection it reads as: `own` = the monitored
opponent team (the subject), `opponent` = that game's counterparty school, `unknown` =
a line the engine could not attribute. `is_opponent` on a noncanonical row therefore means
"belongs to the subject's counterparty in that game", not "belongs to a rival of ours".

## 3. Subject key and the widened DTO

The DTO gains one optional top-level `subject` discriminator:

```json
{ "subject": { "kind": "own_team",      "teamId": "<uuid>" } }
{ "subject": { "kind": "opponent_team", "opponentTeamId": "<uuid>",
               "importRunId": "<uuid>", "sourceTeamId": "<uuid>" } }
```

**Backward compatibility.** A DTO that omits `subject` entirely is treated as
`kind = "own_team"` with `teamId = context.teamId` and `importRunId = context.importRunId` —
byte-for-byte the Slice 2C behaviour, including every existing error code. No existing caller
changes. `subject` is additionally accepted in the explicit own-team form, in which case
`subject.teamId` must equal `context.teamId`.

For `kind = "opponent_team"`, `context` carries `orgId`, `programId`, `seasonId`, and
`sourceProvider` only; `context.teamId` and `context.importRunId` must be absent or null,
and the run identifier moves to `subject.importRunId` (an `hs_opponent_import_runs` row).

Rejections (all `P0001` unless noted):

| Condition | Error |
|---|---|
| `subject.kind` not in {`own_team`,`opponent_team`} | `invalid_subject_kind` |
| both `teamId` and `opponentTeamId` supplied | `ambiguous_collection_subject` |
| neither supplied on the explicit form | `missing_collection_subject` |
| opponent subject with `context.teamId` / `context.importRunId` present | `ambiguous_collection_subject` |
| opponent subject with non-empty `canonicalPlayers` | `opponent_collection_forbids_canonical_players` |
| opponent team not in org+program+season | `opponent_team_not_found_for_org_program` (`P0002`) |
| source team not in org | `source_team_not_found_for_org` (`P0002`) |
| no `linked` source link for subject+source team+season | `opponent_source_link_not_linked` (`P0002`) |
| opponent import run not `running` for that subject | `invalid_opponent_import_run_state` |

Cross-organization subjects are impossible by construction: every lookup is filtered by
`org_id` taken from `context`, and every foreign key is composite on `(org_id, …)`, so a
caller-supplied identifier belonging to another tenant simply has no matching row.
A caller-supplied identifier never overrides authoritative database ownership.

## 4. Identity foundation relationships

```
hs_programs (ours)
  └── hs_opponent_programs        one opponent school, per org+program
        └── hs_opponent_teams     that school's team at a level, in one hs_season   ← SUBJECT
              └── hs_opponent_source_links   pending|linked|needs_review|superseded|rejected
                    └── hs_source_team_contexts   (source_team_id, hs_season_id)
                          └── hs_source_teams     (provider, source_team_ref) observed upstream
```

`hs_source_teams` is the *source* identity (a GameChanger team page). `hs_opponent_teams` is
the *canonical* identity (a real school's team). `hs_opponent_source_links` is the reviewed
bridge between them, and is the only structure permitted to assert that a source team *is* a
given opponent team. HS 2D consumes these tables; it does not replace or duplicate them.

The Travel product's `opponent_players`, `opponent_roster_memberships`, and
`coach_scouting_notes` tables (whose `team_id` references `teams`, not `hs_teams`) are
explicitly **not** used by this slice.

## 5. Raw snapshot identity and immutability

A snapshot row (`hs_opponent_raw_snapshots`) is append-only. Nothing in this slice updates or
deletes one; `service_role` holds `SELECT, INSERT` and nothing else on that table.

Identity is `(opponent_import_run_game_id, snapshot_kind, integrity_hash)`, where
`integrity_hash` is the SHA-256 of the canonically serialized payload. Consequences:

* Re-capturing byte-identical content is idempotent — `on conflict … do nothing`.
* A materially changed observation produces a **new** row; the earlier snapshot is retained.
* `captured_at` records when the source was read and is stored separately from `game_date`,
  the date the contest is played. Capture time never participates in identity.

Credentials, cookies, tokens, authorization headers, and unrelated source-page content are
never persisted. The payload is limited to the licensed statistical scope already defined by
`src/high-school-gc-import.js`: game header/date/opponent, box-score rows, and play-by-play text.

## 6. Source event identity and canonical game identity

Canonical opponent-game identity is resolved in a fixed priority order, reusing the Slice 2C
`identity_method` vocabulary:

1. **`sourceGameId`** — a stable upstream game identifier. Preferred whenever present.
2. **`scheduleComposite`** — a deterministic fallback derived from the source team context,
   season, counterparty identity, and explicit discriminators. Never date alone.
3. **`unresolvedScoped`** — no durable identity could be derived. Recorded, never published
   as authoritative.

`hs_opponent_game_identity_aliases` stores the durable mapping
`(org_id, opponent_team_id, season_id, source_provider, identity_method, identity_digest) → opponent_game_id`,
so a later run reuses the same canonical game. `hs_opponent_game_identity_resolutions` records
*how* each link was made (`automatic_durable`, `automatic_fallback_enrichment`, `manual`) with
the prior identity status and an evidence digest, and is append-only.

Name similarity alone never merges programs, levels, seasons, or source teams. The
`scheduleComposite` fallback adopts an existing game only when exactly one alias matches the
foundational digest **and** no discriminator contradicts it; two or more candidates leave the
observation unresolved rather than guessing.

### Schedule reality

* **Reschedule.** A stable `sourceGameId` keeps the same canonical `opponent_game_id` across a
  date change; `hs_opponent_games.game_date`/`game_status` advance to the newest observation,
  while every prior observation's `observed_game_date` and `observed_game_status` remain on its
  own immutable `hs_opponent_import_run_games` row. History is never destroyed and a reschedule
  is never recorded as a second contest.
* **Date change without continuity evidence.** If only `scheduleComposite` is available and the
  date moved, the foundational digest no longer matches; the observation stays `unresolved` and
  is not published as authoritative. Ambiguity is preserved, not resolved by guessing.
* **Doubleheader.** Two games between the same teams on the same date remain distinct. Distinct
  upstream identifiers separate them directly. Without distinct identifiers, the
  `discriminators` object (game number, start time, venue) must distinguish them; if it cannot,
  both observations are marked ambiguous and verified publication for that collection is blocked.
  Games are never merged merely because team and date match.
* **Status.** `scheduled`, `in_progress`, `final`, `postponed`, `cancelled`, `suspended`, and
  `unknown` are distinct values on both the canonical game and each observation, and are never
  conflated.
* **Historical games.** A completed game stays publishable and replayable. Re-ingestion adds a
  new generation; it never rewrites a prior generation in place. Supersession follows the Slice
  2C contract: the prior row becomes `status='superseded'`, `is_current=false`,
  `superseded_at` set.
* **Collision.** Two observations claiming the same identity digest with materially different
  content are recorded with `identity_status='conflict'` and their conflicting field names in
  `conflict_fields`; both observations are preserved and publication is blocked. They are never
  silently merged.

## 7. Publication eligibility

A collection publishes a generation only when **all** hold:

1. The subject resolves to a live `hs_opponent_teams` row in `(org, program, season)`.
2. A `hs_opponent_source_links` row exists for that subject and source team with
   `status = 'linked'`. `pending`, `needs_review`, `rejected`, and `superseded` all block.
3. The referenced `hs_opponent_import_runs` row is `running` for exactly that subject.
4. Every observation is structurally valid, carries a 64-hex identity digest, and declares the
   collection's engine version.
5. No observation is simultaneously `authoritative` and carrying an `identity_status` of
   `conflict`, `unresolved`, or `ambiguous`.
6. `canonicalPlayers` is empty.
7. `contentHash` and `inputSetHash` are 64-hex; payload ≤ 4 MiB.

Observations whose `game_status` is not `final` are published as schedule knowledge with
`excluded_from_official_totals = true`; they contribute nothing to totals. A generation in which
no observation is final is recorded with `official_totals_complete = false` and empty totals — it
is explicitly *not* a completed statistical generation. This is how "non-final games must not
publish a completed statistical generation" is enforced: not by refusing schedule knowledge, but
by refusing to label it complete.

## 8. Generation idempotency, currency, and concurrency

* **Idempotency key:** `unique (org_id, opponent_team_id, season_id, engine_version, input_set_hash)`.
* **Deterministic `input_set_hash`:** SHA-256 over the canonically serialized, sorted set of
  normalized source games plus the subject's identity evidence. Key ordering in the source JSON,
  arrival order, and capture timestamps are excluded, so semantically identical input always
  hashes identically.
* **Identical replay** returns the existing generation row unchanged — no new rows, no supersession.
* **Differing content at the same `input_set_hash`** raises `idempotency_content_mismatch`; the
  prior generation stays current.
* **Changed input set** produces a new generation and atomically retires the prior one.
* **One current generation per opponent:**
  `unique (org_id, opponent_team_id, season_id) where is_current`.
* **Multiple opponents coexist:** the index is scoped by `opponent_team_id`, so opponent A and
  opponent B each hold a current generation in the same season simultaneously. Publishing for A
  can never supersede B.

Concurrency uses the same technique the reviewed 2C branch uses: the subject row and the import
run are locked `FOR UPDATE` before any generation is read or written, so competing transactions
serialize on the subject. Two identical concurrent publications converge on exactly one durable
generation; two differing concurrent publications leave exactly one current generation and fail
the loser with `idempotency_content_mismatch`; concurrent supersession leaves exactly one
internally consistent current generation. Zero or multiple current generations are unreachable.

## 9. Rollback and failure semantics

Publication is one PostgreSQL transaction inside `persist_hs_engine_collection`. There is no
application-side multi-statement publication path and no second RPC. Either the whole collection
commits — games, aliases, resolutions, observations, snapshots, validation results, generation,
totals, noncanonical lines, and the current-generation transition — or none of it does.

A failure at any point must not: mark the failed candidate current; clear or supersede the prior
current generation; leave partial games, totals, or observation rows; promote a `pending` or
`needs_review` link to `linked`; affect a different opponent; or affect own-team lineage. Because
supersession and insertion happen in the same transaction as validation, a raised exception rolls
back the supersession too, so the prior generation remains current. A corrected retry then succeeds.

### Capture-only vs published state

`hs_opponent_import_runs` rows in `pending`/`running`/`failed` status are *capture state*. They
never carry a generation, never satisfy an `is_current` read, and are not verified output. Only a
`hs_opponent_stat_generations` row with `status='completed'` and `is_current=true` is verified
published output. Consumers in 2E–2I read the generation, never the run.

## 10. Tenant isolation and authorization

Every new table has RLS enabled. Policies grant `SELECT` to `authenticated` only where
`org_id in (select public.auth_user_org_ids())` **and** the organization has the `high_school`
product enabled — identical in shape to the reviewed 2C policies.

| Role | Privilege on new tables |
|---|---|
| `PUBLIC` | none |
| `anon` | none |
| `authenticated` | `SELECT` only, under org-scoped + entitlement RLS |
| `service_role` | only what the publication path writes (see below) |
| `postgres` | ownership, as in every existing migration |

`service_role` grants are per-table and minimal: `SELECT, INSERT, UPDATE` on
`hs_opponent_import_runs`, `hs_opponent_games`, `hs_opponent_game_identity_aliases`,
`hs_opponent_stat_generations`, `hs_opponent_verified_totals`; `SELECT, INSERT` on the
append-only tables `hs_opponent_import_run_games`, `hs_opponent_raw_snapshots`,
`hs_opponent_game_validation_results`, `hs_opponent_game_identity_resolutions`,
`hs_opponent_noncanonical_player_stats`. No `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, or
`MAINTAIN` is granted anywhere.

`persist_hs_engine_collection` remains `SECURITY INVOKER` with `search_path = ''`, fully
schema-qualified, revoked from `PUBLIC`/`anon`/`authenticated`, and executable only by
`postgres` and `service_role`. `SECURITY DEFINER` is not used, and RLS is never bypassed to
work around a privilege gap.

## 11. Backward compatibility

* Legacy DTOs without `subject` behave exactly as before, including error codes and returned row.
* No existing table gains a required column; no existing column changes type or nullability.
* No existing constraint, index, policy, or grant is dropped or loosened.
* The Slice 2C relational suite must continue to pass 50/50 with zero skips, unmodified.

---

# Addendum: registered entry point, publication states, and the completeness-regression gate

Corrects two gaps in the first HS 2D candidate (`ef2f21c`): opponent ingestion had no
production-reachable entry point, and a collection containing zero completed games still
produced a current opponent statistical generation.

## A1. Registered application call graph

```
POST /api/high-school/opponents/:opponentTeamId/seasons/:seasonId/import-runs
  requireAuth → resolveSupportSession → requireHighSchoolAccess → blockWriteDuringReadOnlySupport
  → loadOpponentAndSeason(req._orgId, …)          org from the session, never the body
  → policy.isCollectionEnabled / concurrency cap
  → importService.getLinkedOpponentSource(…)      pending/needs_review/rejected/superseded stop here
  → importService.startOpponentImportRun(…)       hs_opponent_import_runs
  → dispatchOpponentCollection(…)                 spawns src/high-school-opponent-gc-import.js
       → runOpponentImportCollection
            → discoverScheduleEntries()           injected seam (Playwright in production)
            → collectGame(entry)                  injected seam, retry/backoff via gc-collection-policy
            → importService.ingestOpponentGameCollection
                 → mapHighSchoolOpponentEngineCollection   Slice 2B engine, unchanged
                 → repository.persistEngineCollection
                      → rpc persist_hs_engine_collection(jsonb)   subject.kind = opponent_team
```

The route is mounted by `src/high-school-api.js` under `/api/high-school`, which `server.js`
registers. `dispatchOpponentCollection` and `spawn` are injectable exactly as `spawn` already
was, so the end-to-end test drives the real service, repository and RPC with only the upstream
source mocked.

**Known gap, deliberately not worked around.** `src/search-gamechanger-teams.js` recognises a
played game by its score badge, so it yields completed games only. Not-yet-played schedule rows
therefore do not reach the collector in production today. The adapter, the schedule-only
publication state and its database constraints all support them; supplying them needs a
schedule-row extractor that does not exist yet. Inventing a second scraper here was rejected.

## A2. Ingestion outcome states

`OPPONENT_INGEST_STATES` in `src/high-school-import-service.js`, reported by both the collector
summary and the service result:

| state | meaning |
|---|---|
| `captured` | source schedule/game observations were stored |
| `validated` | everything captured passed applicable validation |
| `published_schedule_only` | valid schedule knowledge exists; no completed game is eligible for statistical reconstruction |
| `published_verified` | at least one completed game was reconstructed and the verified generation was atomically published |
| `failed` | validation or publication failed; any previously verified generation is preserved |

The result reports separately whether `scheduleCaptured`, `eligibleForVerifiedPublication`,
`verifiedGenerationPublished`, `priorVerifiedGenerationPreserved`, and
`manualReconciliationRequired`.

## A3. Schedule-only versus verified, enforced in PostgreSQL

`hs_opponent_stat_generations.publication_state` is `schedule_only` or `verified`, **derived by
the RPC from what was actually reconstructed and never taken from the caller**. Three check
constraints make the distinction unforgeable even for a privileged caller invoking the RPC
directly or writing the table by hand:

* `…_state_matches_finals_check` — `verified` ⇔ `final_game_count > 0`.
* `…_final_digests_match_count_check` — the recorded completed-game identities agree with the count.
* `…_official_totals_check` (pre-existing) — `official_totals_complete` implies a completed game.

`official_totals_complete = false` is therefore no longer the only signal: a schedule-only row is
named as such, so downstream 2E–2I code cannot mistake it for verified analysis.

## A4. Completeness-regression rules

The dangerous case is not "zero completed games" — it is a later incomplete scrape replacing a
generation that already carried verified statistics. The gate compares the **set** of completed-game
identity digests (`final_identity_digests`), evaluated before any supersession:

| candidate vs current verified generation | outcome |
|---|---|
| no current verified generation | publish (schedule-only or verified) |
| candidate is a superset (games added) | publish new verified generation |
| candidate has the same set, different content (correction) | publish new verified generation |
| candidate has zero completed games | `opponent_completeness_regression`, prior stays current |
| candidate is missing a previously verified completed game | `opponent_completeness_regression`, prior stays current |

Cancelling or postponing a game that was never completed is not a regression. Losing a game that
*was* completed fails closed and is surfaced as `manualReconciliationRequired`, rather than being
guessed at as either a correction or a transient failure.

Preseason ingestion is unaffected: a brand-new opponent with no completed games publishes
schedule-only knowledge. The gate never requires a completed game unconditionally.

The collector applies the same principle one level up: if any discovered completed game fails to
capture, the whole run fails before the publication boundary is touched, so a partial scrape can
never be mistaken for a complete season.

## A5. Capture time is provenance, not identity

`capturedAt` is excluded from the opponent collection's `inputSetHash`, `contentHash` and
observation keys. An opponent schedule is re-scraped on a cadence; if *when* it was read
participated in identity, every unchanged re-scrape would mint a new generation and supersede the
last one for no reason. The `diagnostics` block is excluded from the content hash for the same
reason — it carries digests derived from fingerprints that embed capture time. Both are still
stored in full on the rows they belong to, so the evidence of when each observation was taken is
preserved; they simply do not decide identity. Own-team collections are untouched.

## A6. Advisory-lock construction

Key: `pg_catalog.hashtextextended(org_id || ':' || opponent_team_id || ':' || season_id, 0)`,
acquired with `pg_advisory_xact_lock` before any current-generation state is read or written.

* Identical for every publication targeting the same organization, opponent and season.
* Different for a different tenant, opponent, or season.
* Transaction-scoped — released automatically on commit or rollback.
* Requires no table privilege, which is why it is used instead of `SELECT … FOR UPDATE` on
  `hs_opponent_teams`: that would require granting `service_role` UPDATE on the identity
  foundation, the exact privilege ingestion must not hold.

A hash collision between two unrelated subjects is theoretically possible and would only cause
harmless extra waiting, never an incorrect result. The namespace is the single-argument advisory
lock space; no other code path in this repository takes advisory locks, so there is no avoidable
namespace collision to fix.
