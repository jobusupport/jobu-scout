'use strict';

const { OrgContextRequiredError } = require('./org-context-errors');

// The single, narrowly-scoped contract between a server-spawned (or
// operator-invoked) Travel child process and the organization it is
// trusted to act as.
//
// JOBU_JOB_ORG_ID is deliberately NOT named after GameChanger (e.g.
// GC_ORG_ID) -- the value it carries is trusted Jobu job ownership
// (resolved once, server-side, from the caller's verified session or
// support session; see src/org-resolution.js), never anything obtained
// from or influenced by GameChanger, a spreadsheet row, or scraped team
// data. Only the parent server process (src/server.js) or a trusted
// operator populates this variable; nothing downstream of
// requireJobOrgContext() may overwrite, infer, or fall back away from it.
//
// Read once per process (each child entry point calls this a single time,
// at the very start of its work, before any GameChanger acquisition or
// database access begins) and treated as immutable for that process's
// lifetime -- callers must attach the returned value to every team object
// they construct themselves, not re-read the environment later.
const JOB_ORG_ENV_VAR = 'JOBU_JOB_ORG_ID';

// `env` is injectable (defaults to the real process.env) purely so tests
// can exercise this without mutating global process state.
function requireJobOrgContext(env = process.env) {
  const raw = env[JOB_ORG_ENV_VAR];
  const normalized = typeof raw === 'string' ? raw.trim() : '';

  if (!normalized) {
    throw new OrgContextRequiredError(
      `${JOB_ORG_ENV_VAR} is required but was not provided. This process must be started ` +
      'by the Jobu Scout server, which sets it from an already-verified session or support ' +
      `session -- or, for a trusted operator invocation, ${JOB_ORG_ENV_VAR} must be set ` +
      'explicitly. There is no fallback to "the only organization" or any other inference.'
    );
  }

  return normalized;
}

module.exports = { JOB_ORG_ENV_VAR, requireJobOrgContext };
