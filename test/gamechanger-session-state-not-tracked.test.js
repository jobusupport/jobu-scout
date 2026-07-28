'use strict';

// Regression coverage for the GameChanger session-state credential exposure
// remediation: gamechanger-auth.json and storage/gamechanger-auth.json are
// live Playwright storageState() exports (cookies + localStorage) and must
// never be tracked by Git again. These tests are read-only (git plumbing +
// static source checks) -- they never open or print either real file's
// contents.
//
// Run with: node --test test/gamechanger-session-state-not-tracked.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

// git ls-files exits 0 with no output when nothing matches -- never throws,
// so this is safe to call even when a path isn't tracked.
function trackedFiles(pathspec) {
  return git(['ls-files', '--', pathspec]).split('\n').filter(Boolean);
}

test('gamechanger-auth.json (root) is not tracked by Git', () => {
  assert.deepEqual(trackedFiles('gamechanger-auth.json'), []);
});

test('storage/gamechanger-auth.json is not tracked by Git', () => {
  assert.deepEqual(trackedFiles('storage/gamechanger-auth.json'), []);
});

test('no file literally named gamechanger-auth.json is tracked anywhere in the repo', () => {
  // Broader than the two known locations -- catches a reintroduced copy at
  // any other path, not just the two paths this remediation already fixed.
  assert.deepEqual(trackedFiles('**/gamechanger-auth.json'), []);
});

test('.gitignore protects both known GameChanger session-state paths', () => {
  const ignoreCheck = execFileSync(
    'git',
    ['check-ignore', 'gamechanger-auth.json', 'storage/gamechanger-auth.json'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  const ignored = ignoreCheck.split('\n').filter(Boolean);
  assert.deepEqual(ignored.sort(), ['gamechanger-auth.json', 'storage/gamechanger-auth.json'].sort());
});

test('.gitignore contains precise, non-broad entries for both paths', () => {
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\/gamechanger-auth\.json$/m);
  assert.match(gitignore, /^\/storage\/gamechanger-auth\.json$/m);
  // Guards against someone "fixing" this later with a dangerously broad
  // rule that would also hide unrelated JSON from Git.
  assert.doesNotMatch(gitignore, /^\*\.json$/m);
  assert.doesNotMatch(gitignore, /^\*\*\/\*\.json$/m);
});

test('scripts that open a GameChanger Playwright context fail closed with a sanitized message when the session file is absent', () => {
  const guardedFiles = [
    path.join(REPO_ROOT, 'src', 'scrape-game-urls.js'),
    path.join(REPO_ROOT, 'src', 'test-extract-plays.js'),
  ];

  for (const file of guardedFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(
      source,
      /fs\.existsSync\(STORAGE_STATE\)/,
      `${path.basename(file)} should check STORAGE_STATE exists before use`
    );
    assert.match(
      source,
      /Missing auth file: \$\{STORAGE_STATE\}\. Run npm run login first\./,
      `${path.basename(file)} should throw the standard sanitized missing-auth message`
    );
    // The sanitized message must only ever interpolate the file *path*
    // (STORAGE_STATE), never file contents, cookies, or env var values.
    assert.doesNotMatch(source, /Missing auth file:[^`]*(cookie|token|secret)/i);
  }
});
