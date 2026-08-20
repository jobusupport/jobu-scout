'use strict';

// Trusted server-side integration boundary between the pure Slice 2B engine
// and the Slice 2C atomic persistence RPC. This module is deliberately pure:
// no database client, network, filesystem, environment, or wall-clock reads.

const crypto = require('node:crypto');
const {
  reconstructBaseballTeamGames,
  computeBaseballStats,
} = require('./engine/baseball-engine');
const {
  importError,
  requireUuid,
  sanitizeJsonPayload,
} = require('./high-school-import-sanitizer');

const HS_BASEBALL_ENGINE_VERSION = 'hs-baseball-engine/v1';
const MAX_HS_ENGINE_COLLECTION_BYTES = 4_194_304;

function codePointCompare(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(codePointCompare).map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const serialized = typeof value === 'string' ? value : canonicalSerialize(value);
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function payloadTooLargeError() {
  return importError(
    'HS_ENGINE_COLLECTION_TOO_LARGE',
    'The complete High School engine collection exceeds the 4 MiB publication limit.',
    { statusCode: 413, context: { maximumBytes: MAX_HS_ENGINE_COLLECTION_BYTES } },
  );
}

function assertCollectionPayloadWithinLimit(serializedDto) {
  if (typeof serializedDto !== 'string') {
    throw importError('INVALID_ENGINE_COLLECTION', 'The engine collection must be serialized before payload measurement.', { statusCode: 500 });
  }
  const byteLength = Buffer.byteLength(serializedDto, 'utf8');
  if (byteLength > MAX_HS_ENGINE_COLLECTION_BYTES) throw payloadTooLargeError();
  return byteLength;
}

function requireContext(context) {
  if (!context || typeof context !== 'object') {
    throw importError('INVALID_ENGINE_COLLECTION_CONTEXT', 'A trusted engine collection context is required.', { statusCode: 400 });
  }
  const result = {
    orgId: requireUuid(context.orgId, 'orgId'),
    programId: requireUuid(context.programId, 'programId'),
    teamId: requireUuid(context.teamId, 'teamId'),
    seasonId: requireUuid(context.seasonId, 'seasonId'),
    importRunId: requireUuid(context.importRunId, 'importRunId'),
    sourceProvider: context.sourceProvider,
  };
  if (result.sourceProvider !== 'gamechanger') {
    throw importError('INVALID_FIELD', 'sourceProvider must be gamechanger', { statusCode: 400, context: { field: 'sourceProvider' } });
  }
  return result;
}

// Slice 2D. An opponent collection's context deliberately carries NO teamId and
// NO importRunId: both of those identify own-team records, and an opponent
// subject must never borrow one. The run identifier moves onto the subject
// instead, where it identifies the opponent-side import run.
function requireOpponentContext(context) {
  if (!context || typeof context !== 'object') {
    throw importError('INVALID_ENGINE_COLLECTION_CONTEXT', 'A trusted engine collection context is required.', { statusCode: 400 });
  }
  if (context.teamId !== undefined && context.teamId !== null) {
    throw importError('AMBIGUOUS_COLLECTION_SUBJECT', 'An opponent collection context must not carry an own-team teamId.', {
      statusCode: 400, context: { field: 'context.teamId' },
    });
  }
  if (context.importRunId !== undefined && context.importRunId !== null) {
    throw importError('AMBIGUOUS_COLLECTION_SUBJECT', 'An opponent collection context must not carry an own-team importRunId.', {
      statusCode: 400, context: { field: 'context.importRunId' },
    });
  }
  const result = {
    orgId: requireUuid(context.orgId, 'orgId'),
    programId: requireUuid(context.programId, 'programId'),
    seasonId: requireUuid(context.seasonId, 'seasonId'),
    sourceProvider: context.sourceProvider,
  };
  if (result.sourceProvider !== 'gamechanger') {
    throw importError('INVALID_FIELD', 'sourceProvider must be gamechanger', { statusCode: 400, context: { field: 'sourceProvider' } });
  }
  return result;
}

function requireOpponentSubject(subject) {
  if (!subject || typeof subject !== 'object') {
    throw importError('MISSING_COLLECTION_SUBJECT', 'An opponent collection requires an explicit subject.', { statusCode: 400 });
  }
  if (subject.teamId !== undefined && subject.teamId !== null) {
    throw importError('AMBIGUOUS_COLLECTION_SUBJECT', 'A collection subject carries either teamId or opponentTeamId, never both.', {
      statusCode: 400, context: { field: 'subject.teamId' },
    });
  }
  return {
    kind: 'opponent_team',
    opponentTeamId: requireUuid(subject.opponentTeamId, 'opponentTeamId'),
    sourceTeamId: requireUuid(subject.sourceTeamId, 'sourceTeamId'),
    importRunId: requireUuid(subject.importRunId, 'importRunId'),
  };
}

// Scheduled, in-progress, final, postponed, cancelled and suspended stay
// distinguishable all the way from the source through to the canonical game
// row. An unrecognised status is rejected rather than coerced to 'unknown',
// because silently downgrading a status the source actually reported would
// let a completed game be published as if its state were merely unobserved.
const OPPONENT_GAME_STATUSES = new Set([
  'scheduled', 'in_progress', 'final', 'postponed', 'cancelled', 'suspended', 'unknown',
]);

// The identity methods the publication RPC can actually match an opponent
// observation against. Anything else ('unresolvedScoped') has no durable
// reference and no sufficient schedule composite, so it can only ever create a
// new canonical row rather than recognise an existing one.
const APPROVED_OPPONENT_IDENTITY_METHODS = new Set(['sourceGameId', 'scheduleComposite']);

// Strips the parts of a captured game that say WHEN or HOW it was read rather
// than WHAT the source reported, so identity is decided by the source's claim
// alone. `capturedAt` is the capture time. `rawDateText` is the literal date
// string the page rendered: it is kept on the observation as evidence, but
// re-typesetting "Apr 11, 2026" as "Saturday, April 11, 2026" is a cosmetic
// change to the same day, and hashing it would mint a brand-new generation for
// no semantic difference. The RESOLVED date and the resolution STATUS both stay
// in, because those are what the source actually said and what decides whether
// it may be published.
//
// Used only by the opponent mapper; the own-team collection contract is
// unchanged and never carries these fields.
function withoutCaptureTime(game) {
  const { capturedAt: _capturedAt, rawDateText: _rawDateText, ...meta } = game?.meta || {};
  return { ...game, meta };
}

function opponentGameStatusFor(game, index) {
  const raw = meaningful(game?.meta?.gameStatus);
  if (!raw) return 'unknown';
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (!OPPONENT_GAME_STATUSES.has(normalized)) {
    throw importError('INVALID_GAME_STATUS', `capturedGames[${index}].meta.gameStatus is not a recognised game status`, {
      statusCode: 400, context: { field: `capturedGames[${index}].meta.gameStatus` },
    });
  }
  return normalized;
}

function meaningful(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function isUrlIdentity(value) {
  const normalized = meaningful(value);
  return normalized ? /^(?:https?:)?\/\//i.test(normalized) : false;
}

function requireCapturedAt(game, index) {
  const value = meaningful(game?.meta?.capturedAt ?? game?.capturedAt);
  if (!value || Number.isNaN(Date.parse(value))) {
    throw importError('MISSING_CAPTURE_TIMESTAMP', `capturedGames[${index}] requires an explicit valid capturedAt timestamp`, {
      statusCode: 400,
      context: { field: `capturedGames[${index}].meta.capturedAt` },
    });
  }
  return new Date(value).toISOString();
}

function normalizeRosterMemberships(rosterMemberships) {
  if (!Array.isArray(rosterMemberships)) {
    throw importError('INVALID_FIELD', 'rosterMemberships must be an array', { statusCode: 400, context: { field: 'rosterMemberships' } });
  }
  const byPlayerId = new Map();
  const byProviderId = new Map();
  for (const [index, membership] of rosterMemberships.entries()) {
    const playerId = requireUuid(membership?.playerId ?? membership?.id, `rosterMemberships[${index}].playerId`);
    const providerId = meaningful(membership?.gcExternalPlayerId ?? membership?.gc_external_player_id);
    byPlayerId.set(playerId, playerId);
    if (providerId) {
      if (!byProviderId.has(providerId)) byProviderId.set(providerId, []);
      byProviderId.get(providerId).push(playerId);
    }
  }
  return { byPlayerId, byProviderId };
}

function explicitOwn(row, path) {
  if (typeof row?.own === 'boolean') return row.own;
  if (typeof row?.isHighSchoolTeam === 'boolean') return row.isHighSchoolTeam;
  throw importError('MISSING_TEAM_OWNERSHIP', `${path} requires an explicit own boolean`, {
    statusCode: 400,
    context: { field: path },
  });
}

function mapOwnPlayerId(row, own, roster) {
  const suppliedInternalId = meaningful(row?.hsPlayerId ?? row?.hs_player_id);
  const providerId = meaningful(row?.playerId ?? row?.player_id);
  if (!own) return providerId;
  if (suppliedInternalId && roster.byPlayerId.has(suppliedInternalId)) return suppliedInternalId;
  const matches = providerId ? roster.byProviderId.get(providerId) || [] : [];
  return matches.length === 1 ? matches[0] : providerId;
}

function adaptGame(game, gameIndex, roster) {
  const ownSide = game?.meta?.ourSide;
  if (ownSide !== 'home' && ownSide !== 'away') {
    throw importError('MISSING_TEAM_OWNED_SIDE', `capturedGames[${gameIndex}].meta.ourSide must be exactly home or away`, {
      statusCode: 400,
      context: { field: `capturedGames[${gameIndex}].meta.ourSide` },
    });
  }
  const capturedAt = requireCapturedAt(game, gameIndex);
  const box = game?.boxScore || {};
  const rowFamilies = [
    'batting', 'pitching', 'fielding',
    'awayBatting', 'homeBatting', 'awayPitching', 'homePitching',
    'awayFielding', 'homeFielding',
  ];
  const adaptedBox = { ...box };
  const ownProviderIds = new Map();
  const opponentProviderIds = new Set();
  for (const family of rowFamilies) {
    if (box[family] === undefined) continue;
    if (!Array.isArray(box[family])) {
      throw importError('INVALID_FIELD', `capturedGames[${gameIndex}].boxScore.${family} must be an array`, { statusCode: 400 });
    }
    adaptedBox[family] = box[family].map((row, rowIndex) => {
      const path = `capturedGames[${gameIndex}].boxScore.${family}[${rowIndex}]`;
      const own = explicitOwn(row, path);
      const providerId = meaningful(row?.playerId ?? row?.player_id);
      const mappedId = mapOwnPlayerId(row, own, roster);
      if (providerId) {
        if (own && mappedId && mappedId !== providerId) ownProviderIds.set(providerId, mappedId);
        if (!own) opponentProviderIds.add(providerId);
      }
      const {
        isHighSchoolTeam: _isHighSchoolTeam,
        hsPlayerId: _hsPlayerId,
        hs_player_id: _hsPlayerIdSnake,
        player_id: _playerIdSnake,
        ...rest
      } = row;
      return { ...rest, ...(mappedId ? { playerId: mappedId } : {}), own };
    });
  }
  const safeOwnProviderIds = new Map([...ownProviderIds].filter(([providerId]) => !opponentProviderIds.has(providerId)));
  const plays = (game?.plays || []).map((play) => {
    const mapped = { ...play };
    for (const key of ['batterId', 'pitcherId', 'fielderId', 'runnerId']) {
      const providerId = meaningful(play?.[key]);
      if (providerId && safeOwnProviderIds.has(providerId)) mapped[key] = safeOwnProviderIds.get(providerId);
    }
    return mapped;
  });
  const adaptedMeta = { ...(game?.meta || {}), ourSide: ownSide, capturedAt };
  for (const key of ['sourceGameId', 'gameId']) {
    if (isUrlIdentity(adaptedMeta[key])) delete adaptedMeta[key];
  }
  const { sourceGameId: topSourceGameId, gameId: topGameId, ...gameRest } = game;
  return {
    ...gameRest,
    ...(!isUrlIdentity(topSourceGameId) && meaningful(topSourceGameId) ? { sourceGameId: topSourceGameId } : {}),
    ...(!isUrlIdentity(topGameId) && meaningful(topGameId) ? { gameId: topGameId } : {}),
    meta: adaptedMeta,
    boxScore: adaptedBox,
    plays,
  };
}

function sourceGameRef(game) {
  // URLs are evidence locations, never durable game identity.
  const candidate = meaningful(game?.meta?.sourceGameId ?? game?.sourceGameId ?? game?.meta?.gameId ?? game?.gameId);
  return isUrlIdentity(candidate) ? null : candidate;
}

function sourceGameUrl(game) {
  return meaningful(game?.meta?.sourceGameUrl ?? game?.sourceGameUrl ?? game?.meta?.url ?? game?.url);
}

function digestReconciliation(reconciliation = {}) {
  return {
    status: reconciliation.status,
    candidateCount: reconciliation.candidateCount,
    conflictFields: [...(reconciliation.conflictFields || [])].sort(codePointCompare),
    candidateFingerprintDigests: [...new Set((reconciliation.candidateFingerprints || []).map(sha256))].sort(codePointCompare),
    selectedFingerprintDigest: reconciliation.selectedFingerprint ? sha256(reconciliation.selectedFingerprint) : null,
    automaticDeduplication: reconciliation.automaticDeduplication ?? null,
    reason: meaningful(reconciliation.reason),
  };
}

function gameResultForFingerprint(gameResults, fingerprint, occurrenceByFingerprint) {
  const matches = gameResults.filter((result) => result.identity?.reconciliation?.candidateFingerprints?.includes(fingerprint));
  if (!matches.length) {
    throw importError('ENGINE_IDENTITY_CORRELATION_FAILED', 'The engine result could not be correlated to a captured observation.', { statusCode: 500 });
  }
  if (matches.length === 1) return matches[0];
  const ordinal = occurrenceByFingerprint.get(fingerprint) || 0;
  occurrenceByFingerprint.set(fingerprint, ordinal + 1);
  return matches[Math.min(ordinal, matches.length - 1)];
}

function validationFor(result, summary) {
  const own = result.own || {};
  const diagnostic = result.diagnosticReconstruction || { status: 'not_run' };
  if (diagnostic.status === 'error') {
    return {
      hasBoxScore: false,
      hasPlayByPlay: false,
      ownSide: null,
      opponentSide: null,
      boxScoreBatting: {},
      boxScorePitching: {},
      reconstructedBatting: {},
      reconstructedPitching: {},
      deltas: {},
      battingMatchesBox: false,
      quality: {},
      warnings: [],
      confidence: 'low',
      status: 'failed',
    };
  }
  const matches = own.validation?.battingMatchesBox === true;
  return {
    hasBoxScore: result.hasBoxScore === true,
    hasPlayByPlay: result.hasPlayByPlay === true,
    ownSide: result.ownSide ?? null,
    opponentSide: result.opponentSide ?? null,
    boxScoreBatting: own.boxBatting || {},
    boxScorePitching: own.boxPitching || {},
    reconstructedBatting: own.reconstructedBatting || {},
    reconstructedPitching: own.reconstructedPitchingDefense || {},
    deltas: own.validation?.battingDelta || {},
    battingMatchesBox: matches,
    quality: {
      parsedPlateAppearances: result.parsedPlateAppearances || 0,
      skippedPlays: result.skippedPlays || 0,
      unmatchedBatters: result.unmatchedBatters || 0,
      unmatchedPitchers: result.unmatchedPitchers || 0,
    },
    warnings: result.warnings || [],
    confidence: result.hasPlayByPlay ? (matches ? 'high' : 'medium') : (summary.confidence || 'low'),
    status: result.hasPlayByPlay ? (matches ? 'validated' : 'mismatched') : 'pending',
  };
}

function opponentNameFor(game) {
  const meta = game.meta || {};
  return meaningful(meta.opponentName ?? (meta.ourSide === 'home' ? meta.awayTeamName ?? meta.awayTeam : meta.homeTeamName ?? meta.homeTeam));
}

// `includeGameStatus` is set only for an opponent collection. An own-team
// observation is emitted byte-for-byte as Slice 2C emitted it, so own-team
// content hashes and idempotency keys are unaffected by this slice.
function observationsFor(games, rawGames, reconstruction, engineVersion, includeGameStatus = false) {
  const occurrenceByFingerprint = new Map();
  const observationOrdinalByFingerprint = new Map();
  // `fingerprint` must stay exactly as the engine computed it, because it is
  // what correlates an observation back to its engine result. `stableKey` is a
  // separate, capture-time-free projection used only to derive the observation
  // key, so an unchanged opponent re-scrape produces the same observation keys
  // instead of a brand-new set every night. For an own-team collection the two
  // are identical, so Slice 2C observation keys are unchanged.
  const entries = games.map((game, index) => ({
    game,
    rawGame: rawGames[index],
    fingerprint: canonicalSerialize(game),
    stableKey: includeGameStatus ? canonicalSerialize(withoutCaptureTime(game)) : canonicalSerialize(game),
  }));
  entries.sort((a, b) => codePointCompare(a.stableKey, b.stableKey) || codePointCompare(a.fingerprint, b.fingerprint));
  return entries.map(({ game, rawGame, fingerprint, stableKey }) => {
    const ordinal = (observationOrdinalByFingerprint.get(stableKey) || 0) + 1;
    observationOrdinalByFingerprint.set(stableKey, ordinal);
    const result = gameResultForFingerprint(reconstruction.gameResults, fingerprint, occurrenceByFingerprint);
    const identity = result.identity;
    const reconciliation = identity.reconciliation || {};
    const capturedAt = game.meta.capturedAt;
    const sourceRef = sourceGameRef(game);
    const snapshots = [
      { kind: 'box_score', sourceRef, capturedAt, payload: rawGame.boxScore || {}, integrityHash: sha256(rawGame.boxScore || {}) },
      { kind: 'play_by_play', sourceRef, capturedAt, payload: rawGame.plays || [], integrityHash: sha256(rawGame.plays || []) },
    ];
    const observationKey = sha256(canonicalSerialize([stableKey, ordinal]));
    return {
      observationKey,
      sourceGameRef: sourceRef,
      sourceGameUrl: sourceGameUrl(game),
      opponentName: opponentNameFor(game),
      gameDate: meaningful(game.meta?.gameDate ?? game.meta?.date),
      identityMethod: identity.method,
      identityStatus: reconciliation.status,
      identityDigest: sha256(identity.key),
      foundationalDigest: identity.foundational ? sha256(identity.foundational) : null,
      discriminators: identity.discriminators || {},
      authoritative: identity.authoritative !== false,
      excludedFromOfficialTotals: result.excludedFromOfficialTotals === true,
      ambiguityComponentDigest: reconciliation.componentId ? sha256(reconciliation.componentId) : null,
      conflictFields: [...(reconciliation.conflictFields || [])].sort(codePointCompare),
      // `diagnostics` is stored in full on the run-game row and is projected out
      // of the content hash, which makes it the right home for date provenance:
      // the evidence survives for review without a cosmetic re-render of the
      // source date being able to mint a generation.
      diagnostics: {
        reconciliation: digestReconciliation(reconciliation),
        ...(includeGameStatus ? {
          dateResolution: {
            status: meaningful(game.meta?.dateResolutionStatus),
            sourceKind: meaningful(game.meta?.dateSourceKind),
            rawText: meaningful(game.meta?.rawDateText),
          },
        } : {}),
      },
      diagnostic: result.diagnosticReconstruction || { status: 'not_run', code: null },
      validation: validationFor(result, reconstruction.summary),
      snapshots,
      engineVersion,
      ...(includeGameStatus ? { gameStatus: meaningful(game.meta?.gameStatus) || 'unknown' } : {}),
    };
  }).sort((a, b) => codePointCompare(a.observationKey, b.observationKey));
}

function canonicalAndNoncanonicalPlayers(stats, roster) {
  const canonicalPlayers = [];
  const noncanonicalPlayers = [];
  const addBucket = (bucket, role, side, canonicalEligible) => {
    for (const key of Object.keys(bucket || {}).sort(codePointCompare)) {
      const result = bucket[key];
      if (canonicalEligible && roster.byPlayerId.has(key)) {
        canonicalPlayers.push({ playerId: key, role, stats: result });
      } else {
        const identity = result?.identity || {};
        const contextualSide = /:own:(?:batter|pitcher|fielder)$/.test(identity.context || '') ? 'own'
          : /:opponent:(?:batter|pitcher|fielder)$/.test(identity.context || '') ? 'opponent'
            : null;
        const resolvedSide = side === 'unknown' ? (identity.side || contextualSide || 'unknown') : side;
        noncanonicalPlayers.push({
          side: resolvedSide === 'own' || resolvedSide === 'opponent' ? resolvedSide : 'unknown',
          role,
          displayName: meaningful(result?.name ?? identity.displayName),
          providerPlayerId: meaningful(identity.playerId ?? result?.playerId ?? (canonicalEligible ? key : null)),
          engineIdentityKey: String(key).length <= 512 ? String(key) : `sha256:${sha256(String(key))}`,
          reason: meaningful(identity.reason) || (side === 'opponent'
            ? 'opponent result is intentionally noncanonical'
            : 'verified canonical roster mapping unavailable'),
          isOpponent: resolvedSide === 'opponent',
          stats: result,
        });
      }
    }
  };
  addBucket(stats.ownBatters, 'batter', 'own', true);
  addBucket(stats.ownPitchers, 'pitcher', 'own', true);
  addBucket(stats.opponentBatters, 'batter', 'opponent', false);
  addBucket(stats.opponentPitchers, 'pitcher', 'opponent', false);
  addBucket(stats.unresolvedBatters, 'batter', 'unknown', false);
  addBucket(stats.unresolvedPitchers, 'pitcher', 'unknown', false);
  canonicalPlayers.sort((a, b) => codePointCompare(`${a.playerId}:${a.role}`, `${b.playerId}:${b.role}`));
  noncanonicalPlayers.sort((a, b) => codePointCompare(`${a.engineIdentityKey}:${a.role}:${a.side}`, `${b.engineIdentityKey}:${b.role}:${b.side}`));
  return { canonicalPlayers, noncanonicalPlayers };
}

// `hashBase` defaults to the full DTO body, which is exactly what Slice 2C
// hashed, so own-team content hashes are unchanged. An opponent collection
// passes a projection that omits run-scoped provenance: re-ingesting an
// unchanged opponent schedule on a NEW import run must recognise the existing
// generation rather than report a content mismatch, so the run identifier is
// carried in the DTO for the RPC but deliberately kept out of the content hash.
function finalizeDto(base, hashBase = base) {
  const contentHash = sha256(hashBase);
  let payloadBytes = 0;
  let dto;
  let serializedDto;
  do {
    dto = { ...base, contentHash, payloadBytes };
    serializedDto = canonicalSerialize(dto);
    const measured = Buffer.byteLength(serializedDto, 'utf8');
    if (measured === payloadBytes) break;
    payloadBytes = measured;
  } while (true);
  assertCollectionPayloadWithinLimit(serializedDto);
  return { dto, serializedDto, payloadBytes };
}

function mapHighSchoolEngineCollection({ context, capturedGames, rosterMemberships }) {
  const trustedContext = requireContext(context);
  const safeGames = sanitizeJsonPayload(capturedGames, 'capturedGames');
  const safeRoster = sanitizeJsonPayload(rosterMemberships, 'rosterMemberships');
  if (!Array.isArray(safeGames)) {
    throw importError('INVALID_FIELD', 'capturedGames must be an array', { statusCode: 400, context: { field: 'capturedGames' } });
  }
  const roster = normalizeRosterMemberships(safeRoster);
  const games = safeGames.map((game, index) => adaptGame(game, index, roster));
  const reconstruction = reconstructBaseballTeamGames(trustedContext.teamId, games);
  const statistics = computeBaseballStats(games);
  const observations = observationsFor(games, safeGames, reconstruction, HS_BASEBALL_ENGINE_VERSION);
  const { canonicalPlayers, noncanonicalPlayers } = canonicalAndNoncanonicalPlayers(statistics, roster);
  // A season is a set of observations, not an arrival-order sequence.
  const rosterIdentityEvidence = [...roster.byProviderId.entries()]
    .map(([providerId, playerIds]) => [providerId, [...playerIds].sort(codePointCompare)])
    .sort((a, b) => codePointCompare(a[0], b[0]));
  const inputSetHash = sha256({
    games: safeGames.map(canonicalSerialize).sort(codePointCompare),
    rosterPlayerIds: [...roster.byPlayerId.keys()].sort(codePointCompare),
    rosterIdentityEvidence,
  });
  const base = {
    complete: true,
    context: trustedContext,
    engineVersion: HS_BASEBALL_ENGINE_VERSION,
    inputSetHash,
    observations,
    snapshotCount: observations.reduce((total, observation) => total + observation.snapshots.length, 0),
    canonicalPlayers,
    noncanonicalPlayers,
    teamTotals: reconstruction.summary,
    officialTotalsComplete: reconstruction.summary.officialTotalsComplete === true && statistics.officialTotalsComplete === true,
  };
  return finalizeDto(base);
}

// Slice 2D. Maps one opponent-team collection into the same DTO the widened
// persist_hs_engine_collection RPC consumes, differing from the own-team mapper
// in exactly three ways:
//
//   1. The subject is an hs_opponent_teams id, carried in the discriminated
//      `subject` block rather than in `context.teamId`.
//   2. There is no roster, so `canonicalPlayers` is always empty and every
//      player line the engine produces is preserved as a noncanonical
//      observation. HS 2D never invents opponent roster membership -- resolving
//      opponent players to durable identities is HS 2F's job.
//   3. Each observation carries the source-reported game status, so a scheduled
//      or postponed game is never published as a completed statistical result.
//
// The reconstruction and statistics engines are the SAME characterized Slice 2B
// components the own-team path uses; no second statistics algorithm exists.
// `reconstructBaseballTeamGames`'s first argument is an opaque subject label, so
// passing the opponent team id reuses the engine unchanged.
function mapHighSchoolOpponentEngineCollection({ context, subject, capturedGames }) {
  const trustedContext = requireOpponentContext(context);
  const trustedSubject = requireOpponentSubject(subject);
  const safeGames = sanitizeJsonPayload(capturedGames, 'capturedGames');
  if (!Array.isArray(safeGames)) {
    throw importError('INVALID_FIELD', 'capturedGames must be an array', { statusCode: 400, context: { field: 'capturedGames' } });
  }
  // Validated before any engine work so an unrecognised status fails fast and
  // identically regardless of how far reconstruction would otherwise get.
  const gameStatuses = safeGames.map((game, index) => opponentGameStatusFor(game, index));
  const roster = normalizeRosterMemberships([]);
  const games = safeGames.map((game, index) => {
    const adapted = adaptGame(game, index, roster);
    return { ...adapted, meta: { ...adapted.meta, gameStatus: gameStatuses[index] } };
  });
  const reconstruction = reconstructBaseballTeamGames(trustedSubject.opponentTeamId, games);
  const statistics = computeBaseballStats(games);
  const observations = observationsFor(games, safeGames, reconstruction, HS_BASEBALL_ENGINE_VERSION, true);
  const { canonicalPlayers, noncanonicalPlayers } = canonicalAndNoncanonicalPlayers(statistics, roster);
  if (canonicalPlayers.length > 0) {
    throw importError('OPPONENT_COLLECTION_FORBIDS_CANONICAL_PLAYERS',
      'An opponent collection cannot carry canonical players.', { statusCode: 500 });
  }

  // ── Nothing unresolvable may become a published opponent game ─────────
  //
  // An observation the engine could not resolve has neither a durable source
  // reference nor a sufficient schedule composite, so the publication RPC has
  // nothing to match it against: it would insert a BRAND NEW canonical game row
  // on every single run, quietly accumulating phantom opponent games that
  // inflate a coach's schedule and can never be reconciled back together.
  // Capturing such a row as raw evidence is fine; publishing it is not.
  const unresolved = observations
    .map((observation, index) => ({ index, method: observation.identityMethod, ref: observation.sourceGameRef }))
    .filter(({ method }) => !APPROVED_OPPONENT_IDENTITY_METHODS.has(method));
  if (unresolved.length > 0) {
    throw importError('OPPONENT_IDENTITY_UNRESOLVED',
      'An opponent observation has no durable source identity and no sufficient schedule composite, '
      + 'so it cannot be published as a canonical game; manual reconciliation is required.', {
        statusCode: 422,
        context: {
          unresolvedObservations: unresolved.map(({ index, method, ref }) => ({
            observationIndex: index, identityMethod: method, sourceGameRef: ref,
          })),
        },
      });
  }

  // ── Nor may a date the source did not establish ──────────────────────
  //
  // The collector already refuses to reach here with an unsafe date. This is the
  // same rule restated at the mapping boundary so a DIRECT caller assembling its
  // own DTO cannot skip it, and it is restated a third time inside the
  // publication RPC so a privileged caller cannot skip this one either.
  const unsafeDates = observations
    .map((observation, index) => ({
      index,
      ref: observation.sourceGameRef,
      status: observation.diagnostics?.dateResolution?.status || null,
      gameDate: observation.gameDate,
      gameStatus: observation.gameStatus,
    }))
    .filter(({ status, gameDate, gameStatus, ref }) => {
      // 'invalid' means the source named a day that does not exist on the
      // calendar. It is unsafe for the same reason as ambiguous and conflicting
      // evidence: the collection cannot say which real day was meant.
      if (status === 'ambiguous' || status === 'conflicting' || status === 'invalid') return true;
      if (gameDate) return false;
      // No date: only a completed game with a durable reference may proceed.
      return !ref || gameStatus !== 'final';
    });
  if (unsafeDates.length > 0) {
    throw importError('OPPONENT_SCHEDULE_DATE_UNRESOLVED',
      'An opponent observation carries a date the source did not establish safely, '
      + 'so it cannot be published; manual reconciliation is required.', {
        statusCode: 422,
        context: {
          unresolvedDates: unsafeDates.map(({ index, ref, status, gameStatus }) => ({
            observationIndex: index, sourceGameRef: ref, dateResolutionStatus: status, gameStatus,
          })),
        },
      });
  }
  // A season is a set of observations, not an arrival-order sequence. The
  // subject's identity evidence participates so two different opponents can
  // never collide on one input-set hash; capture timestamps and JSON key order
  // deliberately do not.
  //
  // WHEN the source was read is provenance, not content. An opponent schedule is
  // re-scraped on a schedule, so if capture time participated here every
  // unchanged re-scrape would hash differently, mint a brand-new generation, and
  // supersede the previous one for no reason. The capture time is still recorded
  // on every snapshot row, so the evidence of when each observation was taken is
  // fully preserved -- it simply does not decide identity.
  const inputSetHash = sha256({
    subject: [trustedSubject.kind, trustedSubject.opponentTeamId, trustedSubject.sourceTeamId],
    games: safeGames.map((game) => canonicalSerialize(withoutCaptureTime(game))).sort(codePointCompare),
    gameStatuses: [...gameStatuses].sort(codePointCompare),
  });
  const finalGameCount = gameStatuses.filter((status) => status === 'final').length;
  const base = {
    complete: true,
    context: trustedContext,
    subject: trustedSubject,
    engineVersion: HS_BASEBALL_ENGINE_VERSION,
    inputSetHash,
    observations,
    snapshotCount: observations.reduce((total, observation) => total + observation.snapshots.length, 0),
    canonicalPlayers,
    noncanonicalPlayers,
    teamTotals: reconstruction.summary,
    // A collection with no final game is schedule knowledge, never a completed
    // statistical generation -- the database enforces the same rule.
    officialTotalsComplete: reconstruction.summary.officialTotalsComplete === true
      && statistics.officialTotalsComplete === true
      && finalGameCount > 0,
  };
  const { importRunId, ...subjectContent } = trustedSubject;
  // The content hash is taken over the same provenance-free projection, so an
  // unchanged re-scrape is recognised as the collection it already is rather
  // than reported as a content conflict.
  //
  // Two fields are projected out. `snapshots[].capturedAt` is the capture time
  // itself. `diagnostics` carries digests the engine derived from fingerprints
  // that embed that same capture time, so it moves for the same reason. Neither
  // says anything about what the source actually reported: the games themselves
  // are already pinned by inputSetHash, and identity, validation, statuses,
  // totals and player lines all remain inside the content hash, so a genuine
  // content conflict at the same input set is still detected. Both fields are
  // still stored in full on the rows they belong to.
  const contentBase = {
    ...base,
    subject: subjectContent,
    observations: observations.map(({ diagnostics: _diagnostics, ...observation }) => ({
      ...observation,
      snapshots: observation.snapshots.map(({ capturedAt: _capturedAt, ...snapshot }) => snapshot),
    })),
  };
  return { ...finalizeDto(base, contentBase), finalGameCount };
}

module.exports = {
  HS_BASEBALL_ENGINE_VERSION,
  MAX_HS_ENGINE_COLLECTION_BYTES,
  OPPONENT_GAME_STATUSES,
  canonicalSerialize,
  assertCollectionPayloadWithinLimit,
  mapHighSchoolEngineCollection,
  mapHighSchoolOpponentEngineCollection,
};
