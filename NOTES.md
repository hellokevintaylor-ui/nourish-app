# Session notes

Running log of what changed and what's next. Newest entry at the top.
Claude reads this at the start of a session; keep entries short.

---

## 2026-09-20

**Shipped** — `src/main.js`, `api/scrape.js`

**Clip-from-URL failed silently and looked like a random tab switch.**
Reported from mobile: pasted a Serious Eats URL, got the blank Paste panel
with no error. Cause: on failure the handler set `sharedRecipe = null` but
left `pasteModal = true`. `renderPasteModalInline` picks its layout off
`sharedRecipe` — null means "manual paste" — so a failed clip rendered as the
Paste a Recipe window. The typed URL was discarded. Both entry points (Clip
button, clipboard banner) had the same swallowed catch.

- Both now route through one `clipFromUrl(url)` at module scope. On failure:
  panel stays open, red banner with the real reason, Try again / Open page
  buttons, and the URL pre-filled in `paste-source` so a manual paste still
  keeps the link. New `state.clipError`, cleared on reset and on reopen.
- Treats a non-2xx response, unparseable JSON, and an all-empty payload as
  failures too — previously only `recipe.error` was checked.
- Photo scan failures use the same banner. It was setting `paste-name`'s
  placeholder in a `setTimeout`, which the next render wiped.
- Bare `seriouseats.com/...` with no scheme was silently dropped by
  `startsWith('http')` — now prefixed with `https://`.
- `paste-name` value wasn't `esc()`d in either paste renderer (only the
  `nameVal` branch was). An apostrophe in a clipped title broke the input.

**Why Serious Eats specifically:** Dotdash Meredith blocks datacenter IPs, so
the direct fetch 403s and the allorigins proxy didn't get through either.
Added a third fallback in `api/scrape.js` via the `r.jina.ai` reader proxy —
returns plain text, so JSON-LD extraction won't match and it falls through to
the AI path, which is fine. Also: the final fallback returned a 200 with an
empty name when there was nothing on the page; now 422s with a real message.
**Untested against the live site** — container network is allowlisted, so the
jina fallback has never actually been exercised. Confirm on the next clip.

**AI Coach moved to the Log tab.** Was at the end of `renderShop()` despite
every identifier being `log*` (`logChatOpen`, `log-ai-btn`, `logChatMessages`)
— the 2026-09-18 open item. Extracted the IIFE into a named
`renderCoachPanel()` above `renderLogInner()`, called at the bottom of the Log
tab after the day-by-day rows. Handlers bind by ID in `bindEvents`, so they
needed no change. This was the intended placement all along; it only became
visible once the stranded bindings were fixed last session.

**Learned**
- A null-means-manual-entry render branch doubles as the silent error path.
  Anywhere a renderer switches layout on a nullable field, a failed fetch
  will land in the wrong layout and look like a UI bug, not an error.
- Verified after: syntax check clean, `npm test` 10/10.

**Open / next**
- Confirm the Serious Eats clip actually works post-deploy. If it still fails,
  the banner now names the stage that gave up.
- Still open from 09-18: "▶ Start Cooking" sets `gamePlanView = 'fullscreen'`
  with no renderer for that value. Build or remove.
- Make `gp_test.js` resolve main.js from either `./main.js` or `src/main.js`,
  so the mirroring step in the instructions can go away. Until then, skipping
  the `cp` gives a green 10/10 against the unedited GitHub copy.

**Project instructions updated (end of session).** Restore block now pulls
`src/db.js`, `api/scan.js`, `api/scrape.js` — resolves the 09-18 item. Added
the `src/main.js` mirroring note under TESTING; line count bumped to ~7600.

---

## 2026-09-18

**Workflow: getting files out of Cowork threads**
- Cowork threads can't hand over a downloadable file. Workaround in use: build
  the change in a Cowork thread, paste the finished file into a **chat** thread,
  chat writes it to disk and presents it, then upload via the GitHub web UI.
- **When a file is pasted in, the paste is the source of truth and GitHub is the
  stale copy** — the reverse of the normal rule. Claude reconstructed from
  GitHub first this session and had to be corrected.
- Small files (db.js, ~350 lines): transcribe verbatim. Large files (main.js,
  ~7500 lines): retyping is unreliable, so pull GitHub and re-apply the delta,
  then verify every distinctive string from the paste is present.
- Better option not yet tried: have the Cowork thread emit a **diff against
  GitHub main** instead of the whole file. Smaller, and provably base + change.

**Shipped**
- `src/db.js` — from Cowork. `updateRecipe` now also maps `cooking_notes`,
  `clippedFrom`, `clipped_from`, `category`; returns null on empty update;
  surfaces Supabase errors; warns on unmapped keys.
- `src/main.js` — source-link feature from Cowork (`normalizeSourceUrl`,
  `sourceHost`, `editingSourceId`/`_sourceDraft`, editable source row on the
  recipe card, `paste-source` field), plus six fixes found while auditing.

**These two files are a matched pair.** Old `updateRecipe` mapped only six keys
and silently dropped the rest. Three main.js call sites were affected:
`{clippedFrom}` (source-link save wrote nothing — UI updated optimistically so
it looked like it worked), `{category}` (inline dropdown never persisted),
`{cooking_notes}` snake_case from cook-mode Save (notes dropped, other fields
saved — looked intermittent). Shipping main.js without db.js leaves the
source-link feature broken.

**Fixed in main.js**
- **~100 lines of event bindings were stranded at module scope**, between
  `gpGenerateHandler` and `init()` — indented like a function body but not in
  one. Ran once at load before any DOM existed, so every
  `getElementById(...)?.addEventListener` hit null and no-opped. AI Coach
  (button/send/Enter/close/clear), chat starter prompts, "Clear conversation",
  and the recipe-context back arrow and title link had never been bound. Moved
  into `bindEvents`. Dropped two entries already covered by live handlers
  (`#gp-regenerate` → `gpDelegation`; `.chat-recipe-link` → the broader
  `[data-go-recipe]` handler) rather than double-binding.
- `renderShop`: stray `+ +` coerced the AI Coach panel HTML to a number — the
  tab rendered the literal text `NaN`.
- `stripMeasurements`: `\ d*` (escaped space) instead of `\d*`. Only stripped a
  quantity when a space followed; `"1/2 cup milk"` → `"1/cup milk"`. Feeds
  pantry matching, so it was quietly weakening "do I already have this?".
- `parseIngredientLine` mixed numbers: `m => m[0]` returns the first *character*
  of the match, not the group. `"12½ oz"` → `"1 oz"`. Now converts properly
  (1.5, 12.5, 2.75).
- `sendGpChatMessage` read `slot` before its `var` destructuring assigned it →
  always undefined, so every Lunch plan fell back to the dinner time.
- `gp-tweak-from-fullscreen` referenced five undefined vars — guaranteed
  ReferenceError on click. Repointed to the `sc*` locals.
- Verified after: syntax check clean, `npm test` 10/10.

**Learned**
- `node --input-type=module --check` will not catch a block of handlers sitting
  at module scope — it's valid JS that silently does nothing. Indentation is
  the only visible tell.
- Optional chaining (`?.addEventListener`) hides binding bugs completely. The
  handlers failed silently for however long this has been shipped.

**Open / next**
- "▶ Start Cooking" does nothing. Sets `gamePlanView = 'fullscreen'`, but no
  renderer handles that value, so it falls through to the result view.
  `gp-exit-fullscreen` and `gp-tweak-from-fullscreen` exist for a screen that
  was never built. Feature gap, not a typo — decide whether to build or remove.
- The AI Coach panel lives in `renderShop`, not `renderLogInner`, despite the
  "log" naming throughout. Now that it renders, it appears on the Shop tab.
  Looks like it landed in the wrong function; moving it is a product call.
- Add `src/db.js` to the restore block in the project instructions — it wasn't
  there, and it was needed this session.

---

## 2026-09-17

**Done**
- Fixed corrupted regex in `gpNormalizeTime2` (src/main.js ~line 3046). Two
  literal backspace bytes (0x08) had replaced the `\b` word-boundary anchors,
  killing its am/pm normalization. Was latent — `gpParseTime` does the same
  normalization and masked it. Shipped.
- Rewrote `gp_test.js` (repo root). It now extracts the real `gp*` functions
  from `src/main.js` at runtime instead of testing pasted copies. 10 tests.
  Verified by mutation: reintroducing the 0x08 corruption, breaking the
  backwards-from-dinner anchor, and dropping the night_before label each fail
  a distinct test.
- Added `"test": "node gp_test.js"` to package.json → `npm test`.
- Deleted orphaned root `styles.css` (stale 40KB copy). `index.html` loads
  `/src/styles.css`; that's the only one now.

**Learned**
- `node --check main.js` silently passes files with real syntax errors —
  Node 22 module detection swallows them. Use
  `node --input-type=module --check < main.js`. Verified both directions.
- The 0x08 corruption was invisible in GitHub's file viewer and undetectable
  by behavioral tests. The integrity check in gp_test.js is what catches it.

**Project setup (Claude side)**
- Rewrote project instructions: removed the contradictory syntax-check lines,
  fixed the gp_test.js path (repo root, `npm test`), dropped the
  /mnt/transcripts reference, added the GitHub restore block.
- Removed all code files from Claude project files. They were stale snapshots
  that don't track GitHub — one of them handed Claude the superseded
  gp_test.js this session. GitHub is now the only source of truth; Claude
  restores via curl at session start.
- Added this file and wired it into the restore block.
- Working model: one thread per task, not one long thread. Continuity comes
  from instructions + GitHub + this file, not from keeping a thread alive.

**Open / next**
- Nothing in flight. Next session: pick up actual app work — this session was
  all infrastructure.
- Unverified: whether scheduled/recurring tasks are available in the web UI
  (would suit a weekly `npm test` health check; not suited to updating this
  file, since a scheduled run can't see the session it would summarize).
- Unverified: whether "Search and reference past chats" is enabled. Chat
  search returned nothing all session.

**Known, not urgent**
- `.env` is committed to this public repo. Contains only `VITE_SUPABASE_URL`
  and a `sb_publishable_` key — both are public by design and already in the
  client bundle, so no rotation needed. Real protection is Supabase RLS;
  worth confirming policies are enabled. `.env` is in `.gitignore` but was
  committed before that, so gitignore doesn't untrack it.
- `gpParseConstraints`: `constraints.gapEndMins = cookStart` reads `cookStart`
  from a branch where it may be undefined (when the last window IS the
  cooking window). Legacy field, no known impact.

---

<!-- Template for new entries:

## YYYY-MM-DD

**Done**
-

**Open / next**
-

-->
