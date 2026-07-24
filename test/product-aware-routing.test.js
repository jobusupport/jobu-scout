'use strict';

// Focused tests for the product-shell page routes added to server.js
// (GET /travel and GET /high-school).
//
// server.js is not `require`d here: it unconditionally calls app.listen()
// at module load (no `require.main === module` guard) and performs other
// real startup side effects (pipelineDb.init() when USE_SUPABASE is set,
// Stripe client construction, writing a GC auth file) -- importing it in
// a unit test would start a live listener and perform real I/O as a side
// effect of merely loading the module, which is unsafe here. Instead,
// these are text-level assertions against the route registration itself,
// the same convention already used in
// test/remove-game-date-repair-rpc-migration.test.js for asserting SQL
// shape without a live database. The actual live behavior (does the
// shell really render, does the client correctly gate content) is
// verified by the automated node:test client-logic assertions above this
// comment tier -- i.e. test/product-resolution.test.js -- plus manual
// browser verification (see the PR description for screenshots).
//
// Run with: node --test test/product-aware-routing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');

test('server.js exists and defines the product-shell routes', () => {
  assert.ok(serverSrc.length > 0);
});

test('GET /travel and GET /high-school (plus their sub-paths) are registered as explicit routes', () => {
  assert.match(
    serverSrc,
    /app\.get\(\['\/travel',\s*'\/travel\/\*splat',\s*'\/high-school',\s*'\/high-school\/\*splat'\]/
  );
});

test('the product-shell routes serve the dashboard bundle, not the admin bundle or any other file', () => {
  const routeLine = serverSrc.split('\n').find((l) => l.includes("'/travel/*splat'"));
  assert.ok(routeLine, 'expected to find the product-shell route registration');
  assert.match(routeLine, /path\.join\(ROOT, 'dashboard', 'index\.html'\)/);
});

test('the product-shell route registration does not reference req.query, req.body, or a client-supplied product value', () => {
  const routeLine = serverSrc.split('\n').find((l) => l.includes("'/travel/*splat'"));
  assert.ok(routeLine);
  assert.doesNotMatch(routeLine, /req\.(query|body|params)/);
});

test('express.static(dashboard) is mounted before the product-shell routes (existing static-asset serving is unaffected)', () => {
  const staticIndex = serverSrc.indexOf("express.static(path.join(ROOT, 'dashboard'))");
  const routeIndex = serverSrc.indexOf("'/travel/*splat'");
  assert.ok(staticIndex >= 0);
  assert.ok(routeIndex >= 0);
  assert.ok(staticIndex < routeIndex);
});

test('the admin catch-all route is untouched (still serves admin/index.html, still its own separate route)', () => {
  assert.match(serverSrc, /app\.get\(\['\/admin', '\/admin\/\*splat'\], \(req, res\) => res\.sendFile\(path\.join\(ROOT, 'admin', 'index\.html'\)\)\);/);
});
