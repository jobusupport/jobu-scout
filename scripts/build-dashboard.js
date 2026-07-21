'use strict';

/**
 * scripts/build-dashboard.js
 *
 * Builds the deployable dashboard/index.html artifact from the editable
 * source in dashboard-src/. This replaces hand-editing inside the bundled
 * artifact: edit files under dashboard-src/, then run
 *   npm run build:dashboard
 * to regenerate dashboard/index.html.
 *
 * How it works:
 *  1. Reads dashboard-src/index.html, which is a normal, previewable HTML
 *     file with <link rel="stylesheet"> tags and <script src> tags pointing
 *     at dashboard-src/fonts.css, dashboard-src/app.css, and the files under
 *     dashboard-src/modules/.
 *  2. Splices the two stylesheets back in as inline <style> blocks (in the
 *     original fonts-then-app order) and concatenates every module script,
 *     in the order listed in dashboard-src/index.html, back into a single
 *     inline <script> block. This reproduces exactly the flattened HTML
 *     document the app has always served.
 *  3. Re-runs the existing bundling step (unchanged from
 *     scripts/encode-dashboard.js): JSON-encode that HTML string, escape
 *     "</" so it can't prematurely close the wrapping <script> tag, and
 *     write it back onto line 194 of dashboard/index.html.
 *
 * Usage:
 *   node scripts/build-dashboard.js            # writes dashboard/index.html
 *   node scripts/build-dashboard.js --check     # builds in-memory only,
 *                                                # diffs against the current
 *                                                # dashboard/index.html, and
 *                                                # exits non-zero if they
 *                                                # differ. Use this to prove
 *                                                # a source edit round-trips
 *                                                # before trusting it.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'dashboard-src');
const DASHBOARD_PATH = path.join(ROOT, 'dashboard', 'index.html');

const STYLES_START = '<!-- build:styles:start -->';
const STYLES_END = '<!-- build:styles:end -->';
const SCRIPTS_START = '<!-- build:scripts:start -->';
const SCRIPTS_END = '<!-- build:scripts:end -->';

function readSrc(relPath) {
  return fs.readFileSync(path.join(SRC_DIR, relPath), 'utf8');
}

function buildHtml() {
  const template = readSrc('index.html');

  const stylesStartIdx = template.indexOf(STYLES_START);
  const stylesEndIdx = template.indexOf(STYLES_END);
  const scriptsStartIdx = template.indexOf(SCRIPTS_START);
  const scriptsEndIdx = template.indexOf(SCRIPTS_END);
  if ([stylesStartIdx, stylesEndIdx, scriptsStartIdx, scriptsEndIdx].some((i) => i === -1)) {
    throw new Error('dashboard-src/index.html is missing one or more build:* markers.');
  }

  const stylesBlock = template.slice(stylesStartIdx, stylesEndIdx + STYLES_END.length);
  const scriptsBlock = template.slice(scriptsStartIdx, scriptsEndIdx + SCRIPTS_END.length);

  // Stylesheets: inline in the order their <link> tags appear.
  const linkRe = /<link rel="stylesheet" href="([^"]+)">/g;
  let styleReplacement = '<style>';
  let m;
  const cssFiles = [];
  while ((m = linkRe.exec(stylesBlock))) cssFiles.push(m[1]);
  if (cssFiles.length !== 2) {
    throw new Error(`Expected exactly 2 stylesheets in build:styles block, found ${cssFiles.length}`);
  }
  // fonts.css and app.css were originally two separate <style> blocks, not
  // one merged block -- reproduce that exactly.
  const fontsCss = readSrc(cssFiles[0]);
  const appCss = readSrc(cssFiles[1]);
  styleReplacement = `<style>${fontsCss}</style>\n<style>\n${appCss}\n</style>`;

  // Scripts: concatenate every module, in the order its <script src> tag
  // appears, into a single inline <script> block.
  const scriptRe = /<script src="modules\/([^"]+)"><\/script>/g;
  const jsFiles = [];
  while ((m = scriptRe.exec(scriptsBlock))) jsFiles.push(m[1]);
  if (jsFiles.length === 0) {
    throw new Error('No module <script src> tags found in build:scripts block.');
  }
  const jsContent = jsFiles.map((f) => readSrc(path.join('modules', f))).join('\n');
  const scriptReplacement = `<script>\n${jsContent}\n</script>`;

  let html = template.slice(0, stylesStartIdx) + styleReplacement + template.slice(stylesEndIdx + STYLES_END.length);
  const newScriptsStart = html.indexOf(SCRIPTS_START);
  const newScriptsEnd = html.indexOf(SCRIPTS_END);
  html = html.slice(0, newScriptsStart) + scriptReplacement + html.slice(newScriptsEnd + SCRIPTS_END.length);

  return html;
}

function encodeIntoBundle(decodedHtml) {
  let jsonStr = JSON.stringify(decodedHtml);
  jsonStr = jsonStr.split('</').join('<\\u002F');

  const raw = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  const lines = raw.split('\n');
  lines[193] = jsonStr;
  return lines.join('\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');

  const decodedHtml = buildHtml();
  const rebuiltBundle = encodeIntoBundle(decodedHtml);

  if (checkOnly) {
    const current = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    if (current === rebuiltBundle) {
      console.log('OK: dashboard-src/ builds byte-identical to dashboard/index.html');
      process.exit(0);
    } else {
      console.error('MISMATCH: build output differs from dashboard/index.html');
      console.error('current length:', current.length, 'rebuilt length:', rebuiltBundle.length);
      let i = 0;
      while (i < Math.min(current.length, rebuiltBundle.length) && current[i] === rebuiltBundle[i]) i++;
      console.error('first diff at byte', i);
      console.error('current  around diff:', JSON.stringify(current.slice(Math.max(0, i - 60), i + 60)));
      console.error('rebuilt  around diff:', JSON.stringify(rebuiltBundle.slice(Math.max(0, i - 60), i + 60)));
      process.exit(1);
    }
  } else {
    fs.writeFileSync(DASHBOARD_PATH, rebuiltBundle, 'utf8');
    console.log('Wrote dashboard/index.html from dashboard-src/ (' + rebuiltBundle.length + ' bytes).');
  }
}

main();
