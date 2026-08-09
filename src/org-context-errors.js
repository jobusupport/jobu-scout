'use strict';

// Shared error type for the Travel tenant-isolation write path (Security
// Slice T2). Thrown whenever a team lookup/write is about to happen
// without an already-verified organization context. There is exactly one
// class here, used identically by src/pipeline.js, src/db-supabase.js,
// and src/job-org-context.js, so no caller ever has to branch on a
// second, incompatible "no org" shape.
//
// This is a server-side propagation defect when it fires from the HTTP
// path (the route already resolved a trusted org before spawning; seeing
// this error means that value failed to reach here), not a client input
// problem -- statusCode is set accordingly so it maps to a generic 500
// via the existing src/org-resolution.js#mapErrorToResponse convention
// rather than ever being mistaken for a 4xx the caller could fix by
// retrying with different input.
class OrgContextRequiredError extends Error {
  constructor(message) {
    super(message || 'Organization context is required for this operation.');
    this.name = 'OrgContextRequiredError';
    this.statusCode = 500;
  }
}

module.exports = { OrgContextRequiredError };
