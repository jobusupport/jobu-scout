# Dashboard source

**`dashboard-src/` is the canonical, editable source for the customer
dashboard. `dashboard/index.html` is generated output — a build artifact,
not a source file.** Edit files in here, then run `npm run build:dashboard`
to regenerate it. Never hand-edit `dashboard/index.html` directly.

## Why this exists

`dashboard/index.html` is not a normal static file — it's a thin loading shell
that unpacks a single JSON-encoded string (line 194) containing the entire
app. There was previously no separate source for it anywhere in the repo;
every past change was made by hand-editing inside that JSON blob. This
directory replaces that workflow with normal, readable, diffable files.

## Layout

```
dashboard-src/
  index.html        - page shell: <head>, <body> markup, and the <link>/<script>
                       tags that assemble the app. Open this directly in a
                       static file server to preview it.
  fonts.css          - self-hosted @font-face declarations (Bebas Neue, Oswald,
                       Inter, JetBrains Mono)
  app.css            - all application styles
  modules/           - application JavaScript, split at the module boundaries
                       the original file already used internally (see banner
                       comments), concatenated back together in this order at
                       build time:
    auth.js            - login/signup/password reset, DESIGN_MODE mock data
    support-session.js - admin-panel-access check, admin support-view session
                          banner
    nav.js              - sidebar collapse, dropdown menus
    teams.js            - team list state, loading teams, "My Team" CRUD
    team-detail.js      - main panel rendering, per-tab pane renderers, tab
                          switching
    jobs.js             - scrape/report job runner, SSE log streaming, games,
                          reports list
    roster.js           - roster tab (add/edit/remove players, availability)
    opponents.js        - add/edit/remove opponent teams
    billing.js           - plan/usage display, Stripe checkout/portal links
    init.js              - bootstrap on page load
```

Module boundaries were cut only at existing blank-line/comment-banner breaks
in the original file — nothing was reordered or rewritten, so the build output
is byte-identical to what was already deployed (verified below).

## Build

```
npm run build:dashboard         # regenerates dashboard/index.html from this directory
npm run build:dashboard:check   # builds in-memory and diffs against the current
                                 # dashboard/index.html; exits non-zero on any
                                 # difference, without touching the file
```

`scripts/build-dashboard.js` inlines `fonts.css` and `app.css` back into two
`<style>` blocks, concatenates every file under `modules/` (in the order
listed in `index.html`) into one `<script>` block, then re-runs the same
JSON-encode-and-splice step `scripts/encode-dashboard.js` always used to
write `dashboard/index.html`. The on-disk deployment artifact and how the
server serves it (`GET /` in `server.js`) are unchanged — only how that
artifact gets produced changes.

Always run `npm run build:dashboard:check` after editing, before running the
real build, so a broken edit shows up as a clean diff failure instead of a
silent behavior change.

## Previewing without the backend

`dashboard-src/index.html` can be opened through any static file server
as-is (it's a real HTML file with real `<link>`/`<script src>` tags — no
build step needed to preview). Flip `DESIGN_MODE` to `true` at the top of
`modules/auth.js` to skip login and render against the built-in mock data
instead of calling the live API — this flag already existed in the original
bundle; it isn't new.

**Do not commit `DESIGN_MODE = true`.** It must stay `false` in
`dashboard-src/modules/auth.js` (and therefore in the built
`dashboard/index.html`) for production.

## Deployment

No change: `server.js` serves `dashboard/index.html` directly from disk at
`GET /` and statically at `express.static('dashboard')`, exactly as before.
The only new step is running `npm run build:dashboard` before committing a
frontend change, so `dashboard/index.html` stays in sync with `dashboard-src/`.
Consider adding a CI check that runs `npm run build:dashboard:check` and fails
if `dashboard-src/` and `dashboard/index.html` have drifted apart.

## `scripts/decode-dashboard.js` / `scripts/encode-dashboard.js`

Kept as-is for emergency use (e.g. inspecting a `dashboard/index.html` that
didn't come from this source directory), but they are no longer the intended
editing workflow. Prefer editing `dashboard-src/` and running
`npm run build:dashboard`.

## Dependencies

None beyond Node.js itself — `build-dashboard.js` uses only `fs`/`path` from
the standard library, matching the rest of this repo's build tooling.
