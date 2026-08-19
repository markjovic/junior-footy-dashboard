# Outstanding Tasks

**Repo:** `markjovic/junior-footy-dashboard`  
**Last updated:** 2026-08-19 (Beta 0.191, engine v19, store v6, audit v16)

This document is the single place for anything that needs a decision, an action
from you, or work from me. Read top to bottom; the order is priority.

---

## YOUR ACTIONS — do these now

### 1. Delete `probe-ser-logos.js` and its workflow by hand

These two are in no tidy group, so `repo-tidy.js` cannot remove them. Delete
through the GitHub web UI:

- `scripts/probe-ser-logos.js`
- `.github/workflows/probe-ser-logos.yml`

### 2. Delete `data/orgs` (NOT YET — no weekend has passed)

**Status 2026-08-16: DO NOT DELETE.** `data/orgs` was created on 2026-08-12 and
no full Saturday–Sunday of scheduled results runs has elapsed since. Four days is
not a weekend.

**Wait for:** a full weekend of stable scheduled results runs.
**How:** GitHub web UI → navigate to `data/orgs/` → delete the directory.
**Why:** 105.25 MB rollback path. The audit reports it as INFO every run until
it's gone.

### 3. Delete `data/data.json` if still present

The rollback path from the 2026-08-11 per-organisation split. Nothing reads
or writes it.

### 4. Upload `scripts/verify-per-season.js`

One line of the `lastRound` removal is still outstanding — the `'lastRound'`
entry in `store.js`'s `CORE_KEYS`. That suite has 53 assertions over `store.js`
and has not been read, so removing the line blind risks a red run nobody can
diagnose. Everything else came out on 2026-08-16. See B3 below.

Also worth running once: `scripts/report-field-usage.js` for `lastRound`. It could
not be run during the removal, so the check covered only the files to hand.

### 5. Run Build Club Index after the next results run

`results-engine.js` v13 writes `teamOrg` directly from PlayHQ for teams whose
rounds were previously skipped. Run **Build Club Index** with no filter once a
results run has landed, to pick them up.

---

## YOUR DECISIONS — needed before work can start

### D1. Concurrent competitions — LARGELY RESOLVED 2026-08-13

Resolved by `grade_attribution_split_design.md`. Grading grades get their own tab
and standalone ladder; every other grade is listed by `m.gradeId` and counts only
when both teams' current grades agree.

**Residual, accepted deliberately:** a short-form competition NOT named "grading"
— SEJ's Lightning Premiership, WFNL's Lightning Cups, YJFL's pools — takes the
fallback, so its games are listed but count towards no ladder. Detection is by
name because nothing structural separates the two cases; a defunct-grade test was
tried and measured 38%. Raise this again if a league's naming makes it matter.

### D3. URL state / deep linking

The competition, age, and year are not in the URL. Sharing a link opens the
default view for everyone. No design written. The edge cases are a URL naming a
year whose files are not loaded, a competition absent from that year, and an age
group with no data.

**Is this worth building?**

### D4. Cross-season player search index

Search currently covers only the selected season. An index of uuid + name +
seasons would span all 18 seasons.

**CORRECTION 2026-08-16 — the 5.67 MB figure is SOUND. The earlier note here
saying it was inflated was wrong.** Section 8 builds the index from a `Set` of
season ids per person, so a person holding two records in one season contributes
one season entry, not two. Verified by execution against a fixture of 240 records
/ 200 person-seasons / 100 people: the serialised index carried exactly 200
season entries. The byte figure was never counting records.

The reported average and one label WERE wrong — records printed where it said
"player-season", and records divided by people, giving 2.54 where the truth is
2.27. **Fixed in audit v16 on 2026-08-16**, with assertions in `verify-audit.js`
section 4d-bis that fail if it reverts. A display defect, not a sizing one; the
decision is unchanged.

**Do you want this built?** The number is 5.67 MB, loaded on first keystroke.

### D5. The twelve new organisations

`config.json` covers five organisations. Twelve more are in
`organisationCodes[]` but need short names before they can be added — the
short name becomes half of every match id. F&DJFL is one of them, and its
absence is why representative-football rows on the player card show a dash.

**Which do you want to add, and what short names?**

---

## BLOCKED ON ONE FILE — `scripts/verify-per-season.js`

### B3. Remove the last `lastRound` line from `store.js`

`lastRound` was removed from five of six files on 2026-08-16 (engine v19, Beta
0.176, audit v16, both suites). What remains is one entry in `CORE_KEYS`:

```
'lastRound',   // compName|age|gradeId -> highest home-and-away round
```

While it is there, `store.load` still copies any stored map into memory and
`store.save` still writes it back, so a stale `lastRound` survives in
`core.json` — inert, since nothing reads or writes it. Audit section 9 reports it
as RETIRED with its count every run, and raises INFO while it is non-empty, so it
cannot be forgotten.

Removing the line needs `verify-per-season.js` updated in the same delivery.

## ACTIONS FOR ME — ready when you say go

### A1. Fix `repo-tidy.js`'s reference classifier (HIGH)

`repo-tidy.js` reports a mention in a `.yml` workflow or a `.js` script as
"Mentioned in documentation only". It is matching on filename, not on whether the
mention is live code. On 2026-08-13 it classified `.github/workflows/verify-store.yml`
and `scripts/probe-team-join.js` that way. Both turned out to be comments, so the
verdict was right twice by luck — a real `require()` would have read identically
and the REFUSED guard would not have fired.

Upload `scripts/repo-tidy.js` and say "go".

### A2. Fix the stale empty-`rawGrade` audit warning

The warning says the affected grades share a ladder "until build-order step 6".
Step 6 is done — ladders group by `gradeId` — so the sentence is wrong. Fold into
the next `audit-data.js` delivery.

### A8. Settle the `discoverFixtureByRound` contradiction

`dashboard_context.md` §8 says completed rounds return 0 games once fetched.
`probe-concurrent-comps.js` re-served full game lists across all 68 calls on
2026-08-13. One is wrong, and A9 is blocked until it is settled — that cleanup
would delete records. Resolution needs a targeted probe: fetch a known completed
round and compare against what is stored. I can write it; you run it.

### A9. Clean up pre-v16 rename duplicates

Engine v16 stops new ones; records written before it have no `gameId` so it cannot
match them. Six are still on the SEJ 2026 U10 Girls A ladder. Safe rule: within a
(gradeId, round) where at least one record carries a `gameId`, any record without
one is superseded. **Live seasons only** — retired seasons are never re-fetched,
so their records will never acquire a `gameId`. Blocked on A8.

### A10. Cross-season player search index

If D4 approved: 5.67 MB index, loaded on first keystroke. Results show the
player's seasons; opening one fetches that season's player file only.

### A11. Phase B player stats for new organisations

When new organisations are added (D5), they need a backfill run with
`STATS_INCLUDE_RETIRED=true`. Standard procedure once the orgs are configured.

---

## MONITORING — after every scheduled run

1. **Verify storage layer** — runs automatically; check Actions tab for green
2. **Audit data** — 0 errors is the target; warnings are expected and documented
3. **The dashboard** — Season selector, a live ladder, Scorers for the week

---

## DEFERRED

### Probe scripts

`probe-team-join.js` and `probe-finals-rounds.js` are kept as reusable
diagnostics. `probe-ser-logos.js` answered its question — see action 1.

### `repair-scheduled-results.js`

Kept rather than tidied. Engine v18 stops the defect at source, but this is the
only tool that can reach a contaminated record whose round is no longer walked,
and it is idempotent, so it costs nothing to leave in place.

### `team_registry_design.md` open questions

Four open questions remain. Not urgent; review when `discoverTeams` behaviour
needs to be pinned down for a future feature.

### Grade identity migration — 49 remaining records

Self-healing YJFL bye sentinels. No action needed unless the count grows.

### `assets/clubs/**` directory

~10.7 MB of club badge assets confirmed dead. The `assets` group in
`repo-tidy.js` will remove them. Include in a future tidy run.

---

## WHAT CHANGED ON 2026-08-18/19

- **Club summary: a gold top-grade figure on every measure** (0.186), replacing
  the standalone Top grade column, and **a "most teams in top grade" sort** (0.187)
  counting teams ENTERED in the strongest grade. Both numbers in a cell are a
  share of teams entered — one denominator for the whole table (0.187 added the
  percentage to the gold Entered figure).

- **Team drilldown: finals were being shown as ordinary rounds** (0.188–0.189).
  Finals rounds restart at 1, so sorting on `m.round` put Finals Round 1 beside
  home-and-away round 1 — the list showed two "Rd 1" rows and two "Rd 2" rows and
  read as duplicates. Finals now sort last and print FR1/PF/GF. Season totals
  include finals, MR% and Pct stay home-and-away as ladder figures, and a third
  breakdown cell carries the finals split.

  **Two layout regressions in the same change**: a seventh stat cell in a
  `repeat(6,1fr)` grid and a third breakdown cell in `1fr 1fr` both wrapped to a
  second row. Recorded in `working_practice.md`.

- **Player panel: the header summed nothing** (0.190–0.191). `fetch-stats.js`
  stores one record per grade, and the strip read `S.players.find(uuid)` — the
  first of them — while the list below is a live per-player fetch showing every
  team. Measured on one player: U12 B 16 games / 28 goals plus U13 B 2 / 1, so the
  strip said 16 and 28 above a list of 18 and 29. Now summed across the season,
  with the split on a tooltip and a "+ N other teams" note.

  **Season scoping caught before release:** picking the primary record by games
  played across everything loaded made a 2026 view show 2025's totals, because a
  finished season has more games than a part-finished one.

  Rows also carry their AGE GROUP beside the grade, which is what made the U13
  games look like duplicate rounds with wrong results.

- **Confirmed on the live site:** the grading-pool club filter (0.181) works.

## WHAT CHANGED ON 2026-08-17

- **Finals by-club, four additions.** GF-first columns with per-grade gaps kept
  (0.179); ladder position on every row, keyed on the LADDER grade so a promoted
  team is not shown a dash; an ALL TEAMS switch, default off, holding
  non-finalists on `extraTeams` rather than merging them into `e.teams` and
  restating every existing figure; and a VALUES / % sort basis (0.180) — a big
  club wins a count almost by size alone.

- **Rank column** (0.182). Standard competition ranking, 1/2/2/4. Ties come from
  the measure the reader picked, not from `cmpEntries`, which always separates two
  clubs and would make the column the row index.

- **Two live defects fixed** (0.181), both silent and both passing the suite:
  - The "4 of 8" grade tag counted every grade TWICE. `buildGradeMeta` writes each
    ranked grade under its id AND its rawGrade, and `gradeTierCount` counted keys
    by prefix. U14's four grades reported eight. Now counts entries carrying
    `gradeId` with `r > 0`, which deduplicates exactly and drops grading grades.
  - **Grading pools are shared across leagues**, so EFNL's own records contain
    games played by YJFL, SER and SEJ clubs' teams. The compName really is EFNL
    and `teamClub` resolves each team correctly, so nothing was "wrong" — but the
    club summary listed dozens of clubs that never entered, inflating every
    percentage. A team whose records in a competition are confined to grading
    grades is now excluded. The test is structural, not the club's name: PlayHQ
    names carry a parent association in brackets, and a club may legitimately
    field teams in more than one league. **Confirmed working on the live site.**
    Needs a paragraph in `docs/playhq_api_reference.md` — drafted, not yet added.

- **Sticky club-summary headings** (0.183–0.185), and two regressions on the way:
  - `.main{overflow:hidden}` was a scrollport that never scrolls, so the headings
    anchored to it and sat still. Now `overflow-x:clip`.
  - `body` was changed to `clip` at the same time to satisfy a CSS assertion. That
    removed the scrollport `.hdr` sticks to and **broke the page header on the
    live site**. Body must stay `overflow-x:hidden`.
  - The header releases after one viewport anyway — its containing block is body,
    which is `height:100%` — so a constant 52px offset left the headings floating
    with rows above them. `--sticky-top` now tracks the header's bottom edge each
    frame, clamped at zero.

- **`verify-dashboard-grades.js` v14: 127 → 259.** Sections for the venue view,
  the club summary, GF-first columns, the sort basis, the rank column, and both
  0.181 defects.

  **Section 22a (CSS assertions) was REMOVED.** It passed while the feature was
  broken, took three attempts to make work, and drove the `body` regression above.
  `working_practice.md` already said layout does not belong in a suite; this is the
  evidence for that rule rather than an exception to it. The behavioural half
  (22b) stays — it fires real events and caught a genuine rAF scheduling bug.

  **Going forward: a change that can only fail visibly ships as `index.html`
  alone** — one commit, no suite upload, no intermediate red run.

- **Harness upgraded.** `window.addEventListener` was missing (a real load-time
  crash was being hidden), `style` was a bare object so custom properties could not
  round-trip, and `requestAnimationFrame` was a noop so throttled functions never
  ran.

## WHAT CHANGED ON 2026-08-16 (late)

- **Finals BY VENUE: either nesting** (Beta 0.177). `DATE › VENUE` or
  `VENUE › DATE`, one renderer serving both so they cannot drift. Neither is a
  filter — the same matches appear both ways — so it is a grouping switch beside
  the mode buttons, not a sort.

  **A bug found by rendering both side by side:** in venue-first the maps link
  disappeared. The outer heading was plain text and the inner heading had become a
  date, so `venueUrl` had nowhere to render. The link and suburb now follow the
  venue to whichever level shows it.

- **Jump to a date or venue.** A select in the sidebar, populated from
  `fvGroupIndex` — written by the renderer as it draws, so the list is built from
  what is actually on the page rather than derived separately from the pool.
  Group ids come from the key, not a loop index, so a stale selection misses
  rather than scrolling somewhere arbitrary.

- **Club summary table** (Beta 0.177, extended 0.178). One row per club above the
  cards, collapsed by default, with columns Entered / Finals / Top grade /
  Remaining / GF / Premierships and a percentage of Entered on each.

  **Clubs that reached no finals are included**, which needed `finalsFilters()`
  factored out of `finalsPool()` and a new `enteredPool()`. Both share the one
  filter: applied to one pool and not the other, 6 of 40 and 6 of 12 both look
  like ordinary numbers. Counting identity is `comp|team|age` with no grade, or a
  team that played grading and was then placed counts twice and the percentage
  goes over 100.

- **`verify-dashboard-grades.js` v7: 127 → 184.** New section 21 (the venue view,
  both nestings, the jump list, TBC ordering) and section 22 (the summary's
  denominators, percentages and collapse).

  **Three of five reintroduced defects passed on the first attempt** — the fixture
  could not distinguish them. Fixed by adding a team in two grades, a record in
  another competition, and a venue sorting after "Venue TBC". Recorded in
  `working_practice.md`: ask of every fixture whether it would give a different
  answer if the code were wrong in the way being guarded against.

## WHAT CHANGED ON 2026-08-16 (evening)

- **`lastRound` removed** — engine v19, Beta 0.176, audit v16, both suites. The
  round tag on the ladder grade tabs is gone, and with it the reader, the writer,
  the per-competition merge, `lastRoundKey()` and its export. It never drove
  fetching: `knownRounds` does that, built in memory, so the round walk is
  unchanged. One line survives in `store.js` — see B3.

  Audit section 9 no longer shape-checks the key. It reports it as RETIRED with a
  count, and raises INFO while any entry remains, so the remnant announces itself
  every run rather than sitting silently in `core.json`.

- **Audit section 8 divides by person-seasons** (v16). `fetch-stats.js` stores one
  record per grade, so a child in two grades in one season counted as two seasons.
  **The BYTE figure was never wrong** — the index is built from a `Set`, so a
  second record in the same season adds no entry. Verified against a fixture of
  240 records / 200 person-seasons / 100 people: the serialised index carried
  exactly 200 season entries. The "inflated" note in D4 is retracted.

- **Finals view: BY VENUE** (Beta 0.176). A fourth mode, grouped by date then
  venue, ordered by start time. Undated matches group under "Date TBC" placed
  LAST, because an empty string sorts before every real date. Dates formatted
  through `Date.UTC` on split parts, never `new Date(string)`. Checked against
  EFNL 2026 Veterans.

- **`verify-audit.js` v5: 66 → 79.** Section 4d retargeted onto `gotwFlags` and
  the RETIRED report; new section 4d-bis covers audit sections 8 and 11 — which
  closes A7, whose first attempt had passed vacuously because the fixture's player
  records carry no `uuid`. Three defects reintroduced and all caught: dividing by
  records again (2 fail), deleting the RETIRED line (2 fail), deleting the
  person-seasons line (1 fail).

- **`verify-backfill.js` v7: 148 → 126.** The `lastRound` assertions came out
  across sections 1, 4, 4a, 8, 10 and 7, plus the fixture seed. The
  merge-not-replace property they protected is still covered — `compLogos` is the
  other core key assigned wholesale and had the identical defect. The count is a
  static one; the first CI run confirms the runtime figure.

- **A diagnostic that lied.** Two new section 11 assertions reported section 10's
  table in their failure message: both tables have rows beginning `EFNL 2026`
  followed by numbers, and the detail regex ran over the whole log. The assertions
  were right, the message pointed at the wrong table. Now sliced to the section
  under test. Recorded in `working_practice.md`.

## WHAT CHANGED ON 2026-08-16 (afternoon)

- **A result merged into a fixture kept the `scheduled` flag.** Engine v18 and
  Beta 0.175. `fetch-fixtures.js` writes its record under the same match id the
  results engine builds, so a played game merges into it at `{ ...prev, ...m }` —
  and a result record has no `scheduled` key, so nothing overwrote
  `prev.scheduled` and `true` survived. The record kept correct scores and stayed
  classified as a fixture, so it never reached `S.matches` and the finals view
  drew it with blank score cells.

  **It hid itself twice.** The scores merged in on the first run after the game,
  so every later run found them equal, reported `0 new, 0 updated`, and skipped
  the commit — a log byte-comparable to a run with nothing to do. The fix counts
  the promotion as an update so the run commits.

  Measured on EFNL 2026 Veterans: four Semi Finals records with hScore 59, 33, 86
  and 68, all flagged `scheduled`. Confirmed repaired by two signals, not one —
  the flag is gone AND `hLogo`/`aLogo` are gone, and the logo strip returns early
  on scheduled records, so only a pass that saw them as results could have
  stripped them.

- **Upcoming Fixtures joined the grade filter on the wrong key.** Beta 0.175.
  `renderFixtures` tested `grades.has(m.rawGrade)` against a Set of PlayHQ grade
  IDs, so it matched nothing and the empty-list guard hid the whole section. With
  99.91% of records migrated that was every fixture. The grade tag and the
  `openTeamDrilldown` argument in the same function had the same defect. All
  three now use `matchListGrade(m)`, as `renderResults` already did.

- **`repair-scheduled-results.js` v1 and its workflow.** Offline, no PlayHQ calls.
  Clears the flag from records the engine cannot reach — a round holding one
  proper result is skipped as already stored, a grade whose season has ended is
  skipped entirely, and archived seasons are out of scope for `fetch-results.js`.
  Rule: `scheduled === true`, any score field non-zero, and no date or a date of
  today or earlier. Future-dated records carrying a score are listed, never
  repaired.

  **Its first run measured the scope: 84 scheduled records across all eighteen
  seasons, none carrying a score.** The contamination was finals-only —
  home-and-away results were never affected.

- **`verify-backfill.js` v6**: section 13, 16 assertions, 132 → 148. Verified by
  reintroducing the defect: against engine v17 it fails 8, including "both records
  now reach S.matches — 0" and "neither is left in S.fixtures — 2".

- **Section 8's sizing re-measured** and the "inflated" note retracted — see D4.

## WHAT CHANGED ON 2026-08-16 (morning)

- **Grade attribution rebuilt** (Beta 0.166–0.174, engine v17).
  `matchGrade()` split into `matchListGrade` and `matchLadderGrade`, plus a
  `matchCounts` predicate. Grading grades get their own tab and standalone ladder
  and count every game in their rounds. `aggregatePlayers` gives one Scorers row
  per person per season with `gp` and `goals` summed.
- **Engine v15**: a past-dated round with no results no longer stops the round
  walk. Recovered four rounds and eight games in SEJ `cb7b3db3`.
- **Engine v16**: `gameId` supersede stops rename duplicates.
- **Engine v17**: grading grades get a `gradeMeta` entry with `r: 0`,
  `grading: true` and PlayHQ's verbatim `name`.
- **Audit v13–v15**: phantom round gaps removed, sections 10 and 11 added.
- **Player card**: Res and Score columns, joined from `S.matches`.
- **One palette for a result everywhere**: green win, red loss, orange draw.
- **Finals by-club sort**: premiers, then by how far each team got.

## WHAT CHANGED ON 2026-08-13

- **`lastRound` and `gotwFlags` re-keyed** (Beta 0.165, engine v14). `lastRound`
  was never read at all — writer `age|rawGrade`, reader `compName|age|gradeId` —
  so the round number on the ladder grade tabs was blank from Beta 0.133.
  `gotwFlags` was `age|roundKey`, colliding across competitions AND seasons, but
  no pick had ever been made so there was nothing to migrate.
  `docs/lastround_gotw_keying_design.md`. **Superseded 2026-08-16: the tag was not
  wanted, so the key came out — engine v19 and Beta 0.176. Only the `store.js`
  CORE_KEYS line remains; see B3.**
- **`report-field-usage.js` v2 and its first workflow.** SOURCES went from 8 files
  to 18. There had been no workflow at all, so the tool built to prevent the next
  `hLogo` incident had never been runnable.
- **Repo Tidy applied**: 18 files, 164K.
- **`probe-team-join.js` v4**: reads through `store.load` instead of walking
  `data/orgs`.
- **SER unattributed clubs resolved**: 566 SER teams. `build-club-index.js` v4
  adds a `teamLogos` fallback. 0 unattributed teams remain.
- **`results-engine.js` v13**: `organisation { id }` on the fixture query.

## WHAT CHANGED ON 2026-08-12

- **Per-season storage layout**: `data/orgs` → `data/seasons`.
- **Page load**: 26.27 MB → ~5.4 MB. Players deferred past first paint.
- **Store.js v5**: write-only-if-changed; player-file blank guard.
- **Grade identity migration**: 99.91% complete.
- **Two data-loss incidents**: both recovered; both now guarded.
