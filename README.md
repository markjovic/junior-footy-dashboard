<!-- README.md -->
# Local Footy Dashboard — Beta 0.191

A single-file HTML dashboard for AFL football results, automatically fetched from PlayHQ. Renders a live ladder, results, top scorers, Game of the Week, finals progress, and player profiles across all age groups and grades for multiple competitions simultaneously.

**Live URL:** `https://markjovic.github.io/junior-footy-dashboard/`

---

## Repo structure

```
index.html                  ← Single-file dashboard PWA (all HTML/CSS/JS)
config.json                 ← Competition config (season IDs, VIP flag, grade exclusions)
manifest.json               ← PWA manifest (home screen install)
sw.js                       ← Service worker (offline support, cache-first shell)
favicon.ico                 ← Browser tab icon
README.md
data/
  core.json                 ← Manifest + cross-organisation keys (clubs, teamClub, teamOrg,
                              teamLogos, compLogos, gotwFlags) — NOT match data
  grades.json               ← Grade cache (auto-populated by fetch workflow)
  clubs.json                ← Club id → name cache (auto-populated by club index workflow)
  seasons/
    <seasonId>-core.json    ← matches, roster, gradeMeta, meta — one file per season
    <seasonId>-players.json ← player records — one file per season
docs/
  dashboard_context.md      ← Repo-specific rules, traps, current state
  finals_support.md         ← Finals implementation notes
  working_practice.md       ← Portable conventions (shared with other projects)
  playhq_api_reference.md   ← PlayHQ behaviour (shared with sports-players-stats)
  OUTSTANDING_TASKS.md      ← Work queue
  project_setup.md          ← Claude project setup notes
workers/
  footy-cron.js             ← Cloudflare Worker — dispatches the fetch workflow
.github/
  workflows/
    fetch-results.yml       ← results + stats + fixtures (dispatch only; Worker schedules it)
    verify-store.yml        ← ALL verify suites — runs automatically on every push
    backfill.yml            ← Manual — retired seasons, has comp and dry_run inputs
    build-club-index.yml    ← Manual — rebuilds the club index
    discover-seasons.yml    ← Manual — run before a backfill when a season appears
    audit-data.yml          ← Manual, read-only — data audit
    repair-scheduled-results.yml ← Manual, offline, no PlayHQ calls
    cleanup-rename-duplicates.yml ← Manual, offline; dry run by default
    repair-duplicate-names.yml ← Manual, online; dry run by default
    probe-refetch-round.yml ← Manual, read-only diagnostic
    repo-audit.yml          ← Manual, read-only — inventory, duplicates, orphans
    repo-tidy.yml           ← Manual — removes dead files, dry run by default
    probe-finals-rounds.yml ← Manual, read-only diagnostic
scripts/
  lib/
    store.js                ← Per-season storage layer — EVERY writer goes through it
    results-engine.js       ← Match processing, shared by fetch-results and backfill
    playhq.js               ← Session and transport — never write a local getSession()
  fetch-results.js          ← Match results + grade metadata from PlayHQ
  fetch-stats.js            ← Player statistics from PlayHQ
  fetch-fixtures.js         ← Future scheduled fixtures from PlayHQ
  backfill.js               ← Results and player stats for retired seasons
  build-club-index.js       ← Resolves teams to PlayHQ clubs
  discover-seasons.js       ← Discovers seasons per organisation; writes the manifest
  discover-orgs.js          ← Discovers organisation ids from PlayHQ search
  migrate-grade-ids.js      ← One-off (idempotent): rewrites match ids to carry grade ids
  rebuild-grade-meta.js     ← Offline: regenerates gradeMeta for every stored season
  repair-scheduled-results.js ← Offline: clears a stale `scheduled` flag from real results
  cleanup-rename-duplicates.js ← Offline: removes a duplicate left by a team rename,
                              where one of the pair carries PlayHQ's gameId
  repair-duplicate-names.js ← Online: the same, where NEITHER does — asks PlayHQ
                              which name it still serves
  probe-refetch-round.js    ← Read-only: does discoverFixtureByRound re-serve a
                              completed round? (it does, settled 2026-08-19)
  split-by-season.js        ← One-off migration: data/orgs → data/seasons
  audit-data.js             ← Read-only data audit (sizes, gaps, grade identity, coverage)
  report-field-usage.js     ← Which scripts reference a stored field. SOURCE files only —
                              it does NOT scan verify-*.js, so check those by hand
  report-grade-collisions.js  ← Grades that collapse to the same age|rawGrade key
  repo-audit.js             ← Read-only repo inventory and dead-file report
  repo-tidy.js              ← Removes dead files; dry run unless --apply
  probe-finals-rounds.js    ← Diagnostic: round structure and numbering
  probe-team-join.js        ← Diagnostic: stored team names against the season registry
  verify-per-season.js      ← store.js and split-by-season.js
  verify-backfill.js        ← backfill.js, fetch-results.js, results-engine.js
  verify-discover-seasons.js
  verify-migrate-grade-ids.js
  verify-dashboard-grades.js  ← index.html silent failures
  verify-rebuild-grade-meta.js
  verify-audit.js           ← audit-data.js
assets/
  icons/
    icon-192.png            ← PWA home screen icon (192×192)
    icon-512.png            ← PWA home screen icon (512×512)
```

Data is **105.25 MB across 36 season files** (18 seasons × core + players), plus
`core.json`. Player records are 78% of that (82.57 MB), which is why they live in
their own file: the dashboard fetches only the core files on load — about
**5.4 MB** for five live seasons, down from 26.27 MB under the old single
`data.json` — and pulls players after first paint via `requestIdleCallback`.

53,606 match records, 179,624 player-season records, 70,672 distinct people.
Run **Repo Audit** for the file picture and **Audit Data** for the data picture.

`workers/footy-cron.js` is the source of truth for the schedule, but the running
copy lives in the Cloudflare dashboard — editing this file alone changes nothing.



---

## Documentation

Absolute URLs so they can be followed directly from this page.

> ### ⚠️ WORKING WITH CLAUDE — PASTE THE BLOCK BELOW AS YOUR FIRST MESSAGE
>
> Claude's fetch tool refuses any URL that has not already appeared in the
> conversation. It rejects the request **before** making it, with
> `PERMISSIONS_ERROR: This URL was not in any prior search or fetch result`.
>
> This is not about knowing where the file is. Claude can read the repo slug from
> any of the docs and build the correct URL, and it will still be refused —
> a URL assembled from knowledge does not count. **Pasting the block puts the
> literal strings in the conversation, which is the only thing the tool checks.**
>
> Without it a session will burn several exchanges on "I can't reach that file",
> and Claude will ask you to upload files that are already in the repo. It cannot
> browse folders either, so a URL not in this list cannot be reached — if you add
> a script, add it here.

```
https://github.com/markjovic/junior-footy-dashboard/blob/main/README.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/dashboard_context.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/working_practice.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/playhq_api_reference.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/finals_support.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/OUTSTANDING_TASKS.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/project_setup.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/index.html
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-results.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-stats.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-fixtures.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/build-club-index.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/backfill.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/audit-data.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/discover-seasons.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/migrate-grade-ids.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/rebuild-grade-meta.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/split-by-season.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/report-field-usage.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/repo-tidy.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/cleanup-rename-duplicates.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/repair-duplicate-names.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/repair-scheduled-results.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/probe-refetch-round.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/lib/store.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/lib/results-engine.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/lib/playhq.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/verify-per-season.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/verify-backfill.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/verify-dashboard-grades.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/verify-audit.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/verify-migrate-grade-ids.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/verify-discover-seasons.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/verify-rebuild-grade-meta.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/workers/footy-cron.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/config.json
```


| Document | Purpose |
|---|---|
| [dashboard_context.md](https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/dashboard_context.md) | Repo-specific conventions, standing traps, current state |
| [working_practice.md](https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/working_practice.md) | Portable delivery and verification rules |
| [playhq_api_reference.md](https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/playhq_api_reference.md) | PlayHQ API behaviour — **shared with `sports-players-stats`** |
| [finals_support.md](https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/finals_support.md) | Finals implementation notes |
| [OUTSTANDING_TASKS.md](https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/OUTSTANDING_TASKS.md) | Work queue |
| [project_setup.md](https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/project_setup.md) | Claude project setup |

---

## First-time setup

1. Fork or clone this repo
2. Enable GitHub Pages: **Settings → Pages → Source: main branch / (root)**
3. Set workflow permissions: **Settings → Actions → General → Workflow permissions → Read and write**
4. Edit `config.json` with your competition season IDs (see below)
5. Trigger the fetch workflow manually from the **Actions** tab
6. Run **Build Club Index** once results exist
7. Open the live URL — data populates automatically

### Finding your season ID

Open any fixture page on PlayHQ for your competition. In DevTools (F12) → Network → Fetch/XHR, look for a `gradeListDiscoverSeason` request. The `id` in its payload is your season ID.

---

## config.json

```json
{
  "competitions": [
    {
      "name": "EFNL 2026",
      "seasonID": "2dcbf383",
      "vip": true,
      "excludeGrades": []
    },
    {
      "name": "YJFL 2026",
      "seasonID": "cda2f0ec",
      "vip": false,
      "excludeGrades": []
    }
  ]
}
```

- **`seasonID`** — fixed for the whole season, found via DevTools
- **`vip`** — `true` = fetched on every results run. `false` = fetched on all-comps runs only
- **`excludeGrades`** — substring matches against normalised grade names (e.g. `"Grading"` excludes all grading grades). Empty array = fetch all grades.

> **Warning:** excluded grades are filtered before discovery and do not consume a grade-rank slot. Excluding `"U12 - A"` silently makes `"U12 - B"` the top grade in the finals view's grade-strength ranking. Leave empty unless you accept that.

---

## Storage

`data.json` is **gone**. Since 2026-08-12 the data is split per season, because a
single file made every visitor download 26 MB before a ladder could render.

**`data/core.json`** — the manifest (all 18 seasons with status, dates, compName,
phases) plus the keys that genuinely span competitions and cannot be split:

| Key | Shape | Written by |
|-----|-------|------------|
| `clubs` | `clubId` → `{name, type}` | build-club-index |
| `teamClub` | `"comp\|team\|age"` → `clubId` | build-club-index |
| `teamOrg` | same shape as teamClub | fetch-results |
| `teamLogos` | keyed by bare team name, with NO competition | fetch-results |
| `compLogos` | one per competition | fetch-results |
| `gotwFlags` | `"comp\|age\|roundKey"` → match id | the dashboard's admin panel |

**`data/seasons/<seasonId>-core.json`** — `matches` (including bye/partial
sentinels and scheduled fixtures), `roster` (`"comp\|team\|age"` → current grade),
`gradeMeta` (`"comp\|age\|gradeId"` → `{r, lvl, g, label, gradeId, name}`).

**`data/seasons/<seasonId>-players.json`** — player records. **One record per
GRADE**, so a child who turns out for two teams has two records. Anything that
summarises a *person* must aggregate them.

**Every writer goes through `scripts/lib/store.js`.** `store.load(scope, {players:
false})` returns the shape `data.json` had, `store.save(data, scope)` distributes
it back, `store.saveCore(data)` writes only `core.json`. Pass `players: false`
explicitly — the non-enumerable `__hadPlayers` marker is silently dropped by a
spread, and the guard in `save` is the backstop, not the intention.

**`RETIRED_KEYS`** (store v7) holds keys that have left `CORE_KEYS`. Removing a key
from `CORE_KEYS` stops it being read and written but does **not** remove it from
`core.json` — `save` composes the next core as `{ ...core }` and only overwrites
keys present in `data`. Retired keys are deleted explicitly, on both write paths.
`lastRound` is the only entry so far.

---

## How data updates work

Three fetch scripts plus a club indexer. All can be triggered from the Admin panel.

`fetch-results.js` and `backfill.js` both call **`scripts/lib/results-engine.js`**,
so there is one copy of the match processing rather than two that drift. The engine
is versioned in its own header — v19 at the time of writing — and every script that
produces output read from a log prints a version line, because otherwise a stale
cached copy and a real failure look identical.

### fetch-results.js
Fetches match fixtures and results. Each run:
1. Calls `gradeListDiscoverSeason` to discover all grades for configured competitions
2. For each grade, fetches only rounds not yet stored (skips known rounds, re-checks highest known round every run)
3. Tracks home-and-away and finals rounds as **two independent sequences** — see [Finals](#finals)
4. Partial rounds (some games not yet final) are flagged and re-fetched next run
5. Partial rounds with a later complete round are promoted to complete (forfeit/error)
6. Grades starting mid-season get implied bye sentinels for missing early rounds
7. Emits `gradeMeta` — grade strength rank, junior/senior level, and gender
8. Merges new results through `store.js` and commits

Exits `0` when matches **or** grade metadata changed, `2` when nothing changed, `1` on fatal error.

### fetch-stats.js
Fetches player statistics. Each run:
1. Fetches all pages of `publicGradeStatistics` for each grade
2. Buckets raw appearance records by `uuid|age|compName`
3. For players under multiple clubs: fetches `publicProfileStatistics` to determine current club
4. Same-club multi-team players (e.g. "St Bernards Mixed Davey" + "St Bernards Mixed Hardwick") are correctly identified as one club — not flagged as transfers
5. Resolves each bucket into a canonical player record
6. **Merges into existing `data.players` by `uuid|age|compName`** — records not in this run are left unchanged (other comps, API timeouts)

**Retry logic:** up to 4 attempts with 2s/4s/6s backoff on HTTP errors.

PlayHQ already includes finals appearances in the season totals it returns, so no finals-specific handling is needed here.

### fetch-fixtures.js
Fetches unplayed future fixtures and stores them as `scheduled: true` records with null scores. Purges all existing scheduled records at the start of each run, so stale placeholders self-heal. Handles undetermined finals fixtures — see [Provisional teams](#provisional-teams).

### build-club-index.js
Resolves every team to its PlayHQ club and writes `clubs` and `teamClub` into
`core.json` via `store.saveCore`. Run it after a new season's first results, or
when new teams appear. Resolved clubs are cached in `clubs.json` and never
re-fetched.

Three evidence sources, in order: `teamOrg` (written at fetch time from
`organisation.id`, authoritative), then per-match logo URLs, then `teamLogos` keyed
by bare team name. The third exists because 566 SER teams had their rounds fetched
before `teamOrg` existed and their per-match logos stripped afterwards — the
evidence was in `teamLogos` all along.

---

## Verification

Seven suites run **automatically on every push** to `scripts/**`, `index.html` or
`org-discovery.html`, via `verify-store.yml`. There is no need to run them by hand;
check the Actions tab.

| Suite | Covers |
|---|---|
| `verify-per-season.js` | `store.js`, `split-by-season.js` |
| `verify-backfill.js` | `backfill.js`, `fetch-results.js`, `results-engine.js` |
| `verify-dashboard-grades.js` | `index.html` silent failures |
| `verify-audit.js` | `audit-data.js` |
| `verify-discover-seasons.js` | `discover-seasons.js` |
| `verify-migrate-grade-ids.js` | `migrate-grade-ids.js` |
| `verify-rebuild-grade-meta.js` | `rebuild-grade-meta.js` |

They execute their target scripts as child processes against fixtures, so the code
under test is the committed code.

**They cover things that fail SILENTLY** — a promoted team on two ladders, a scorer
filtered out because their team is not in the roster, `render()` throwing and
hanging the page, a filter joining on the wrong key. **Layout is not tested.** A
regex over `index.html` cannot judge whether a row reads well, has to be rewritten
every time the design changes, and on 2026-08-17 a set of CSS assertions passed
while the feature was broken and then drove a live regression. A change that can
only fail visibly ships as `index.html` alone.

**Two things that have bitten repeatedly**, both recorded in `working_practice.md`:
a fixture must be able to *distinguish* the defect — reintroducing a bug proves
nothing if the data gives the same answer either way — and `report-field-usage.js`
scans **source files only**, so a stored field can still be referenced by a
`verify-*.js` the report never looked at.

---

## Scheduling

Scheduling is handled by a **Cloudflare Worker** (`footy-cron.insanoflash.workers.dev`) which dispatches the GitHub Actions workflow at the correct AEST times. GitHub Actions scheduled crons are not used (unreliable on free plans).

### Cloudflare cron triggers (UTC)

```
10 * * * 7      Saturday  — fires hourly at :10, filtered by the Worker
10 * * * 1      Sunday    — fires hourly at :10, filtered by the Worker
10 * * * 2      Monday    — fires hourly at :10, filtered by the Worker
10 11 * * 4     Thursday 9pm AEST
```

The Worker fires every hour on those days and matches the current UTC day and
hour against its own `SCHEDULE` table, dispatching only on a match. Cloudflare
day numbers differ from JavaScript's: the trigger uses 7=Sat, 1=Sun, 2=Mon, 4=Thu,
while the Worker compares `getUTCDay()` where 6=Sat, 0=Sun, 1=Mon, 4=Thu.

### Effective AEST schedule

| Time (AEST) | Results | Stats | Fixtures | Comps |
|-------------|---------|-------|----------|-------|
| Sat 2pm / 5pm / 8pm | ✓ | — | — | VIP only |
| Sat 11pm | ✓ | ✓ | — | All |
| Sun 11am–4pm hourly | ✓ | — | — | VIP only |
| Sun 5pm | ✓ | ✓ | — | All |
| Sun 8pm | ✓ | — | — | VIP only |
| Sun 11pm | ✓ | ✓ | — | All |
| Mon 3am | ✓ | — | — | All |
| Mon 9am | ✓ | — | — | VIP only |
| Mon 12pm | ✓ | ✓ | — | All |
| **Mon 9pm** | — | — | ✓ | All |
| **Thu 9pm** | — | — | ✓ | All |

Stats run alongside results wherever the dispatch is `fetch=both`. Fixtures run
only on their own two slots.

> **Finals caveat.** Elimination in the finals view depends on the next round's
> fixture being published — a team that lost and has no fixture after it is out.
> Fixtures refresh only on Monday and Thursday evenings, so from the final
> whistle on Saturday until Monday 9pm the next round is not yet loaded and teams
> that lost a qualifying final can read as eliminated when they are not. During
> finals, consider adding a Sunday evening fixtures run.

`grades.json` and `gradeMeta` are **merged per competition**, so a VIP-only run refreshes EFNL and leaves the other four competitions untouched.

---

## Finals

PlayHQ **restarts finals round numbering at 1 in every grade**. Verified across all 249 grades: 158 have finals, all numbered from 1, while home-and-away rounds run to 14–18. A Grand Final and Round 1 therefore both carry `round: 1`.

### Round identity

Match ids carry a round *token* rather than a bare number:

```
home-and-away:  EFNL 2026|U12|B|14|Norwood|Vermont
finals:         EFNL 2026|U12|B|F:GF|Norwood|Vermont
```

Home-and-away rounds use the bare number, so all pre-existing ids are unchanged. Finals use `abbreviatedName`, which is stable where the name is not — WFNL returns "Preliminary Finals" where EFNL returns "Preliminary Final", and both map to `PF`.

Finals match records carry `isFinals`, `finalsAbbrev` and `finalsName`. Ordering everywhere is a two-key sort on `(isFinals, round)`.

### Series shapes

| Grades | Shape |
|--------|-------|
| 142 | `FR1 → PF → GF` |
| 11 | `FR1 → FR2 → PF → GF` |
| 3 | `GF` only (SEJ Lightning Premiership) |
| 1 | `FR1 → SF → PF → GF` |
| 1 | `EF → SF → GF` (SER U15 Boys Premier) |

### What finals do and don't affect

- **Ladder, form, team stats, season totals:** finals are excluded entirely. The ladder header freezes at each grade's own maximum home-and-away round.
- **Results and fixtures:** finals appear above home-and-away, labelled by name, with the abbreviation beside the grade tag.
- **Game of the Week:** follows the two-key ordering, so it moves into finals rather than freezing on the last home-and-away round.
- **Player statistics:** unaffected — PlayHQ already includes finals in season totals.

### Provisional teams

Undetermined finals fixtures return a `ProvisionalTeam` with a name such as `"Winner Game 1"` or `"Loser Game 3"` but **no `id`**. These are stored with `provisional: true`, render greyed and italic with no crest, are not clickable, and never count as a team having reached finals.

Detection is structural — a side with a name but no `id` — not a string match on "Winner".

---

## Finals view

A separate top-level view, reached from the **FINALS** switch in the header. It spans every age and grade, so the Age, Grade and Round filters are hidden while it is active and the Team filter becomes a Club filter.

**By age group** — one block per age, one row per grade, with the finals series as columns. Column count is driven by each grade's own rounds, so a three-round and a four-round series render side by side at their own widths.

**By club** — one block per PlayHQ club, listing every team it has in finals across
all ages, each tagged with age, grade, grade rank (`TOP` in gold, otherwise `2/4`)
and ladder position. Columns run **grand final first**, so grades with different
numbers of finals rounds still align on the round that matters; a team that won its
qualifying final and had a bye leaves its preliminary-final column blank. An
**ALL TEAMS** switch (default off) adds the club's non-finalists.

**By venue** — every finals match, results and fixtures alike, grouped by date and
venue and ordered by start time. The one mode not organised around a team, a club
or a grade: it answers "where do I need to be, and when". A `DATE › VENUE` /
`VENUE › DATE` switch flips the nesting, and a **jump** select in the sidebar
scrolls to any group. Undated matches sort **last** under "Date TBC" — an empty
string sorts before every real date, so the naive ordering puts the unknowns at the
top of a schedule.

**Winners** — grand final results only.

### Club summary table

Above the club cards, collapsed by default. One row per club, ranked on the
selected measure with standard competition ranking (1, 2, 2, 4 — so the gap says
how many clubs are ahead).

| Column | Counts |
|---|---|
| Entered | teams the club fielded, under the current filters |
| Finals | teams that reached the finals |
| Remaining | teams not eliminated and not yet in a grand final |
| GF | teams named in a grand final, played or scheduled |
| Premierships | teams that won one |

Every figure carries a gold sub-figure: the same measure restricted to teams in the
strongest grade for their age. **Every percentage is a share of teams entered** —
one denominator for the whole table, so a column reads down consistently and the
gold figure is directly comparable with the white one beside it.

**Clubs that reached no finals are included.** They cannot come from the finals
pool, so the competition/age/gender/level filter is factored out and applied to an
entered pool as well. If the filter applied to one pool and not the other, 6 of 40
and 6 of 12 would both look like ordinary numbers.

**Counting identity is `comp|team|age`, with no grade.** A side that played grading
and was then placed in a division is one team entered. Counting on a key carrying
the grade lets a club's finals total exceed the teams it fielded and print a
percentage over 100.

⚠️ **Teams seen only in a grading pool are excluded.** Grading pools are shared
between leagues and their games are recorded under the host competition, so EFNL's
own records contain games played by YJFL, SER and SEJ clubs' teams. The test is
structural — did the team play outside the pool — not the club's name, because
PlayHQ names carry a parent association in brackets and a club may legitimately
field juniors in one league and seniors in another.

Sorting offers alphabetical, most teams in finals, most remaining, most GF
appearances, most premierships, and **most teams in top grade**; plus a
**VALUES / %** basis, because a big club wins a count almost by size alone.

**Filters:** gender (male / female / both, default both) and level (junior / senior / both, default both). Both apply to every statistic including the headline totals.

**Sorting** is two independent choices. The dropdown picks the **measure** — alphabetical (default), most teams in finals, most remaining, most GF appearances, most premierships. The **TOTAL / BY GRADE** toggle then decides how two clubs are compared on it.

**TOTAL** compares plain counts. **BY GRADE** compares tier by tier, from the top grade down, so one top-grade result outranks any number of lower-grade ones — a single A-grade premiership beats three C-grade ones. Deliberately not a weighted score: any formula invites argument about the coefficients and stops the number being checkable by eye.

When BY GRADE is on, each club's line shows the breakdown for the selected measure — `premierships: top grade ×1` — including clubs with nothing in the top grade, so the shape of a club's finals presence is visible rather than only its best result.

### Status rules

- **out** — last played game was a loss, no fixture after it, and a later round exists in that grade. Losing a qualifying final leaves a preliminary final fixture, so the double chance is handled without special-casing.
- **remaining** — not out, and has not yet played a Grand Final.
- **in GF / premiers** — named in a Grand Final; won a played Grand Final.

> Elimination depends on the next round's fixture being published. If a team loses and `fetch-fixtures` has not run since, it shows as out until it does.

---

## Grade metadata

`gradeMeta["EFNL 2026|U12|A"] = { r: 1, lvl: 'junior', g: 'M' }`

- **`r`** — strength rank within that competition and age. PlayHQ returns grades strongest-first, which is the only sound source for colour-named grades (`Premier, Blue, Gold, Navy, Orange`). Grading grades are excluded so they cannot consume a slot.
- **`lvl`** and **`g`** — from the API's own `age.value` and `gender.value`.

**PlayHQ classifies U19.5 as SENIOR**, and returns `ageName: "U17"` for U17.5 competitions. Never infer level from whether the age starts with "U".

Rank is meaningful only within one competition and one age — never compare an EFNL "A" with an SER "Blue".

---

## Club index

**`organisation { id }` on `DiscoverTeam` returns the club's 8-character code
directly** — verified across 60 EFNL organisations on 2026-08-11 and confirmed for
SER. `results-engine.js` v13 reads it at fetch time, so no URL parsing is needed for
anything fetched since.

The logo-URL derivation below is kept for records written before that change. Club
identity is recovered from the Cloudinary URL, whose first eight hex characters are
the organisation code:

```
/production/afl/6d405ccb-cf15-4fbd-a5c8-bcde4ae5c3e6/.../logo.png
                ^^^^^^^^ Norwood's organisation code
```

`discoverOrganisation(code)` then returns the official name. Across all five competitions this resolves 165 clubs and 2032 teams with none unattributed.

**Never derive clubs from team names.** `"Norwood Gold/Heathmont U12"` is a merged team, and Templestowe fields two separate organisations — a senior club and a junior club — that both clean to plain `"Templestowe"`.

`teamClub` is keyed `comp|team|age` because `cleanTeam` strips the age from display names, so `"Norwood U12 Purple"` and `"Norwood U14 Purple"` both become `"Norwood Purple"`.

---

## Player statistics

**Same club, multiple teams** (e.g. played in two squad groups): goals and GP are summed. Correctly identified as one club — not flagged as a transfer.

**Transfer (different clubs)**: total GP and goals are summed across both clubs. Player is attributed to their current (most recent) club. Shown with green `XFER ↙` badge at current club, red `XFER ↗` badge at previous club's roster.

**Private profiles**: excluded — PlayHQ does not return these from the stats API.

---

## Player panel

Click any player name (top scorers, team roster, or search) to open a panel showing:
- Current team crest, name, team (clickable → team drilldown), grade, XFER badge
- Season summary: GP, goals, goals/game, best player awards
- Game-by-game breakdown fetched live from PlayHQ via Cloudflare Worker proxy
- Columns: Round, Home, Away, **Age / Grade**, Comp (logo), G, BP
- Player's team shown in gold + bold

⚠️ **The summary sums every team the player turned out for.** Stats are stored one
record per grade, and the game list is a live per-player fetch showing all of them,
so reading a single record put 16 games and 28 goals above a list of 18 and 29. The
strip now sums across the season, with the per-team split on the tooltip and a
"+ N other teams" note under the name.

Summing is **scoped to the selected season**, then to the team with the most games
within it. Picking the biggest record across everything loaded looks right and is
not: a finished season has more games than a part-finished one, so a 2026 view
would show 2025's totals and 2025's team.

**Each row shows its age group** beside the grade. Without it a U12 player's U13
games read as duplicate rounds against the wrong opponent with the wrong result.

The live game data is fetched from `publicProfileStatistics` via `solitary-snowflake-cb3e.insanoflash.workers.dev`.

---

## Player search

Sidebar includes a live search field. Type 2+ characters to match player names. Results show team crest, name, age group, grade, and goals. Click to open the player panel.

---

## Team drilldown

Click any team name (ladder, results, GOTW, scorers, player panel header) to open a modal showing:
- Season stats strip (Played/Won/Drawn/Lost/MR%/Pct). **Played, Won, Drawn and Lost
  include finals** — that is what a reader means by "played", and `0 LOST` above a
  list containing a red finals loss is a contradiction with no way to resolve it.
  **MR% and Pct stay home-and-away**, because they are ladder figures and a ladder
  is home-and-away only; including finals would make them disagree with the ladder
  on the same screen. Both splits are on the tooltips.
- Home / Away / **Finals** breakdown — the third cell appears only if the team
  played one
- Results list — all matches including cross-grade and finals (greyed out = doesn't
  count toward the ladder). **Finals sort last and print their abbreviation**
  (`FR1`, `PF`, `GF`) in gold, with the full round name on hover. Sorting on
  `m.round` alone put Finals Round 1 beside home-and-away round 1 and read as
  duplicate rows
- Season Roster (collapsible) — all players including transferred players who
  previously played for this team

---

## Admin panel

Access via ⚙ button → enter password. Three tabs:

### Game of Week
Select competition, age group, and round. Finals rounds appear by name. Matches sorted by closest margin% (gold = closest). Select to pin as GOTW.

### Fetch
Trigger GitHub Actions workflow runs from the dashboard. Requires a GitHub classic PAT with `workflow` scope. PAT stored in localStorage.

### Manage
- Show/hide young age groups (U8–U10) toggle — resets each visit
- Version display
- Password hash generator (SHA-256)

**To change admin password:** Admin → Manage → Generate hash → paste into `ADMIN_HASH` in `index.html` → commit.

---

## Multi-competition support

Five competitions in 2026: EFNL, WFNL, SEJ, SER, YJFL. Each appears as a filter chip in the sidebar. Match, roster and club IDs are scoped by `compName` to prevent cross-competition collisions.

---

## Grade naming

PlayHQ grade names vary by competition:
- **EFNL**: `"U12 - B"`, `"Premier - Eastland Senior Men"` → rawGrade: `"B"`, `"Premier"`
- **WFNL**: `"Western Bulldogs U12 Girls Division 1"` → rawGrade: `"Division 1"`
- **SEJ/SER**: `"U11 Mixed Blue"`, `"U13 Mixed Premier Division"` → rawGrade: `"Blue"`, `"Premier"`
- **YJFL**: `"U12 Mixed (1)"`, `"U12 Mixed Grading"` → rawGrade: `"1"`, `"Grading"`

Grade abbreviations: `Division N` → `DN`, `Premier` → `Prem`

---

## Grade movement rules

A team's current grade = the grade they last appeared in (from the roster). Finals are excluded from this calculation.

Two different questions were being asked through one function until 2026-08-13, and
they are now separate:

- **`matchListGrade(m)`** — where a result is LISTED. Always `m.gradeId`, PlayHQ's
  own answer to which grade the game was played in.
- **`matchLadderGrade(m)`** — what it COUNTS TOWARDS, or null. A grading grade
  returns itself; otherwise the teams' agreed grade; otherwise null.

- A match counts for the **ladder** only if both teams share the same current grade
- Mismatched matches (e.g. grading rounds where teams ended up in different divisions) appear greyed out
- Individual player goals always count regardless of grade movement
- **A grading grade is its own competition** — its own tab and ladder, counting
  every game played in its rounds whatever division the teams were later placed in
- **A tab comes from listing, not from counting**: a result that counts nowhere
  must still have somewhere to appear

---

## Age group sort order

Senior Men → Senior Women → Reserve Men → Veterans → U19.5 → U18 Girls → U17.5 → U16 → U16 Girls → U15 → U14 → U14 Girls → U13 → U12 → U12 Girls → U11 → U10 → U9 → U8

Young age groups (U8/U9/U10) hidden by default. Toggle in Admin → Manage to show them. This toggle also keeps the SEJ Lightning Premiership grades out of the finals view, since they are all U10.

---

## PWA — installing as an app

**Android (Chrome):** Three-dot menu → Add to Home Screen.
**iOS (Safari):** Share button → Add to Home Screen. Must use Safari.

Works offline using last-loaded data. Service worker skips POST requests (Cache API limitation).

---

## Cloudflare Workers

| Worker | URL | Purpose |
|--------|-----|---------|
| PlayHQ proxy | `solitary-snowflake-cb3e.insanoflash.workers.dev` | Proxies GraphQL POST requests for player panel (CORS bypass) |
| Cron scheduler | `footy-cron.insanoflash.workers.dev` | Dispatches GitHub Actions workflow at correct AEST times |

---

## Repo maintenance

**Repo Audit** (read-only) reports every file with size and last-commit date, duplicate
filenames, identical content under different names, which workflow invokes which script,
orphaned scripts, and workflow references to files that do not exist.

**Repo Tidy** removes dead files. Dry run unless `apply` is ticked. It scans every text file
for references first and distinguishes code references, which block a removal, from
documentation references, which only warn. Groups: `oneoffs`, `placeholders`, `legacy`,
`historic`, `migration`, `assets`.

A tidy on 2026-08-10 removed 135 files — the fixture generator's leftover club images
(`assets/clubs`, ~10.7 MB), the superseded `extract-finals-data` script and workflow, two git
directory placeholders, and `SETUP.txt`. `2024.html` and `fetch-u10-2024.js` were removed in
the same pass; both are recoverable from git history and should be restored when multi-season
support is built, since the dashboard is single-season today and `2024.html` is likely the only
standalone copy of that season.

**Repo Tidy's reference classifier is known-wrong** — it reports a mention in a
`.yml` or `.js` as "documentation only", matching on filename rather than on
whether the mention is live code. It was right twice by luck on 2026-08-13; a real
`require()` would have read identically and the REFUSED guard would not have
fired.

---

## Known issues

- **`logoKey()` colour stripping does not work.** `new RegExp('\s+' + c + '\s*$')` uses a plain string, so `\s` becomes a literal `s`. Unnoticed because `teamLogos` is keyed by full team name and usually hits exactly.
- **Team identity is derived from a cleaned display name**, not the PlayHQ team `id` — which both fetchers request and discard. This is the root cause of the club-name heuristics in `fetch-stats.js`.
- **A team rename stores the same game twice.** A match id embeds both team names,
  so when PlayHQ renames a team mid-season the game re-fetches under a new id and
  the old record stays, inflating both teams' ladder P column. Engine v16 stopped
  new ones by stamping every record with PlayHQ's `gameId`; the backlog was cleared
  on 2026-08-19 — 24 records, by `cleanup-rename-duplicates.js` and
  `repair-duplicate-names.js`. **These rounds are unreachable by the normal fetch
  path**: `knownRounds` is built in memory from stored records and `fetchGrade`
  skips anything at or below it, so neither fetch-results nor backfill revisits
  them. Two causes, and only one was PlayHQ's — see the `cleanTeam` note below.
- **49 unmigrated bye sentinels** (YJFL only) — ambiguous grade collisions that
  self-heal when the next results run touches the grade.
- **A short-form competition not named "grading"** — SEJ's Lightning Premiership,
  WFNL's Lightning Cups, YJFL's pools — takes the fallback, so its games are listed
  but count towards no ladder. Accepted deliberately; detection is by name because
  nothing structural separates the two cases.

**Fixed and worth knowing about, because each hid itself:**

- **`lastRound` was never read at all.** The writer built `age|rawGrade` and the
  reader `compName|age|gradeId`, so the round label on the ladder grade tabs
  rendered as an empty string from Beta 0.133 until 0.165. The tag was then judged
  not worth its space and the whole key was removed (Beta 0.176, engine v19,
  store v7).
- **A result merged into a scheduled fixture kept the `scheduled` flag.** A result
  record has no `scheduled` key, so `{ ...prev, ...m }` left `true` in place with
  correct scores inside it — the record never reached the results list and the
  finals view drew it with blank scores. It hid twice: the scores merged in on the
  first run, so every later run reported `0 new, 0 updated` and skipped the commit,
  producing a log identical to a run with nothing to do. Engine v18.
- **Upcoming Fixtures joined the grade filter on `rawGrade`** against a Set of
  PlayHQ grade IDs, so it matched nothing and the empty-list guard hid the whole
  section. With 99.91% of records migrated that was every fixture.
- **The "4 of 8" grade tag counted every grade twice.** `buildGradeMeta` writes each
  ranked grade under both its id and its rawGrade, and the count matched on prefix.
- **`cleanTeam` stored one PlayHQ name as two different team names.** It has two
  paths — with a grade age it strips only that exact token, without one it stripped
  ANY U-number — so `Mt Eliza JFC U17 Boys Red` in a `U17.5` grade was stored both
  as itself and as `Mt Eliza JFC Boys Red`. Four of the 24 duplicates came from
  this, and it looked exactly like a PlayHQ rename. Engine v20 makes the
  no-grade-age path strip nothing and warn loudly, so the two can no longer
  disagree. The `.5` behaviour is unchanged on purpose: stripping the base number
  would rewrite the id of every stored U17.5 and U18.5 record.

---

## Version history

| Version | Key changes |
|---------|-------------|
| 0.191 | Player panel header sums every team a person played for, scoped to the selected season |
| 0.190 | Age group beside the grade on every player-panel row |
| 0.189 | Team drilldown season totals include finals; MR% and Pct stay home-and-away; finals breakdown cell |
| 0.188 | Team drilldown: finals sort last and print FR1/PF/GF instead of `Rd 1` |
| 0.187 | "Most teams in top grade" sort; percentage on the gold Entered figure |
| 0.186 | Gold top-grade figure on every club-summary measure, replacing the standalone column |
| 0.185 | Sticky summary headings track the page header's bottom edge as it releases |
| 0.183–0.184 | `.main` to `overflow-x:clip` so sticky works; `body` must stay `hidden` — it is the page's scrollport |
| 0.182 | Rank column, standard competition ranking, ties from the chosen measure |
| 0.181 | Grade tier count deduplicated; grading-pool visitors excluded from the club summary |
| 0.180 | VALUES / % sort basis |
| 0.179 | GF-first columns, ladder position per row, ALL TEAMS switch |
| 0.177–0.178 | Club summary table: clubs with no finals included, percentages of teams entered, collapsible |
| 0.176 | Finals BY VENUE; `lastRound` removed |
| 0.175 | Fixtures grade filter joined on the grade id, not `rawGrade` |
| 0.166–0.174 | Grade attribution split into list/ladder; grading grades get their own tab and ladder |
| 0.165 | `lastRound` and `gotwFlags` re-keyed to carry the competition |
| 0.133–0.164 | Per-season storage, grade identity migration, season selector, multi-season support |
| 0.124 | Grade level and gender read from the API (`age.value` / `gender.value`); U19.5 correctly classified as senior |
| 0.123 | Gender and junior/senior filters; grade-strength sort with tier breakdown; grade rank badges |
| 0.122 | Elimination rule corrected — a provisional later round no longer suppresses every elimination |
| 0.121 | Multi-sort for the by-club finals view |
| 0.120 | Per-club finals aggregates (remaining, in GF, premiers); clubs sorted by teams sent |
| 0.119 | Finals view — separate top-level view with by-age and by-club modes |
| 0.118 | Results grouped and labelled by finals round; named finals entries in the round filter |
| 0.117 | Upcoming Fixtures shows finals by name; provisional teams rendered greyed |
| 0.116 | Finals excluded from ladder, GOTW, team stats and roster |
| 0.107–0.115 | Not documented — README was not maintained across these releases |
| 0.106 | XFER badges directional: green ↙ current club, red ↗ previous club |
| 0.105 | Transferred players shown on previous team's roster via appearances |
| 0.104 | getTopScorers includes players with unresolved grade (U8 etc.) |
| 0.103 | Admin toggle for young age groups (U8–U10); excludeGrades removed from fetch |
| 0.102 | Grade colour class names preserve lowercase (Blue/Red now correct) |
| 0.101 | Grade fallback in GOTW/results/scorers for empty rawGrade |
| 0.100 | Colour-named grades use literal colours (Blue=blue, Red=red etc.) |
| 0.99 | getTopScorers includes players with empty teamGrade |
| 0.98 | gtag CSS classes for numeric and colour grade names |
| 0.97 | toProperCase handles partially-cased names (e.g. "Benjamin O'DONNELL") |
| 0.96 | Results pane and team drilldown show all matches including cross-grade |
| 0.95 | fetch-results: parseGradeName handles YJFL (N) and SEJ colour suffixes |
| 0.94 | GRADE_ORDER and GRADE_COL include numeric and colour grades |
| 0.93 | Numeric grade ordering (1 highest) |
| 0.92 | Comp logo uses p.compName directly; Cloudflare cron scheduling |
