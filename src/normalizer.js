'use strict';

/**
 * Deprecated Travel compatibility entry point.
 * All normalization computation lives in engine/normalize-core.
 */
const core = require('./engine/normalize-core');

function withLegacyClock(options = {}) {
  return {
    ...options,
    referenceYear: Number.isInteger(options.referenceYear) ? options.referenceYear : new Date().getFullYear(),
    capturedAt: options.capturedAt || new Date().toISOString(),
  };
}

module.exports = {
  ...core,
  normalizeDateCandidate(value, options) {
    return core.normalizeDateCandidate(value, withLegacyClock(options));
  },
  parseDateTimeRaw(raw, options) {
    return core.parseDateTimeRaw(raw, withLegacyClock(options));
  },
  normalizeGameMeta(meta, teamId, options) {
    return core.normalizeGameMeta(meta, teamId, withLegacyClock(options));
  },
  normalizeGameData(rawJson, teamId, options = {}) {
    const result = core.normalizeGameData(rawJson, teamId, withLegacyClock(options));
    if (options.invertTeamSide === true) {
      console.log('[normalizer] invertTeamSide=true — scouted team players stored as is_our_team=0');
    }
    return result;
  },
};
