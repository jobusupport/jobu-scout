'use strict';

// Trusted organization-resolution boundary -- extracted out of server.js
// specifically so this authorization logic is unit-testable without a live
// Supabase project. This is the EXACT logic server.js's getRequestOrgId
// calls in production (see that function's own comment for the thin
// wrapper) -- not a re-implementation or a test-only stand-in. The only
// thing a caller injects is the actual database call
// (`lookupAcceptedMemberships`); every trust decision, every ignored input,
// and every fail-closed branch below is the real code path.
//
// Exactly two sources are ever trusted for the returned org id:
//
//   1. A validated support session. resolveSupportSession
//      (src/admin-lib.js) already pins req._orgId to the TARGET org before
//      this function runs -- the short-circuit below returns that value
//      completely unchanged and never performs a membership lookup at all,
//      so a support session's target org is preserved exactly as
//      validated and can never be recomputed into something else.
//
//   2. An authoritative lookup, via `lookupAcceptedMemberships(userId)`,
//      of accepted org_members rows for the caller's own verified
//      req.user.id -- the id Supabase Auth verified from the caller's JWT,
//      never anything client-suppliable.
//
// Nothing else is ever consulted. Not req.body, not req.query, not
// req.params, not any header, and -- the vulnerability this module exists
// to close -- not req.user.app_metadata.org_id or
// req.user.user_metadata.org_id. The only property of req.user this
// function reads at all is `.id`, and only to look up real membership.
// user_metadata is end-user-editable via the standard Supabase Auth client
// (`supabase.auth.updateUser`); trusting it (as this code used to) let any
// authenticated user claim membership in an org they don't belong to.
//
// Fails closed in every case: no verified user, zero accepted membership
// rows, more than one accepted membership row (ambiguous -- there is no
// "active org" selector in this application to disambiguate with, so
// guessing one would be exactly the unverified trust this function must
// not have), a malformed lookup result (not an array, or a row missing a
// usable org_id -- treated the same as "unable to verify", never as
// "zero memberships" and never by picking a value out of the malformed
// shape), or a database error, all throw rather than guess. Every error
// thrown here carries only a generic, safe `.message` and an explicit
// `.statusCode`; callers must forward `.message` to a client only when
// `.statusCode` was set this way, and must substitute a generic message
// for anything else.
async function resolveTrustedOrgId(req, { lookupAcceptedMemberships }) {
  if (req?._orgId) return req._orgId;

  const userId = req?.user?.id || null;
  if (!userId) {
    const err = new Error('Unable to determine the current user. Please sign out and sign back in.');
    err.statusCode = 401;
    throw err;
  }

  let memberships;
  try {
    memberships = await lookupAcceptedMemberships(userId);
  } catch (dbErr) {
    console.error('[resolveTrustedOrgId] membership lookup failed:', dbErr);
    const err = new Error('Unable to verify organization membership right now. Please try again.');
    err.statusCode = 500;
    throw err;
  }

  const isWellFormed =
    Array.isArray(memberships) &&
    memberships.every((row) => row && typeof row.org_id === 'string' && row.org_id.length > 0);

  if (!isWellFormed) {
    console.error('[resolveTrustedOrgId] membership lookup returned a malformed result:', memberships);
    const err = new Error('Unable to verify organization membership right now. Please try again.');
    err.statusCode = 500;
    throw err;
  }

  if (memberships.length === 0) {
    const err = new Error('No organization membership found for this account.');
    err.statusCode = 403;
    throw err;
  }

  if (memberships.length === 1) {
    return memberships[0].org_id;
  }

  // memberships.length > 1: ambiguous. Fail closed rather than picking one.
  const err = new Error(
    'This account belongs to more than one organization; unable to determine which one to use for this request.'
  );
  err.statusCode = 403;
  throw err;
}

// Builds the real production org_members query -- extracted to its own
// function specifically so a test can assert on the exact call shape
// (table, columns, filters) against a mock/spy client, without a live
// database, proving the accepted_at IS NOT NULL filter is actually part of
// the query server.js runs, not just described in a comment.
function buildAcceptedMembershipsQuery(adminClient, userId) {
  return adminClient
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId)
    .not('accepted_at', 'is', null);
}

// ── Shared, testable error-to-response mapping ──────────────────────────────
//
// Every route in server.js that calls getRequestOrgId (directly, or via
// requireOrgAdmin) needs to make the same decision about a caught error:
// forward it safely, or hide it. This function is that one decision,
// factored out so it's unit-testable without a database and so every
// caller applies it identically rather than re-implementing (and
// potentially getting wrong) the same three-line check inline.
//
// A `.statusCode` already set on the error means it was thrown
// deliberately, by resolveTrustedOrgId/getRequestOrgId or by this file's
// own explicit `err.statusCode = ...; throw err;` sites -- its `.message`
// is a pre-authored, safe, public string in every such case, and is
// forwarded as-is. Anything without a `.statusCode` is treated as
// unexpected -- a raw Supabase/Postgres error is the typical case, and can
// contain SQL fragments, table/column names, or connection details -- and
// is mapped to a stable generic 500 instead. This function never logs;
// logging the real error in full, server-side, before calling this is the
// caller's job (see sendResolverError in server.js).
function mapErrorToResponse(err) {
  if (err && err.statusCode) {
    return { statusCode: err.statusCode, message: err.message };
  }
  return { statusCode: 500, message: 'Something went wrong. Please try again.' };
}

module.exports = { resolveTrustedOrgId, buildAcceptedMembershipsQuery, mapErrorToResponse };
