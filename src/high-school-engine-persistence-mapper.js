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

function observationsFor(games, rawGames, reconstruction, engineVersion) {
  const occurrenceByFingerprint = new Map();
  const observationOrdinalByFingerprint = new Map();
  const entries = games.map((game, index) => ({ game, rawGame: rawGames[index], fingerprint: canonicalSerialize(game) }));
  entries.sort((a, b) => codePointCompare(a.fingerprint, b.fingerprint));
  return entries.map(({ game, rawGame, fingerprint }) => {
    const ordinal = (observationOrdinalByFingerprint.get(fingerprint) || 0) + 1;
    observationOrdinalByFingerprint.set(fingerprint, ordinal);
    const result = gameResultForFingerprint(reconstruction.gameResults, fingerprint, occurrenceByFingerprint);
    const identity = result.identity;
    const reconciliation = identity.reconciliation || {};
    const capturedAt = game.meta.capturedAt;
    const sourceRef = sourceGameRef(game);
    const snapshots = [
      { kind: 'box_score', sourceRef, capturedAt, payload: rawGame.boxScore || {}, integrityHash: sha256(rawGame.boxScore || {}) },
      { kind: 'play_by_play', sourceRef, capturedAt, payload: rawGame.plays || [], integrityHash: sha256(rawGame.plays || []) },
    ];
    const observationKey = sha256(canonicalSerialize([fingerprint, ordinal]));
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
      diagnostics: { reconciliation: digestReconciliation(reconciliation) },
      diagnostic: result.diagnosticReconstruction || { status: 'not_run', code: null },
      validation: validationFor(result, reconstruction.summary),
      snapshots,
      engineVersion,
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

function finalizeDto(base) {
  const contentHash = sha256(base);
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

module.exports = {
  HS_BASEBALL_ENGINE_VERSION,
  MAX_HS_ENGINE_COLLECTION_BYTES,
  canonicalSerialize,
  assertCollectionPayloadWithinLimit,
  mapHighSchoolEngineCollection,
};
