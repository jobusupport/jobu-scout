'use strict';

/**
 * Deprecated Travel compatibility entry point.
 * All statistical computation lives in engine/stats-core.
 */
const core = require('./engine/stats-core');

module.exports = {
  ...core,
  processGames(games) { return core.processGames(games, { legacyIdentity: true }); },
  processGameFile(game) { return core.processGames([game], { legacyIdentity: true }); },
};
