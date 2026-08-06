'use strict';

// Preloaded via `node --test --require ./test/helpers/test-env-setup.js`
// (see package.json's test script) for every node:test worker, BEFORE any
// test file or the modules it requires ever run. Establishes NODE_ENV=test
// as the single, process-wide signal src/gc-session-loader.js's
// isAutomatedTestMode() checks to refuse resolving the real production
// GameChanger auth path (see that file's own header comment for why).
//
// Set unconditionally, not merely as a fallback: this file is preloaded
// ONLY by the `npm test` / `node --test` invocation itself (see
// package.json), never by any other entry point, so there is no legitimate
// scenario where a test run should proceed under a DIFFERENT NODE_ENV --
// an ambient shell/CI value of 'development' or anything else must not be
// able to silently disable the GameChanger test-mode safety guarantee this
// establishes.
process.env.NODE_ENV = 'test';

// Propagate the GameChanger network guard (test/helpers/gc-network-guard.js)
// to every CHILD Node process any test spawns, not just the current
// process. `node --test --require X` only preloads X into THIS process --
// a child started via child_process.spawn('node', [...]) does NOT inherit
// CLI flags from its parent, only environment variables. Every spawn call
// in this codebase that launches a GameChanger-touching child (see
// src/high-school-import-routes.js's collector spawn) passes
// `env: { ...process.env, ... }`, which DOES copy NODE_OPTIONS -- and
// Node itself reads NODE_OPTIONS from its own environment at startup and
// auto-applies any --require flags found there. Setting it here, once,
// before any test file runs, means a real (not test-double) child process
// accidentally spawned during a test run still has the network guard
// installed the moment it starts, independent of whether that specific
// test remembered to inject a fake spawn. Appends to (never clobbers) any
// NODE_OPTIONS already present, and only appends once even if this module
// is somehow evaluated more than once in the same process.
const path = require('path');
const GUARD_PATH = path.join(__dirname, 'gc-network-guard.js');
const REQUIRE_FLAG = `--require ${GUARD_PATH}`;
if (!(process.env.NODE_OPTIONS || '').includes(GUARD_PATH)) {
  process.env.NODE_OPTIONS = process.env.NODE_OPTIONS
    ? `${process.env.NODE_OPTIONS} ${REQUIRE_FLAG}`
    : REQUIRE_FLAG;
}
