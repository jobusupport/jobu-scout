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

---

# Addendum B: how a schedule date is established, and what each layer can actually prove

Slice 2D published two wrong dates before this addendum existed, and both came from the same
unwritten assumption: that an element containing a date is an element *asserting* a schedule
date. It is not. This addendum is the written contract for how the extractor decides what a
source said about a date, which of those verdicts may be published, and — importantly — the
limits of what the database can independently verify.

## B1. Recognized structural markers

An element becomes a **candidate date header** only when the source affirmatively marked it as
one. Containing a parseable date is necessary but never sufficient:

```text
[data-schedule-date]   [data-date-header]   .date-header   .schedule-date
```

A caption, note, label, tournament title, hero banner or "last updated" stamp carries none of
these, so it governs nothing. A candidate must additionally contain no schedule anchor (a
container holding games is a group, not a header) and be short enough to be a label. Only the
**innermost** marked element counts, so a marked wrapper never shadows the marked label inside it.

When nothing marked governs a row the answer is `not_expressed`. The search is never widened to
look for something merely date-like: widening it is what published the wrong dates.

## B2. The positive date-leading grammar

Structural marking says the source believes the element is a date header. It does not say the
text is a schedule date. A negative keyword list was tried and failed in both directions — it
missed synonyms ("Last modified", "Roster freeze", "Published") and it rejected ordinary
game-day language ("gates open at 5"). The rule is now affirmative:

> A header is read as a schedule date only when a real calendar date **leads** the normalized
> text, optionally after a weekday, exactly one calendar date is named, and everything left over
> is punctuation or a supported annotation describing **that game**.

The date must lead. That single rule separates `Saturday, April 11, 2026 - Doubleheader` from
`Rainout announced Mar 14, 2026`: administrative text says what happened to the schedule before
it names a date; a schedule header names the day first and then annotates it.

### Allowed annotation grammar

Every supported annotation expresses a property of a scheduled game that this codebase already
parses elsewhere. Nothing is admitted because it "looks harmless":

```text
Doubleheader | DH | Game N | Gm N        two games that day, and which one
Home | Away | Neutral | vs | at          the side designation
Varsity | JV | Junior Varsity            the team level
Freshman | Frosh
Senior Night | Senior Day | Homecoming   a game-day designation for THAT game
gates open [at] <time>                   the day's timing
first pitch [at] <time>
<bare clock time>
```

Extending this list is a deliberate act that must name which game property the new annotation
expresses. An administrative phrase describes an action taken *on* the schedule rather than a
property of the game, so it is absent — and absence is refusal.

Annotations grant permission to read the date; they do **not** populate game fields. Scheduled
time, game number and home/away are parsed from the row's own text, never from the header. A
header reading `gates open at 5` therefore cannot become a 5:00 first pitch, and `Game 2` in a
header cannot renumber a game.

## B3. Structured evidence: strength and precedence

A structured value is one the source published for machines rather than readers. Four forms are
recognized, and their evidentiary strength is **stated, not assumed**:

| Form | What it proves |
|---|---|
| `data-schedule-date` on the marked header | The source names this element's schedule date. |
| `data-date-header` on the marked header | The source names this element's header date. |
| `datetime` on a marked `<time>` header | The source names this header's date. |
| a nested `time[datetime]` **descendant** | Only that *its own contents* are a date. |

The nested case is deliberately weaker in meaning: `<time datetime>` is ordinary, correct HTML
that marks a string as a date. It says nothing about whether that date is the schedule date for
the games that follow. `Last modified <time datetime="2026-03-09">Mar 9, 2026</time>` is
perfectly well-formed markup for a fact that is not a game date.

The governing rule, which applies identically to all four forms:

> **Structured evidence may CONFIRM a date the grammar already accepted, or SUPPLY a date the
> visible text never expressed. It may never OVERRIDE an unsafe visible verdict.**

Concretely, per candidate header:

* visible `unsupported` → `unsupported_marked_header`, **even when the structured value agrees**;
* visible `invalid` → `invalid`;
* visible `ambiguous` → `ambiguous`;
* visible readable **and** structured value differs → `conflicting`;
* visible readable **and** structured value agrees → confirmed, resolved;
* visible expresses no date at all → the structured value supplies it;
* an empty value, or a Boolean-style marker such as `"1"`, is not a date and supplies nothing;
* two structured values that disagree → `conflicting`; two that agree → one confirmed date.

No structured form is strong enough to license prose the grammar refused, because none of them
can observe *why* it was refused. Agreement is not absolution: a header whose prose says
"Rainout announced" and whose attribute says the same day is still a header this parser cannot
read, and reading it anyway is precisely the bypass that published `2026-03-14` into a verified
generation.

## B4. Resolution statuses

```text
resolved_game_row          the row itself expressed a date
resolved_date_group        an enclosing marked header expressed exactly one date
not_expressed              neither did; the source simply did not say
ambiguous                  the governing evidence names more than one date
conflicting                row and group disagree, or structured and visible disagree
invalid                    a named date does not exist on the Gregorian calendar
unsupported_marked_header  the source MARKED a date header and put date-like text in it
                           that the positive grammar refuses to read
```

`unsupported_marked_header` is deliberately **not** folded into `not_expressed`. "The source said
nothing" and "the source said something I refuse to interpret" call for different handling, and
only the first may use the completed-game null-date exception (§B6).

## B5. Scope: which header governs which row

A header may govern a row only when it precedes it, is not inside it, and its parent subtree
contains it. On top of that:

**Rows inside a schedule component.** `.schedule`, `[data-schedule]`, `.schedule-component` and
`[data-schedule-component]` declare a component. When a row is inside one, only a header inside
that **same** component may govern it. A page-level header beside the component cannot reach in,
component A cannot govern component B, and nested components stay isolated.

**Rows on a page with no component at all.** The shared-ancestor test alone is too weak — a
distant common parent let a page-level header govern an unrelated nested list. Two shapes, and
only these two, are an affirmative local relationship:

1. the header and the row root are **direct siblings** under one parent; or
2. an explicit date-group wrapper (`.date-group`, `[data-date-group]`) contains **both**.

Anything else resolves to `not_expressed` rather than guessing across an uncertain boundary.

**The governing run.** Where several marked headers could claim one row, they compete. The run
*begins* after the last schedule anchor preceding the row — once a game has intervened, an
earlier header is that game's history, not a rival claim — and *ends* at the row itself, so a
header after the game never affects it. Only the innermost scope competes, so a month header
wrapping a day header is context rather than competition. A header in another component is
excluded before the run is formed.

Within a run, **unsafe evidence participates; it is not a fallback**:

* two readable headers naming the same date → confirmation;
* two readable headers disagreeing → `ambiguous`;
* any header `unsupported` → `unsupported_marked_header`;
* any header `invalid` → `invalid`;
* any header `conflicting` → `conflicting`;
* the result never depends on the order the source emitted the headers.

One readable header plus one unreadable header is not unanimous readable evidence. "I cannot read
this marked header" is strictly less certain than "these two headers disagree", so it cannot
produce a more confident answer than the ambiguous verdict disagreement already yields.

For the same reason an unsafe governing header outranks a **per-row** date, exactly as a
`conflicting` header already does: governing evidence is not irrelevant merely because the row
also spoke.

## B6. The completed-game null-date exception

A collection may publish an observation with `game_date = null` only when the game is `final`
**and** anchored by a stable upstream `sourceGameRef`. A completed game with a durable id is a
real, identifiable event whose date the source merely failed to render.

The exception is unavailable to `unsupported_marked_header`, `ambiguous`, `conflicting` and
`invalid`. Those are unresolved *evidence*, not the absence of evidence. Letting a refused header
fall through to the exception is how a rejected legitimate header became a verified completed
game carrying `game_date = null`.

An unplayed game with no date is never publishable: there is no result to anchor it.

## B7. HTTP(S)-only source references

A schedule reference becomes a source identity only if it parses as a URL **and** resolves to
`http:` or `https:`. `javascript:`, `data:`, `file:`, `ftp:`, `blob:`, `about:`, `mailto:` and
custom schemes parse perfectly well but are not schedule locations, so they yield no href and no
game id. Percent-encoded scheme lookalikes (`%6aavascript:`) are not schemes at all; they resolve
as ordinary same-origin relative paths and are never executed or navigated.

A rejected reference is flagged rather than dropped: the row survives extraction so it can never
be silently lost, no two rejected rows share a sentinel identity, a rejected row never erases the
valid rows beside it, and the collection then fails closed with
`opponent_source_reference_malformed`.

## B8. Where each rule is enforced

```text
extractor    decides the resolution status from the DOM. This is the ONLY layer that
             can see the markup.
collector    refuses to capture a collection containing an unsafe status; names the
             reason (marked_date_header_is_not_a_readable_schedule_date, and the
             siblings for ambiguous/conflicting/invalid).
mapper       refuses to build a DTO from unsafe evidence, before any database call,
             with OPPONENT_SCHEDULE_DATE_UNRESOLVED.
RPC          persist_hs_engine_collection restates the rule inside the SECURITY
             INVOKER boundary and rolls the whole transaction back.
```

Terminal run states: a rejected run settles `failed` with a `failure_stage`, never lingering
`running`. A publication-boundary rejection writes zero canonical games, zero generations, zero
run-game members and zero totals, and leaves the previously current generation current.

## B9. The service-role DTO trust boundary — stated precisely

`persist_hs_engine_collection` runs `SECURITY INVOKER` with `search_path = ''` and is executable
only by `postgres` and `service_role`. It validates the semantic status **supplied in the DTO**.

> The RPC validates the semantic status supplied in the DTO. It cannot reconstruct DOM evidence
> that the caller removed or relabeled.

What that means in practice, verified by direct RPC probing:

* a DTO that **retains** `unsupported_marked_header`, `ambiguous`, `conflicting` or `invalid` is
  rejected by name, with a full transaction rollback and zero writes;
* a privileged caller that **omits** `diagnostics.dateResolution`, relabels the status to
  `not_expressed` or `resolved_date_group`, or supplies a fabricated date, is **not** stopped by
  the database — the DTO no longer contains the evidence the check reads.

This is a property of the trust boundary, not a defect to be patched in SQL. The RPC has no
access to the page, so it cannot prove source semantics; a third restatement of the rule inside
the database narrows accidental bypass by the application's own code paths, and nothing more. The
protection against a malicious privileged caller is that `service_role` credentials are not
issued to untrusted parties — not that the RPC could detect the forgery.

Nothing in this repository should be read as claiming the RPC independently proves what the
source said.
