'use strict';

// Centralized policy boundary for licensed, automated GameChanger collection
// (High School ingestion). Every load/throttle/kill-switch knob referenced
// anywhere in the collection adapter (src/high-school-gc-import.js) reads
// from THIS module and nowhere else, so operational load can be adjusted
// (or collection disabled outright) without touching scraper logic --
// exactly the "centralize concurrency/frequency/retry/backoff so load can
// be adjusted promptly" requirement this module exists to satisfy.
//
// Every knob is env-driven with a conservative default, and every default
// is deliberately smaller/slower than what Travel's existing scraper does
// today (src/search-gamechanger-teams.js has NO throttling, NO backoff, and
// NO concurrency cap at all -- confirmed by direct code audit). This module
// is new, additive policy, not a relaxation of anything that already
// existed.
//
// GC_COLLECTION_ENABLED is the kill switch required by the license's
// revocability clause: it must stop NEW automated requests promptly without
// deleting anything already collected. Checked at the START of every run
// (before a browser ever launches) AND polled periodically during a run
// (isCollectionEnabled() is called between games, not just once), so an
// operator flipping this mid-run still halts further requests within one
// game-processing cycle -- already-captured snapshots and already-published
// rows are never touched by this module.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).trim().toLowerCase() === 'true';
}

function isCollectionEnabled() {
  // Defaults to enabled (matches "collection is the primary ingestion
  // method" per the confirmed product decision) -- set
  // GC_COLLECTION_ENABLED=false to engage the kill switch.
  return envBool('GC_COLLECTION_ENABLED', true);
}

function getMaxConcurrentImportJobs() {
  return envInt('GC_MAX_CONCURRENT_IMPORT_JOBS', 1);
}

function getMinRequestDelayMs() {
  return envInt('GC_MIN_REQUEST_DELAY_MS', 1500);
}

function getRetryCeiling() {
  return envInt('GC_RETRY_CEILING', 3);
}

function getBackoffBaseMs() {
  return envInt('GC_BACKOFF_BASE_MS', 2000);
}

function getBackoffMaxMs() {
  return envInt('GC_BACKOFF_MAX_MS', 30000);
}

function getBackoffJitterMs() {
  return envInt('GC_BACKOFF_JITTER_MS', 500);
}

function getMaxGamesPerRun() {
  return envInt('GC_MAX_GAMES_PER_RUN', 50);
}

function getRequestTimeoutMs() {
  return envInt('GC_REQUEST_TIMEOUT_MS', 30000);
}

// Exponential backoff with bounded jitter -- attempt is 1-indexed (the
// first retry is attempt=1). Never used to defeat a rate limit faster;
// only ever to wait LONGER between attempts, capped at getBackoffMaxMs().
function computeBackoffDelayMs(attempt, { random = Math.random } = {}) {
  const base = getBackoffBaseMs();
  const max = getBackoffMaxMs();
  const jitter = getBackoffJitterMs();
  const exponential = base * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, max);
  const jitterOffset = jitter > 0 ? Math.floor(random() * jitter) : 0;
  return capped + jitterOffset;
}

// Response-shape classification used by the collection adapter to decide
// retry vs. immediate-stop. An access-control challenge (CAPTCHA, explicit
// block/rate-limit page) must never be retried through or bypassed --
// classified separately from an ordinary transient failure (timeout,
// network error) specifically so the adapter can hard-stop on the former
// and back off-and-retry on the latter.
const RETRYABLE = 'retryable';
const ACCESS_CONTROL_CHALLENGE = 'access_control_challenge';
const NON_RETRYABLE = 'non_retryable';

function classifyCollectionFailure(err) {
  const message = String(err?.message || err || '').toLowerCase();
  if (
    message.includes('captcha') ||
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('access denied') ||
    message.includes('forbidden') ||
    message.includes('403') ||
    message.includes('blocked')
  ) {
    return ACCESS_CONTROL_CHALLENGE;
  }
  if (
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('network') ||
    message.includes('navigation failed')
  ) {
    return RETRYABLE;
  }
  return NON_RETRYABLE;
}

// Same credential-keyword net src/high-school-importer-contract.js's
// sanitizeSyncError and src/high-school-import-sanitizer.js's
// isCredentialLikeKey already apply to import-pipeline strings, reused here
// (rather than a third, slightly-different regex) so "does this look like
// it might contain a credential/session value" is answered identically
// everywhere in the High School domain.
const CREDENTIAL_LIKE_PATTERN = /(authorization|bearer|cookie|token|session|password|secret|api[\s_-]?key)/i;

// Never let a raw error (which could echo a URL, selector, credential, or
// internal path) escape to a job log or HTTP response verbatim -- the same
// discipline src/high-school-import-sanitizer.js's sanitizeErrorMessage
// already applies to import-pipeline errors, mirrored here for
// collection-specific errors.
function sanitizeCollectionErrorMessage(rawMessage) {
  const message = String(rawMessage || '').trim();
  if (!message) return 'Collection failed.';
  const classification = classifyCollectionFailure(rawMessage);
  if (classification === ACCESS_CONTROL_CHALLENGE) {
    return 'GameChanger access was rate-limited or challenged; collection stopped safely.';
  }
  if (CREDENTIAL_LIKE_PATTERN.test(message)) {
    return 'Collection failed (details withheld: message resembled credential/session data).';
  }
  // Strip anything that looks like a URL query string or file path, which
  // could otherwise leak internal detail into a coach-visible log line.
  const scrubbed = message
    .replace(/https?:\/\/\S+/gi, '[url omitted]')
    .replace(/[a-zA-Z]:\\[^\s]+|\/[a-zA-Z0-9_\-./]+\.(js|json|ts)\b/g, '[path omitted]');
  return scrubbed.length > 500 ? scrubbed.slice(0, 497) + '...' : scrubbed;
}

module.exports = {
  isCollectionEnabled,
  getMaxConcurrentImportJobs,
  getMinRequestDelayMs,
  getRetryCeiling,
  getBackoffBaseMs,
  getBackoffMaxMs,
  getBackoffJitterMs,
  getMaxGamesPerRun,
  getRequestTimeoutMs,
  computeBackoffDelayMs,
  classifyCollectionFailure,
  sanitizeCollectionErrorMessage,
  RETRYABLE,
  ACCESS_CONTROL_CHALLENGE,
  NON_RETRYABLE,
};
