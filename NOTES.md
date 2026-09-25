# Session notes

Running log of what changed and what's next. Newest entry at the top.
Claude reads this at the start of a session; keep entries short.

---

## 2026-09-25

**Shipped** — `src/main.js`, `src/db.js`, `src/styles.css`, `wc_test.js` (new),
`package.json`, `goal_phases.sql` (new, run once in Supabase).
Uploaded in stages through the session; the target-range legend move and the
AI Coach context fix were the last two — confirm both are on main.

### Weight chart: calendar periods instead of a rolling window

Was "last 7 days ending at the most recent weigh-in" (anchored to the last log,
not to today — skipping 3 days silently shifted the whole window). Now every
view is a calendar period with ‹ › navigation and a Today button.

- `1W` Mon–Sun · `2W` last week + this week · `1M` calendar month ·
  `3M` this month + 2 before · `All`. Offset steps by the period size.
- Back as far as history goes, one period forward. Switching views resets to 0.
- `3M` / `All` plot weekly averages (daily readings as faint marks in `3M`);
  >40 points draws the line only. Future days tinted, today marked, faint
  connector back to the last weigh-in before the period.
- New pure `wc*` functions (period bounds, plan segments, buckets, chunks,
  phase lookup). All date math is noon-anchored — `+ n * 86400000` on local
  midnight breaks on the Nov 1 DST change and would have put Monday's log in
  the wrong column.

### Log tab calories follow the same period

`renderPeriodCalories()` replaced the old rolling 7-day block (which ran
`i = 1..7`, so it never included today — that's why `isDayToday` never fired).

- One range query per period via new `fetchLogRange` / `fetchExerciseRange`,
  cached by `start|end` (was 14 separate day queries + a `render()` each).
- `1W`/`2W` daily rows; `1M`/`3M` weekly rows, tap to expand; `All` monthly.
- Deficit/surplus counts only completed days that have food logged — otherwise
  every Monday reads as a huge deficit. Today reads live `state.log`.

### Goal phases (`goal_phases` table)

`goals` is one row and `saveGoals` overwrites it, so changing start weight /
target / start date rewrote history: old weigh-ins were filtered out
(`p.day >= 0`) and the chart returned `''` outright when start ≤ target, which
made the whole weight section vanish in maintenance.

- Each phase = one chapter (lose / gain / maintain) with its own dates, start
  and target weight, calories, **frozen** `lbs_per_day`, and target range.
  Editing Goals adjusts the active phase; "Start a new phase" closes it
  (`end_date`) and opens another. Old plan lines stay on old dates.
- Rate is now computed once from the phase's *start* weight. It used to be
  recalculated from the latest weight on every render, so the plan line and the
  projected finish date drifted with each weigh-in. **The planned finish date
  shifted once on upgrade** — expected.
- Maintain phases centre the y-axis on the baseline weight so the chart reads
  as variance. Gain direction supported.
- Table is optional: `fetchGoalPhases` returns `ok:false` and the app falls
  back to a single phase built from `goals`. When unavailable the panel shows
  a red block with the real Supabase error and a Retry button — the first
  version buried this in grey text, and a disabled input reads as a broken one
  ("I still can't input target range low and high" → table hadn't been created).

### Target weight range

Two inputs on the active phase, shaded band on every chart.

- Renamed from "healthy range" at user request; "Target Weight" → "Goal Target
  Weight". No "healthy" anywhere in the UI now.
- **Stored exactly as typed.** Sorting low/high at save time scrambled the
  entry: moving a range up (typing 160 into Low while High was 158) instantly
  swapped them. `wcPhaseRange()` normalises at render instead; one box filled
  = single baseline line, both empty = no band.
- **No re-render while either box has focus.** Saving on `change` re-rendered
  the panel and destroyed the input — on mobile that closes the keyboard
  mid-edit. Now renders on `focusout` only once focus has left both.
- The "Range 148–152 ↓" indicator was drawn inside the plot and sat on top of
  the data. Moved to the legend, with "(below/above this view)" when off-scale.

### AI Coach was flying blind

`sendLogChat` built its own context, separate from everything else, and nearly
every field it read didn't exist. It reported "you're not logging calories or
exercise" to a user with 90 days of logs.

- Read `e.date` (food/weight rows have `logged_at`), `e.type` / `e.duration`
  (exercise has `activity` / `calories_burned`), `goals.daily_calories` and
  `goals.target_date` (neither exists → "not set").
- Pulled food and exercise from `state.log` / `state.exerciseLog` = **today
  only**, and weight from `.slice(-7)` labelled "newest first" but sent
  oldest-first, so it described the trend backwards.
- New `buildCoachContext()` reads the same sources as the charts: full
  weigh-in history (last 14 + 8 weekly averages), 30 days of per-day
  calories in / burned / net / exercise names, top foods, and the active phase
  incl. plan-vs-actual. Explicitly tells the model that a missing date means
  nothing was logged and that today is partial.
- Note `buildClaudeContext()` (the Recipes chat) is a *different* builder and
  was already fine — don't confuse the two.

### Other fixes found along the way

- **Two goals panels rendered on the Log tab** (a legacy copy in the header
  block) with duplicate ids, so the Save button and start-date field the user
  could see did nothing. Legacy copy removed.
- **Supabase 1000-row cap**: `fetchWeightLog` was unpaged and sorted
  oldest-first, so past ~1000 weigh-ins it would silently drop the *newest*
  rows and current weight would stop updating. New `selectAllPages()` helper;
  also applied to the full food/exercise history.
- Day queries used `<= 23:59:59`, dropping anything in the last second of a
  day. Now `< next local midnight`.
- Goals & Targets bar moved to sit directly above the chart it configures.

**Learned**
- Never `querySelectorAll().forEach(addEventListener)` for the new controls —
  period arrows, calorie rows and phase buttons all go through
  `weightChartDelegation` (document-level, set up once).
- Rendering the chart with realistic data caught four things the unit tests
  couldn't: a "plan +10 lb" summary across a phase reset, maintain centring on
  the range middle instead of the baseline, dots piling into a chain in `All`,
  and a clipped month label. Rasterise and *look* at it.
- Mutation-testing the new tests (breaking `wcMondayOf`, swapping the DST-safe
  day diff for a midnight/floor one) confirmed they actually fail — worth the
  two minutes.

**Testing**
- `wc_test.js` added at repo root, same runtime-extraction pattern as
  `gp_test.js` (do NOT paste copies of `main.js` functions into it). Pins
  `process.env.TZ = 'America/New_York'` so DST cases are real.
- `npm test` now runs `gp_test.js && wc_test.js` — 10 + 27 passing.
- Harness rebuilt again (esbuild + jsdom, stubbed `db.js`/`supabase.js`,
  SVG → PNG via cairosvg). Not in the repo.

**Open / next**
- Confirm `goal_phases.sql` ran cleanly and the range boxes are live. If the
  Retry block still shows, the policy lines at the bottom of the SQL are the
  likely cause — other tables' policies may differ.
- Exercise history preloads 30 days, food 90. The coach is told so, but a
  question about last spring's training gets nothing. Widen or query on demand.
- `2W` is currently last week + this week. Revisit if "this + next" reads
  better in use.
- Still open from 09-23: app-wide UTC `toISOString().slice(0,10)` for "today"
  (the new chart/calorie code uses local `wcLocalDateStr`, the rest doesn't);
  debug logging in the Plan path.
- Still open from 09-20: confirm Serious Eats clip works post-deploy.
- Still open from 09-18: "▶ Start Cooking" sets `gamePlanView = 'fullscreen'`
  with no renderer.

---

## 2026-09-23

**Shipped** — `src/main.js` (all three confirmed working on device)

**Tonight banner "Cook now" did nothing in some cases.** The happy path
worked; it silently failed when the recipe was hidden by search / tag filter /
archive (cook mode set on a card that wasn't rendered), when tapped from the
List tab (never switched tabs), or when the meal-plan entry had no
`recipe_id` (`data-cook-mode="null"`).

- New module-level `openCookMode(recipeId)`: switches to Recipes, sets
  expanded + cook mode using the recipe's native id, and if the card isn't in
  the DOM after render, clears search / tag filter / sets `showArchived` to
  match, then re-renders and scrolls. The card's own Cook button uses it too.
- New `findPlannedRecipe(entry)`: id match (string-compared), falls back to
  exact name match. Banner uses it; truly unlinked entries show
  "Open in Week →" instead of a dead button.
- Banner button is now `data-tonight-cook`, handled by document-level
  delegation (`tonightCookDelegation`, next to `chatDelegation`).

**Week tab: slot 📋 Plan opened two plan windows** when the recipe's inline
preview was open. `renderRecipeCard`'s `gpMatchesCard` fallback matches any
expanded card for a plan with no `recipeId`; the calendar preview reuses
`renderRecipeCard`, so the plan drew in the preview and under the slot.
Fallback now skipped when `state.tab === 'calendar'`.

Also: the 📋 Plan button in the cook-mode header opened **zero** windows on
both tabs — cook mode is checked before the game plan in `renderRecipeCard`.
The `data-plan-recipe` handler now sets `state.cookMode = null` first.

**Cook mode Ask AI: opened below the tabs, and double-taps closed it.** The
toggle awaited `db.fetchRecipeChat` before the first render, so the tap looked
dead; a second tap flipped `cookAskOpen` back and the late render drew it
closed.

- Panel now renders between the dark header and the tabs.
- Toggle renders immediately; history loads in the background with a
  "Loading earlier questions…" line (`state.cookAskHistoryLoading`). The
  post-fetch re-render only runs if still open, won't overwrite messages sent
  meanwhile, and preserves the input's draft and focus.

**Learned**
- `renderRecipeCard` is reused inside the Week tab preview. Any card-level
  "show this panel" condition that isn't keyed to the recipe id will also fire
  there — check both tabs when touching its early-return branches.
- Never `await` a network call before the first render of a toggle. Render the
  new state, then fetch.
- Repro harness that worked well: esbuild-bundle `src/main.js` with stubbed
  `db.js` / `supabase.js` (window-backed `fetchRecipes` / `fetchMealPlan`),
  run in jsdom, click real buttons. Not in the repo — rebuild if needed.
- Verified: syntax check clean, `npm test` 10/10 on each change.

**Open / next**
- "Today" is computed with `new Date().toISOString().slice(0,10)` (UTC)
  throughout. In New York after 8pm EDT that's tomorrow — the Tonight banner
  and Week tab can show the wrong day in the evening. App-wide; needs a local
  date helper.
- Leftover debug logging in the Plan path fires on every tap:
  `console.log('Plan button: key=…')`, `console.log/trace` in
  `generateGamePlan`. Remove.
- Still open from 09-20: confirm Serious Eats clip works post-deploy.
- Still open from 09-18: "▶ Start Cooking" sets `gamePlanView = 'fullscreen'`
  with no renderer.

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
