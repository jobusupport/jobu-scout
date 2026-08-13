'use strict';

/**
 * High School Slice 2B pure baseball-domain orchestration.
 *
 * Authoritative calculations live in normalize-core.js, reconstruct-core.js,
 * and stats-core.js. This module owns the explicit public contracts around
 * those cores: own/opponent translation, game identity and collection
 * reconciliation, deterministic normalization options, and result vocabulary.
 *
 * Legacy Travel entry points remain narrow compatibility adapters over the
 * same core modules. Neither this module nor the cores perform database,
 * network, filesystem, deployment, or persistence work.
 *
 * Collection identity is conservative. A durable source game ID wins.
 * Otherwise every schedule discriminator must be meaningful before a
 * composite identity is resolved. Unresolved games are retained separately,
 * including byte-identical snapshots, so ambiguous doubleheaders cannot be
 * collapsed. Resolved duplicate snapshots expose reconciliation provenance
 * and material conflicts instead of silently hiding disagreement.
 *
 * Player accumulation is durable-ID-first. When no durable player ID can be
 * resolved, stats-core keeps the result in an explicit game-scoped unresolved
 * bucket rather than merging it into another player by display name.
 */

const { reconstructGame, reconstructTeamGames } = require('./reconstruct-core');
const { normalizeGameData, normalizeDateCandidate } = require('./normalize-core');
const { processGames } = require('./stats-core');

// ─── Shared ownership-translation helpers ──────────────────────────────────

function requireExplicitOwnBoolean(row, rowKind, index) {
  if (!row || typeof row !== 'object') {
    throw new Error(`baseball-engine: ${rowKind}[${index}] must be an object`);
  }
  if (!Object.prototype.hasOwnProperty.call(row, 'own')) {
    throw new Error(`baseball-engine: ${rowKind}[${index}] is missing the required explicit "own" boolean; ownership is never guessed or defaulted`);
  }
  if (typeof row.own !== 'boolean') {
    throw new Error(`baseball-engine: ${rowKind}[${index}].own must be a boolean (true for the caller's own team, false for the opponent)`);
  }
  return row.own;
}

// Translates one explicit-`own` row into reconstruct-core.js's compatibility
// shape. reconstructGame's isScoutedRow() treats is_our_team === false as
// the "scouted" bucket -- so own:true (this row is ours) must become
// is_our_team:false to land in "scouted", and own:false (opponent) must
// become is_our_team:true. This single inversion point is the ONE place,
// tested in isolation below, that performs it.
function toReconstructionRow(row, rowKind, index) {
  const own = requireExplicitOwnBoolean(row, rowKind, index);
  const { own: _own, isOurTeam: _legacyIsOurTeam, is_our_team: _legacySnakeIsOurTeam, ...rest } = row;
  return { ...rest, is_our_team: !own };
}

// Contradictory-metadata guard: reconstruct-core.js's own scoutedSide/
// opponentSide resolution (buildRosterContext) treats each bucket's venue
// side independently -- if a caller supplies rows where the SAME TeamSide
// (venue) carries both own:true and own:false rows, the underlying legacy
// function does not detect this; it silently resolves ownSide and
// opponentSide to the SAME venue value, which is logically incoherent (two
// teams cannot both play at the venue in one game) but was not previously
// rejected. This is exactly the kind of caller error the explicit
// own/opponent contract exists to catch rather than paper over, so it is
// checked and rejected here, at the one place both reconstructBaseballGame
// and reconstructBaseballTeamGames funnel through.
function assertNoContradictorySideMetadata(capturedGame) {
  const ownByVenue = new Map();
  const venueByOwnership = new Map();
  const box = capturedGame?.boxScore || {};
  const rowFamilies = [
    'batting', 'pitching', 'fielding',
    'awayBatting', 'homeBatting', 'awayPitching', 'homePitching',
    'awayFielding', 'homeFielding',
  ];
  for (const rowKind of rowFamilies) for (const [index, row] of (box[rowKind] || []).entries()) {
    const venue = String(row?.TeamSide ?? row?.teamSide ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!venue || typeof row?.own !== 'boolean') continue;
    const existing = ownByVenue.get(venue);
    if (existing === undefined) {
      ownByVenue.set(venue, row.own);
    } else if (existing !== row.own) {
      throw new Error(`baseball-engine: contradictory side metadata in boxScore.${rowKind}[${index}] -- TeamSide "${venue}" is already associated with own:${existing}, but this row has own:${row.own}.`);
    }
    const ownershipKey = row.own ? 'own' : 'opponent';
    const existingVenue = venueByOwnership.get(ownershipKey);
    if (existingVenue === undefined) venueByOwnership.set(ownershipKey, venue);
    else if (existingVenue !== venue) {
      throw new Error(`baseball-engine: contradictory side metadata in boxScore.${rowKind}[${index}] -- ${ownershipKey} is already associated with TeamSide "${existingVenue}", but this row uses "${venue}".`);
    }
  }
}

function toReconstructionInput(capturedGame) {
  const batting = capturedGame?.boxScore?.batting || [];
  const pitching = capturedGame?.boxScore?.pitching || [];
  assertNoContradictorySideMetadata(capturedGame);
  return {
    ...capturedGame,
    boxScore: {
      ...capturedGame?.boxScore,
      batting: batting.map((row, i) => toReconstructionRow(row, 'boxScore.batting', i)),
      pitching: pitching.map((row, i) => toReconstructionRow(row, 'boxScore.pitching', i)),
    },
  };
}

// Renames reconstructGame's scouted/opponent output vocabulary to this
// module's own/opponent vocabulary. A pure rename -- no numeric value is
// recomputed or altered.
function toEngineGameResult(legacyResult) {
  const { scouted, scoutedSide, opponent, opponentSide, ...rest } = legacyResult;
  return {
    ...rest,
    ownSide: scoutedSide,
    opponentSide,
    own: scouted,
    opponent,
  };
}

// ─── Public reconstruction orchestration ───────────────────────────────────

/**
 * Reconstructs one game's own/opponent batting + pitching totals from play-
 * by-play and validates them against the box score through the authoritative
 * reconstruction core after an explicit own/opponent boundary translation.
 *
 * @param {object} capturedGame - { meta, boxScore: { batting[], pitching[] }, plays[] }.
 *   Every boxScore.batting/pitching row must carry an explicit `own` boolean.
 * @returns {object} Same shape as reconstructGame()'s return value, with
 *   `scouted`/`scoutedSide` renamed to `own`/`ownSide`. `opponent`/
 *   `opponentSide` are unchanged (the legacy names for those were never
 *   ambiguous).
 */
function reconstructBaseballGame(capturedGame) {
  const legacyResult = reconstructGame(toReconstructionInput(capturedGame));
  return toEngineGameResult(legacyResult);
}

function codePointCompare(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableStringify(value) {
  if (value === undefined) return '{"$type":"undefined"}';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(codePointCompare).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function meaningfulIdentityPart(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized || ['unknown', '__pending__', 'tba', 'tbd', 'n/a', 'none', '-', 'null'].includes(normalized.toLowerCase())) return null;
  return normalized;
}

function firstMeaningfulIdentityPart(...values) {
  for (const value of values) {
    const normalized = meaningfulIdentityPart(value);
    if (normalized) return normalized;
  }
  return null;
}

function canonicalTextIdentityPart(value) {
  return meaningfulIdentityPart(value)?.toLowerCase() ?? null;
}

function canonicalScheduleTime(value) {
  const raw = meaningfulIdentityPart(value);
  if (!raw) return null;
  const twelveHour = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
  if (twelveHour) {
    let hour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2]);
    const second = twelveHour[3] == null ? null : Number(twelveHour[3]);
    if (hour < 1 || hour > 12 || minute > 59 || (second != null && second > 59)) return null;
    if (twelveHour[4].toLowerCase() === 'p' && hour !== 12) hour += 12;
    if (twelveHour[4].toLowerCase() === 'a' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}${second ? `:${String(second).padStart(2, '0')}` : ''}`;
  }
  const twentyFourHour = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (twentyFourHour) {
    const hour = Number(twentyFourHour[1]);
    const minute = Number(twentyFourHour[2]);
    const second = twentyFourHour[3] == null ? null : Number(twentyFourHour[3]);
    if (hour > 23 || minute > 59 || (second != null && second > 59)) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}${second ? `:${String(second).padStart(2, '0')}` : ''}`;
  }
  return raw.toLowerCase();
}

// The four ANCHOR discriminators are the only ones allowed to establish that
// a record is eligible for fallback (non-durable) identity at all -- this is
// unchanged from the prior contract. FIELD/VENUE/EVENT are real evidence for
// telling two candidates apart or proving two records are the same replay,
// but a record consisting of ONLY field/venue/event (no anchor) stays
// unresolved, exactly as before: on their own they are not "sufficiently
// discriminating" (a single field can host many simultaneous games).
const SCHEDULE_ANCHOR_KEYS = ['start', 'gameNumber', 'doubleheaderGame', 'scheduleOrdinal'];
const SCHEDULE_DISCRIMINATOR_KEYS = [...SCHEDULE_ANCHOR_KEYS, 'field', 'venue', 'event'];

function scheduleDiscriminators(meta) {
  const discriminators = {};
  const start = firstMeaningfulIdentityPart(meta.scheduledStart, meta.startTime);
  const components = {
    start: canonicalScheduleTime(start),
    gameNumber: canonicalTextIdentityPart(meta.gameNumber),
    doubleheaderGame: canonicalTextIdentityPart(meta.doubleheaderGame),
    scheduleOrdinal: canonicalTextIdentityPart(firstMeaningfulIdentityPart(meta.scheduleOrdinal, meta.ordinal)),
    field: canonicalTextIdentityPart(firstMeaningfulIdentityPart(meta.field, meta.fieldName)),
    venue: canonicalTextIdentityPart(firstMeaningfulIdentityPart(meta.venue, meta.venueName, meta.location)),
    event: canonicalTextIdentityPart(firstMeaningfulIdentityPart(meta.event, meta.eventName)),
  };
  for (const [name, value] of Object.entries(components)) if (value) discriminators[name] = value;
  return discriminators;
}

function canonicalGameIdentity(game) {
  const meta = game?.meta || {};
  const durableId = firstMeaningfulIdentityPart(meta.sourceGameId, meta.gameId, game?.sourceGameId, game?.gameId);
  if (durableId) {
    return { key: `source:${stableStringify([durableId])}`, resolved: true, method: 'sourceGameId', durable: true };
  }
  const dateRaw = firstMeaningfulIdentityPart(meta.gameDate, meta.date, game?.gameDate, game?.date);
  const date = dateRaw ? normalizeDateCandidate(dateRaw) : null;
  const home = canonicalTextIdentityPart(firstMeaningfulIdentityPart(meta.homeTeamId, meta.homeTeam, meta.homeTeamName));
  const away = canonicalTextIdentityPart(firstMeaningfulIdentityPart(meta.awayTeamId, meta.awayTeam, meta.awayTeamName));
  const discriminators = scheduleDiscriminators(meta);
  const hasScheduleSlot = SCHEDULE_ANCHOR_KEYS.some((name) => Object.prototype.hasOwnProperty.call(discriminators, name));
  if (date && home && away && hasScheduleSlot) {
    // `key` here is a PROVISIONAL, single-record identity -- useful on its
    // own (e.g. direct canonicalGameIdentity() callers, or a record with no
    // sibling in its collection) and used as a stable per-record fallback
    // when this record ends up in an ambiguous cluster (see
    // clusterFallbackIdentities below). It intentionally does NOT attempt to
    // be collision-proof against a *differently-evidenced* snapshot of the
    // same physical game -- reconcileGameCollection is what proves that,
    // using discriminators/foundational below, never this key alone.
    return {
      key: `fallback:${stableStringify({ date, home, away, discriminators })}`,
      resolved: true,
      method: 'scheduleComposite',
      durable: false,
      foundational: { date, home, away },
      discriminators,
    };
  }
  return {
    key: null,
    resolved: false,
    method: 'unresolvedScoped',
    durable: false,
    fingerprint: stableStringify(game),
    reason: 'no durable source ID or sufficiently discriminating schedule composite',
  };
}

// Compares two records' schedule discriminator sets and classifies the pair:
//   'conflict' -- they share at least one discriminator whose values differ.
//                 This is proof the records are NOT the same physical game
//                 (or the source data is contradictory); they must never be
//                 merged, regardless of any other discriminator matching.
//   'proof'    -- no discriminator conflicts, AND at least one shared
//                 discriminator has an equal value. Positive evidence the
//                 two records describe the same schedule slot.
//   'neutral'  -- no discriminator conflicts, but no discriminator is shared
//                 either. Absence of contradiction is NOT evidence of a
//                 match (two genuinely different, still-undiscriminated
//                 games would also look "neutral") -- this is the
//                 "insufficient evidence" state, and is never sufficient by
//                 itself to cluster two records together.
function relateDiscriminators(a, b) {
  let sawConflict = false;
  let sawProof = false;
  for (const discriminatorKey of SCHEDULE_DISCRIMINATOR_KEYS) {
    const left = Object.prototype.hasOwnProperty.call(a, discriminatorKey) ? a[discriminatorKey] : undefined;
    const right = Object.prototype.hasOwnProperty.call(b, discriminatorKey) ? b[discriminatorKey] : undefined;
    if (left === undefined || right === undefined) continue;
    if (left === right) sawProof = true;
    else sawConflict = true;
  }
  if (sawConflict) return 'conflict';
  if (sawProof) return 'proof';
  return 'neutral';
}

// Every pairwise relation inside an accepted clique is 'proof' (verified by
// clusterFallbackIdentities before this is ever called), so no two members
// can disagree on a shared key -- the union below is conflict-free by
// construction. This is the identity used for a MERGED cluster: it is a
// function of the cluster's accumulated evidence, not of which specific
// record happened to arrive first or last, so enrichment (a later replay
// supplying a discriminator an earlier one lacked) converges on the SAME key
// as the collection gains more complete data, instead of forking it.
function unionDiscriminators(discriminatorSets) {
  const merged = {};
  for (const set of discriminatorSets) {
    for (const [discriminatorKey, value] of Object.entries(set)) {
      if (merged[discriminatorKey] === undefined) merged[discriminatorKey] = value;
    }
  }
  return merged;
}

// Conservative candidate matching for non-durable (fallback) identities.
// `entries` are candidates whose identity already passed canonicalGameIdentity
// (durable:false, resolved:true). Partitions by the stable foundational
// evidence (canonical date/home/away), then within each partition finds
// connected components over 'proof' edges only ('neutral'/'conflict' pairs
// never connect two records). A component only becomes a merge cluster when
// it is a full clique -- every pair inside it directly proves a match. A
// non-clique component (e.g. one incomplete record that is individually
// compatible with two candidates that conflict with EACH OTHER, such as
// Game 1 and Game 2 of a doubleheader) is never merged: every member of it
// is returned as its own separate, ambiguous record instead, so an
// unproven match is never arbitrarily attached to one of several
// possibilities. Singleton components (no proof partner at all) are
// clusters of size 1 and are never "ambiguous" -- there was nothing to be
// ambiguous with.
function clusterFallbackIdentities(entries) {
  const byFoundation = new Map();
  for (const entry of entries) {
    const foundationKey = stableStringify(entry.identity.foundational);
    if (!byFoundation.has(foundationKey)) byFoundation.set(foundationKey, []);
    byFoundation.get(foundationKey).push(entry);
  }

  const clusters = [];
  for (const group of byFoundation.values()) {
    const size = group.length;
    const relation = Array.from({ length: size }, () => new Array(size).fill('neutral'));
    for (let i = 0; i < size; i += 1) {
      for (let j = i + 1; j < size; j += 1) {
        const rel = relateDiscriminators(group[i].identity.discriminators, group[j].identity.discriminators);
        relation[i][j] = rel;
        relation[j][i] = rel;
      }
    }

    const visited = new Array(size).fill(false);
    for (let start = 0; start < size; start += 1) {
      if (visited[start]) continue;
      visited[start] = true;
      const component = [start];
      const stack = [start];
      while (stack.length) {
        const current = stack.pop();
        for (let candidate = 0; candidate < size; candidate += 1) {
          if (!visited[candidate] && relation[current][candidate] === 'proof') {
            visited[candidate] = true;
            component.push(candidate);
            stack.push(candidate);
          }
        }
      }
      let isClique = true;
      for (let a = 0; a < component.length && isClique; a += 1) {
        for (let b = a + 1; b < component.length; b += 1) {
          if (relation[component[a]][component[b]] !== 'proof') { isClique = false; break; }
        }
      }
      clusters.push({
        members: component.map((index) => group[index]),
        ambiguous: component.length > 1 && !isClique,
      });
    }
  }
  return clusters;
}

function snapshotScore(game) {
  const box = game?.boxScore || {};
  const rows = ['batting', 'pitching', 'awayBatting', 'homeBatting', 'awayPitching', 'homePitching']
    .reduce((sum, key) => sum + (Array.isArray(box[key]) ? box[key].length : 0), 0);
  const plays = Array.isArray(game?.plays) ? game.plays.length : Array.isArray(game?.plays?.events) ? game.plays.events.length : 0;
  const complete = isFinalSnapshot(game) ? 1000000 : 0;
  return complete + rows * 1000 + plays;
}

function isFinalSnapshot(game) {
  return String(game?.meta?.status || '').trim().toLowerCase() === 'final' || game?.meta?.complete === true;
}

function snapshotFacts(game) {
  const meta = game?.meta || {};
  const fact = (...values) => firstMeaningfulIdentityPart(...values);
  const ownership = {};
  for (const kind of ['batting', 'pitching', 'awayBatting', 'homeBatting', 'awayPitching', 'homePitching']) {
    for (const row of game?.boxScore?.[kind] || []) {
      const side = fact(row?.TeamSide ?? row?.teamSide);
      if (side && typeof row?.own === 'boolean') ownership[side.toLowerCase()] = row.own;
    }
  }
  return {
    homeTeam: fact(meta.homeTeamId, meta.homeTeam, meta.homeTeamName)?.toLowerCase() ?? null,
    awayTeam: fact(meta.awayTeamId, meta.awayTeam, meta.awayTeamName)?.toLowerCase() ?? null,
    ownership,
    scoreUs: fact(meta.scoreUs, meta.score_us),
    scoreThem: fact(meta.scoreThem, meta.score_them),
    homeScore: fact(meta.homeScore, meta.home_score),
    awayScore: fact(meta.awayScore, meta.away_score),
  };
}

function materialSnapshotConflicts(candidates) {
  const conflicts = new Set();
  const facts = candidates.map(({ game }) => ({ final: isFinalSnapshot(game), facts: snapshotFacts(game) }));
  const compare = (field, onlyFinal = false) => {
    const values = new Set(facts.filter((entry) => !onlyFinal || entry.final).map((entry) => entry.facts[field]).filter((value) => value !== null));
    if (values.size > 1) conflicts.add(field);
  };
  compare('homeTeam');
  compare('awayTeam');
  compare('scoreUs', true);
  compare('scoreThem', true);
  compare('homeScore', true);
  compare('awayScore', true);
  const ownershipSides = new Set(facts.flatMap((entry) => Object.keys(entry.facts.ownership)));
  for (const side of ownershipSides) {
    const values = new Set(facts
      .map((entry) => entry.facts.ownership[side])
      .filter((value) => typeof value === 'boolean'));
    if (values.size > 1) conflicts.add(`ownership.${side}`);
  }
  return [...conflicts].sort(codePointCompare);
}

// Builds one reconciled output record from a group of candidates already
// PROVEN to describe the same physical game (an exact durable-key bucket, or
// a fallback clique from clusterFallbackIdentities). `keyOverride` lets a
// multi-member fallback cluster report the union-based cluster identity
// instead of whichever single member's own provisional key happened to be
// picked as `selected` -- so the same physical game converges on one key as
// its evidence accumulates across replays, rather than forking per snapshot.
// `authoritative: true` unconditionally -- every status this function can
// produce (single/deduplicated/reconciled/conflict) already represents
// EXACTLY ONE physical game's worth of evidence (candidates were proven to
// be the same game before this was ever called), so it is always safe to
// count toward summary.games / officialBatting / player totals.
function finalizeResolvedGroup(candidates, keyOverride) {
  candidates.sort((a, b) => b.score - a.score || codePointCompare(a.serial, b.serial));
  const selected = candidates[0];
  const uniqueFingerprints = [...new Set(candidates.map((candidate) => candidate.serial))];
  const conflictFields = materialSnapshotConflicts(candidates);
  const status = conflictFields.length ? 'conflict'
    : uniqueFingerprints.length === 1 ? (candidates.length > 1 ? 'deduplicated' : 'single')
      : 'reconciled';
  return {
    game: selected.game,
    identity: {
      ...selected.identity,
      ...(keyOverride ? { key: keyOverride } : {}),
      authoritative: true,
      reconciliation: {
        status,
        candidateCount: candidates.length,
        conflictFields,
        candidateFingerprints: uniqueFingerprints.sort(codePointCompare),
        selectedFingerprint: selected.serial,
      },
    },
  };
}

// Shared ordinal-disambiguation for candidates that could NOT be uniquely
// resolved to a single proven game AND ARE STILL COUNTED as one game each
// (today: only the plain 'unresolved' bucket -- no schedule evidence at all,
// so every retained record legitimately stands for its own indistinguishable
// game; see "identical unresolved records remain two logical games"). This
// is content-based (sorted by serialized fingerprint, never by original
// array position), so output is deterministic under input reversal; an
// ordinal is only appended when two candidates in the SAME scope are
// byte-identical, so identical records are never accidentally
// fingerprint-deduplicated. Ambiguous fallback candidates do NOT go through
// this -- see finalizeAmbiguousComponent below, which shares the same
// ordinal-disambiguation shape but is NEVER counted as a proven game.
function scopeUnmatchedCandidates(candidates, keyPrefix, reconciliationFor) {
  const sorted = [...candidates].sort((a, b) => codePointCompare(a.serial, b.serial));
  const ordinalByFingerprint = new Map();
  return sorted.map((candidate) => {
    const ordinal = (ordinalByFingerprint.get(candidate.serial) || 0) + 1;
    ordinalByFingerprint.set(candidate.serial, ordinal);
    return {
      game: candidate.game,
      identity: {
        ...candidate.identity,
        key: `${keyPrefix}:${stableStringify([candidate.serial, ordinal])}`,
        scopeOrdinal: ordinal,
        authoritative: true,
        reconciliation: reconciliationFor(candidate),
      },
    };
  });
}

// Builds output records for ONE ambiguous fallback component (a non-clique
// connected component from clusterFallbackIdentities: every member is
// individually compatible with at least one sibling, but the component as a
// whole is not a full clique, so no subset can be safely merged and the
// engine cannot prove how many distinct physical games it represents -- see
// clusterFallbackIdentities's own header for why a non-clique component is
// never merged).
//
// Every member is preserved EXACTLY ONCE, keyed by its own provisional
// identity plus a component-scoped ordinal (only incremented when two
// members are byte-identical) -- this disambiguates the OUTPUT KEY only; it
// is never proof that two members are the same logical game, and identical
// members are NEVER fingerprint-merged here. `componentId` is a stable,
// content-derived identifier for this specific component (never a global
// counter, never array position), so metadata for one ambiguous component
// can never be confused with a different, unrelated component's -- this is
// the fix for the metadata cross-contamination defect: reconcileGameCollection
// used to flatten every ambiguous component in the whole collection into one
// array before computing candidateCount/candidateFingerprints, so unrelated
// components (different dates, different teams, or simply a different
// disconnected component within the same foundational partition) leaked each
// other's sibling counts. Metadata here is computed from THIS component's
// `members` only.
//
// Unit contract (documented once, applies to every ambiguous component):
// `candidateCount` counts RECORDS in this component, including duplicates.
// `candidateFingerprints` lists this component's UNIQUE fingerprints,
// sorted. A duplicate inside a component is therefore visible as
// `candidateCount > candidateFingerprints.length` -- multiplicity is exposed
// via that difference, never silently absorbed by either field alone.
//
// `authoritative: false` on every member: see reconstructBaseballTeamGames
// and computeBaseballStats, which exclude these from summary.games,
// officialBatting/officialPitching, and player accumulation. This is NOT a
// fingerprint-based deduplication (a byte-identical repeat inside this
// component still produces its own separate output record above, with its
// own ordinal) -- it is a statement that NONE of this component's evidence
// is safe to count as a proven game, whether or not it happens to repeat.
function finalizeAmbiguousComponent(members) {
  const componentId = `component:${stableStringify(members.map((member) => member.serial).sort(codePointCompare))}`;
  const candidateFingerprints = [...new Set(members.map((member) => member.serial))].sort(codePointCompare);
  const sorted = [...members].sort((a, b) => codePointCompare(a.serial, b.serial));
  const ordinalByFingerprint = new Map();
  return sorted.map((candidate) => {
    const ordinal = (ordinalByFingerprint.get(candidate.serial) || 0) + 1;
    ordinalByFingerprint.set(candidate.serial, ordinal);
    return {
      game: candidate.game,
      identity: {
        ...candidate.identity,
        key: `ambiguous:${stableStringify([componentId, candidate.serial, ordinal])}`,
        scopeOrdinal: ordinal,
        authoritative: false,
        reconciliation: {
          status: 'ambiguous',
          componentId,
          candidateCount: members.length,
          conflictFields: [],
          candidateFingerprints,
          selectedFingerprint: candidate.serial,
          automaticDeduplication: false,
          reason: 'multiple schedule candidates are each individually compatible but conflict with one another; cannot uniquely reconcile',
        },
      },
    };
  });
}

function reconcileGameCollection(games) {
  const durableBuckets = new Map();
  const fallbackEntries = [];
  const unresolved = [];
  for (const game of games) {
    const identity = canonicalGameIdentity(game);
    const candidate = { game, identity, score: snapshotScore(game), serial: stableStringify(game) };
    if (!identity.resolved) {
      unresolved.push(candidate);
    } else if (identity.durable) {
      if (!durableBuckets.has(identity.key)) durableBuckets.set(identity.key, []);
      durableBuckets.get(identity.key).push(candidate);
    } else {
      fallbackEntries.push(candidate);
    }
  }

  const reconciled = [];

  // Durable identity is exact and authoritative -- unchanged from before:
  // bucket strictly by the durable source-game key.
  for (const candidates of durableBuckets.values()) {
    reconciled.push(finalizeResolvedGroup(candidates));
  }

  // Fallback identity is conservative candidate matching, not an exact key
  // lookup: cluster first (see clusterFallbackIdentities), THEN decide
  // status from EACH cluster's own members -- never pooled across clusters
  // (that pooling was the metadata cross-contamination defect; see
  // finalizeAmbiguousComponent's header).
  for (const cluster of clusterFallbackIdentities(fallbackEntries)) {
    if (cluster.ambiguous) {
      reconciled.push(...finalizeAmbiguousComponent(cluster.members));
      continue;
    }
    const keyOverride = cluster.members.length > 1
      ? `fallback:${stableStringify({
        ...cluster.members[0].identity.foundational,
        discriminators: unionDiscriminators(cluster.members.map((member) => member.identity.discriminators)),
      })}`
      : undefined;
    reconciled.push(finalizeResolvedGroup(cluster.members, keyOverride));
  }

  reconciled.push(...scopeUnmatchedCandidates(unresolved, 'unresolved', (candidate) => ({
    status: 'unresolved',
    candidateCount: 1,
    conflictFields: [],
    candidateFingerprints: [candidate.serial],
    selectedFingerprint: candidate.serial,
    automaticDeduplication: false,
  })));

  return reconciled.sort((a, b) => codePointCompare(a.identity.key, b.identity.key));
}

// Normalizes a thrown value from ambiguous-diagnostic reconstruction into a
// safe, deterministic string for a public result: an Error's `.message`
// only -- never `.stack`, which can embed filesystem paths and is not part
// of this module's public error contract -- the thrown value itself when
// it is already a plain string, or a fixed fallback for anything else. This
// codebase's domain validation only ever throws plain Error objects with a
// static-shaped, content-derived (never timestamped/random) message, so the
// non-Error/non-string branch is defensive rather than expected to fire.
function normalizeThrownValue(err) {
  if (err instanceof Error && typeof err.message === 'string') return err.message;
  if (typeof err === 'string') return err;
  return 'non-Error value thrown during ambiguous diagnostic reconstruction';
}

// Reconstructs ONE ambiguous record's own/opponent totals for diagnostic
// display, with its own narrow error boundary. This wraps ONLY
// reconstructBaseballGame(game) for a single record already classified
// ambiguous and excluded from official totals -- never the authoritative
// reconstructTeamGames() call in reconstructBaseballTeamGames below, and
// never any part of reconcileGameCollection/clusterFallbackIdentities. A
// malformed ambiguous record (missing `own`, contradictory side metadata,
// or any other domain-validation failure reconstructBaseballGame can throw)
// must not abort the whole reconstructBaseballTeamGames() call and discard
// already-computed authoritative results for proven games -- but it also
// must never be silently dropped, silently reported as successful, given
// fabricated zero stats, or shaped so a caller could mistake it for a valid
// game result: the two branches below return deliberately different shapes
// (only the success branch carries own/opponent/ownSide/etc. stat fields).
function reconstructAmbiguousDiagnostic(game, identity) {
  try {
    return {
      ...reconstructBaseballGame(game),
      identity,
      excludedFromOfficialTotals: true,
      diagnosticReconstruction: { status: 'ok' },
    };
  } catch (err) {
    return {
      identity,
      excludedFromOfficialTotals: true,
      diagnosticReconstruction: {
        status: 'error',
        code: 'AMBIGUOUS_RECONSTRUCTION_FAILED',
        message: normalizeThrownValue(err),
      },
    };
  }
}

/**
 * Reconstructs and aggregates own/opponent totals across many games for one
 * team through the authoritative reconstruction core after collection
 * reconciliation and explicit own/opponent boundary translation.
 *
 * Ambiguous fallback records (identity.authoritative === false -- see
 * reconcileGameCollection/finalizeAmbiguousComponent) are EXCLUDED from
 * `summary` (summary.games, officialBatting, officialPitching, and every
 * other aggregate reconstructTeamGames computes): the engine cannot prove
 * how many distinct physical games an ambiguous component represents, so it
 * never counts toward "official" totals, whether or not it happens to
 * repeat a byte-identical snapshot. They are NOT discarded, though -- each
 * still gets its own per-game diagnostic reconstruction, ISOLATED so a
 * malformed ambiguous record can never abort this whole call and take
 * already-computed authoritative results down with it (see
 * reconstructAmbiguousDiagnostic above); every ambiguous record appears
 * exactly once in `gameResults`, tagged `excludedFromOfficialTotals: true`
 * and `diagnosticReconstruction.status` of either 'ok' or 'error'.
 * Authoritative reconstruction is NOT wrapped this way -- a malformed
 * authoritative game still throws exactly as before this correction.
 * `summary.ambiguousInputRecords` / `summary.ambiguousComponents` /
 * `summary.excludedFromOfficialTotals` / `summary.failedAmbiguousDiagnostics`
 * / `summary.officialTotalsComplete` tell a caller when official totals are
 * incomplete and why, without needing to interpret per-record diagnostics.
 *
 * @param {string} teamId
 * @param {object[]} capturedGames
 * @returns {{ summary: object, gameResults: object[] }} `gameResults` uses
 *   this module's own/opponent vocabulary (see toEngineGameResult above).
 *   `summary`'s own/opponent-aggregate fields are passed through from
 *   reconstructTeamGames() unchanged, computed only over the authoritative
 *   subset, plus the ambiguity-disclosure fields documented above.
 */
function reconstructBaseballTeamGames(teamId, capturedGames = []) {
  if (!Array.isArray(capturedGames)) {
    throw new Error('baseball-engine: capturedGames must be an array');
  }
  const reconciled = reconcileGameCollection(capturedGames);
  const authoritative = reconciled.filter(({ identity }) => identity.authoritative !== false);
  const ambiguous = reconciled.filter(({ identity }) => identity.authoritative === false);

  // Authoritative reconstruction is intentionally NOT wrapped in a try/catch
  // here: a malformed authoritative game must continue to throw exactly as
  // it always has. Only the ambiguous/diagnostic path below gets an error
  // boundary, and only around the one call that produces diagnostic-only
  // output for records already excluded from official totals.
  const translatedGames = authoritative.map(({ game }) => toReconstructionInput(game));
  const { summary, gameResults } = reconstructTeamGames(teamId, translatedGames);

  const authoritativeResults = gameResults.map((result, index) => ({
    ...toEngineGameResult(result),
    identity: authoritative[index].identity,
    excludedFromOfficialTotals: false,
  }));
  const ambiguousResults = ambiguous.map(({ game, identity }) => reconstructAmbiguousDiagnostic(game, identity));
  const ambiguousComponents = new Set(ambiguous.map(({ identity }) => identity.reconciliation.componentId)).size;
  const failedAmbiguousDiagnostics = ambiguousResults.filter((result) => result.diagnosticReconstruction.status === 'error').length;

  return {
    summary: {
      ...summary,
      ambiguousInputRecords: ambiguous.length,
      ambiguousComponents,
      excludedFromOfficialTotals: ambiguous.length,
      failedAmbiguousDiagnostics,
      officialTotalsComplete: ambiguous.length === 0,
    },
    gameResults: [...authoritativeResults, ...ambiguousResults].sort((a, b) => codePointCompare(a.identity.key, b.identity.key)),
  };
}

// ─── Public statistics orchestration ──────────────────────────────────────

// stats-core.js's processGames() reads isOurTeam directly and
// non-inverted (own:true means isOurTeam:true, confirmed empirically in
// test/legacy-stats-engine-characterization.test.js) -- so this translation
// is a straight rename, not an inversion. It still REQUIRES the explicit
// `own` boolean rather than accepting the compatibility mode's silent
// roster-fallback (own-batter-unknown -> track all; own-pitcher-unknown ->
// treat as opponent), which this module's callers must not inherit
// unknowingly.
function toStatsEngineRow(row, rowKind, index) {
  const own = requireExplicitOwnBoolean(row, rowKind, index);
  const { own: _own, isOurTeam: _legacyIsOurTeam, ...rest } = row;
  return { ...rest, isOurTeam: own };
}

function toStatsEngineGame(capturedGame) {
  const box = capturedGame?.boxScore || {};
  assertNoContradictorySideMetadata(capturedGame);
  const mapSide = (rows, rowKind) => (Array.isArray(rows) ? rows.map((row, i) => toStatsEngineRow(row, rowKind, i)) : rows);
  return {
    ...capturedGame,
    boxScore: {
      ...box,
      batting: mapSide(box.batting, 'boxScore.batting'),
      pitching: mapSide(box.pitching, 'boxScore.pitching'),
      awayBatting: mapSide(box.awayBatting, 'boxScore.awayBatting'),
      homeBatting: mapSide(box.homeBatting, 'boxScore.homeBatting'),
      awayPitching: mapSide(box.awayPitching, 'boxScore.awayPitching'),
      homePitching: mapSide(box.homePitching, 'boxScore.homePitching'),
    },
  };
}

/**
 * Computes advanced player statistics through the authoritative stats core.
 * Durable player IDs control accumulation whenever available; unresolved
 * identities remain separate and carry explicit context.
 *
 * Ambiguous fallback records (identity.authoritative === false -- see
 * reconcileGameCollection/finalizeAmbiguousComponent) are EXCLUDED from
 * player accumulation: the engine cannot prove how many distinct physical
 * games an ambiguous component represents, so none of its batting/pitching/
 * fielding/game-count contributions are safe to attribute to a player,
 * whether or not the component happens to contain a byte-identical repeat.
 * They are NOT discarded from the response, though -- `gameIdentities`
 * still lists every input record exactly once (including ambiguous ones),
 * so a caller can see the full reconciliation evidence. `ambiguousInputRecords`
 * / `excludedFromOfficialTotals` / `officialTotalsComplete` report how many
 * records were withheld from accumulation for this reason, using the same
 * field names and semantics as reconstructBaseballTeamGames's `summary`.
 * computeBaseballStats never reconstructs ambiguous records the way
 * reconstructBaseballTeamGames does for diagnostic display, so it has no
 * equivalent of that function's per-record diagnostic-reconstruction error
 * boundary to expose here.
 *
 * @param {object[]} capturedGames - Games whose box-score rows carry an
 *   explicit own boolean and may carry a durable playerId.
 * @returns {object} Own/opponent batter and pitcher maps, unresolved maps,
 *   game reconciliation provenance (all input records), ambiguity-exclusion
 *   counts, and unattributed error counts.
 */
function computeBaseballStats(capturedGames = []) {
  if (!Array.isArray(capturedGames)) {
    throw new Error('baseball-engine: capturedGames must be an array');
  }
  const reconciled = reconcileGameCollection(capturedGames);
  const authoritative = reconciled.filter(({ identity }) => identity.authoritative !== false);
  const translatedGames = authoritative.map(({ game, identity }) => toStatsEngineGame({
    ...game,
    meta: { ...(game?.meta || {}), engineGameIdentity: identity },
  }));
  const legacyResult = processGames(translatedGames);
  const ambiguousInputRecords = reconciled.length - authoritative.length;
  return {
    ownBatters: legacyResult.players,
    opponentBatters: legacyResult.opponentBatters,
    ownPitchers: legacyResult.ourPitchers,
    opponentPitchers: legacyResult.pitchers,
    unresolvedBatters: legacyResult.unresolvedBatters,
    unresolvedPitchers: legacyResult.unresolvedPitchers,
    gameIdentities: reconciled.map(({ identity }) => identity),
    ambiguousInputRecords,
    excludedFromOfficialTotals: ambiguousInputRecords,
    officialTotalsComplete: ambiguousInputRecords === 0,
    unattributedErrors: {
      ownSide: legacyResult.unattributedErrors.ourSide,
      opponentSide: legacyResult.unattributedErrors.opponentSide,
    },
  };
}

// ─── Public normalization orchestration ───────────────────────────────────

/**
 * Converts raw GameChanger-scraped JSON into normalized batting/pitching/
 * play rows through the authoritative normalization core,
 * requiring `ownSide` as an explicit argument (never read from
 * `rawJson.meta.ourSide` implicitly) so the caller's own/opponent intent is
 * always visible at this module's boundary, and adds an explicit `own`
 * boolean on each returned row, replacing the core compatibility `isOurTeam`
 * 1/0/null field entirely -- `own` is this module's sole public ownership
 * field across all four operations; normalizer.js's legacy field name is
 * never exposed, for the same reason reconstructBaseballGame/
 * computeBaseballStats never expose `is_our_team`/`isOurTeam` either (see
 * test/baseball-engine-explicit-side-contract.test.js).
 *
 * The legacy normalizer's isOurTeam semantics were empirically confirmed
 * (test/legacy-normalizer-own-opponent-characterization.test.js) to already
 * be non-inverted (isOurTeam:1 means "matches ownSide"), unlike
 * reconstruct-core's compatibility contract -- this function exists for contract consistency and
 * to make `ownSide` mandatory and explicit, not to fix an inversion bug.
 *
 * @param {object} rawJson - Raw scraped JSON ({ meta, boxScore, plays }).
 * @param {string} teamId
 * @param {'home'|'away'} ownSide - Which venue side is the caller's own
 *   team for this specific game. Required; never defaulted or guessed.
 * @param {{ invertOwnership?: boolean, referenceYear?: number, capturedAt?: string }} [options]
 * @returns {{ game: object, battingLines: object[], pitchingLines: object[], playEvents: object[] }}
 */
function normalizeBaseballGame(rawJson, teamId, ownSide, options = {}) {
  if (ownSide !== 'home' && ownSide !== 'away') {
    throw new Error('baseball-engine: ownSide is required and must be exactly "home" or "away"');
  }
  if (!rawJson || typeof rawJson !== 'object') {
    throw new Error('baseball-engine: rawJson must be an object');
  }
  const rawJsonWithExplicitSide = {
    ...rawJson,
    meta: { ...(rawJson.meta || {}), ourSide: ownSide },
  };
  const result = normalizeGameData(rawJsonWithExplicitSide, teamId, {
    invertTeamSide: options.invertOwnership === true,
    referenceYear: options.referenceYear,
    capturedAt: options.capturedAt,
  });
  // Replaces normalizer.js's legacy isOurTeam field with this module's own
  // `own` boolean -- own is the ONLY public ownership field this module
  // ever returns, on any of its four operations.
  const addOwn = (row) => {
    const { isOurTeam, ...rest } = row;
    return { ...rest, own: isOurTeam === 1 ? true : isOurTeam === 0 ? false : null };
  };
  // capturedAt is caller-supplied audit metadata, not an engine result.
  // The core never creates it from the wall clock and this public contract
  // deliberately omits it even when a caller supplied one.
  const { capturedAt: _capturedAt, ...gameWithoutCapturedAt } = result.game;
  return {
    game: gameWithoutCapturedAt,
    battingLines: result.battingLines.map(addOwn),
    pitchingLines: result.pitchingLines.map(addOwn),
    playEvents: result.playEvents,
  };
}

module.exports = {
  reconstructBaseballGame,
  reconstructBaseballTeamGames,
  computeBaseballStats,
  normalizeBaseballGame,
  // Exposed for the dependency-boundary/unit tests only -- not part of the
  // stable public contract other modules should depend on.
  _internals: {
    toReconstructionInput, toStatsEngineGame, requireExplicitOwnBoolean, canonicalGameIdentity,
    reconcileGameCollection, stableStringify, clusterFallbackIdentities, relateDiscriminators, unionDiscriminators,
    finalizeAmbiguousComponent, normalizeThrownValue,
  },
};
