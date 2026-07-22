'use strict';

// Generic Express async-route helpers -- not specific to org resolution,
// but added alongside it because closing the tenant-isolation gap in
// getRequestOrgId surfaced a second, distinct problem: several routes call
// a helper that can now throw a typed 401/403/500 (getRequestOrgId, and
// anything built on it -- assertTeamInRequestOrg, assertOrgActive,
// enforceReportQuota, requireOrgAdmin, getTeams) with NO try/catch around
// the call at all. Express 4 does not forward a rejected promise from an
// async route handler anywhere on its own -- it becomes an unhandled
// promise rejection, never a client response. asyncHandler + a terminal
// error-handling middleware (wired up in server.js) closes that gap for
// every affected route, whether or not the route also has its own local
// try/catch.

// Wraps an async Express route handler so a rejected promise is forwarded
// to Express's own error pipeline via next(err), instead of being lost.
// A route's own local try/catch, if it has one, still runs first and
// still fully handles anything it catches itself -- this only catches
// whatever a local catch block didn't (or a route with no try/catch at
// all, which is exactly the gap this exists to close).
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Builds the terminal Express error-handling middleware (4-arg signature
// -- Express only treats a middleware function as an error handler if it
// declares exactly 4 parameters). Must be mounted with app.use(...) AFTER
// every route, since Express matches error handlers by registration order
// the same as normal middleware.
//
// Factory shape (takes mapErrorToResponse and an optional logger) rather
// than a hardcoded import, specifically so this is unit-testable with a
// fake logger and a fake/spy mapErrorToResponse, without needing a real
// Express app or importing server.js (which isn't possible -- it has
// load-time side effects and no module.exports).
//
// The res.headersSent check is Express's own documented contract for a
// custom error handler: if a response already started (e.g. a route began
// streaming, or already called res.json once and something after it
// threw), calling res.status/json again would throw "Cannot set headers
// after they are sent" -- delegating to next(err) instead hands off to
// Express's built-in default handler, which knows how to close out a
// half-sent response safely, and this handler never attempts a second
// res.send in that case.
function buildFinalErrorHandler(mapErrorToResponse, { logger = console.error } = {}) {
  return function finalErrorHandler(err, req, res, next) {
    if (res.headersSent) {
      return next(err);
    }
    logger('[unhandled route error]', err);
    const { statusCode, message } = mapErrorToResponse(err);
    return res.status(statusCode).json({ error: message });
  };
}

module.exports = { asyncHandler, buildFinalErrorHandler };
