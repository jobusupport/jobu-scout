'use strict';

// Config for the High School UI suite (test/high-school-ui.spec.js) only.
// Not used by `npm test`, which runs the existing node:test suite via
// `node --test` -- @playwright/test's runner and assertion API are
// incompatible with that, so this suite is invoked separately:
//   npx playwright test
const { defineConfig } = require('@playwright/test');

const PORT = 4173;

module.exports = defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.js',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command: `node test/helpers/static-dashboard-server.js`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
});
