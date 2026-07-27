'use strict';

// Minimal static file server for the High School UI Playwright suite.
// Serves only dashboard/index.html (the bundled SPA artifact) -- no
// Express app, no Supabase client, no real auth. Every /api/* call the
// page makes is intercepted by Playwright's page.route() in the test
// files themselves, so this server never needs to answer one.
//
// Run directly (`node test/helpers/static-dashboard-server.js`) for
// playwright.config.js's webServer, or require() and call start()/stop()
// from a test for a self-contained server per run.

const http = require('http');
const fs = require('fs');
const path = require('path');

const DASHBOARD_HTML = path.join(__dirname, '..', '..', 'dashboard', 'index.html');

function start(port) {
  const server = http.createServer((req, res) => {
    fs.readFile(DASHBOARD_HTML, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Could not read dashboard/index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  start(port).then(() => {
    console.log(`High School UI test server listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { start };
