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
