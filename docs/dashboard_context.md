# Junior Footy Dashboard — Context Document

**Repo:** `markjovic/junior-footy-dashboard`  
**Dashboard:** Beta 0.164, served from GitHub Pages  
**Last updated:** 2026-08-13  

---

## 1. What this is

A single-page HTML dashboard for AFL junior football results across five
competitions: EFNL, WFNL, SEJ, SER, YJFL. Data is fetched from PlayHQ's
GraphQL API, stored as committed JSON files under `data/`, and served via
GitHub Pages. No server, no database — everything is static files.

Mark is the sole developer. He has **no local git and no local execution
environment**. Every script runs through GitHub Actions `workflow_dispatch`
(or on push, for the verification workflow). Every file is committed through
the GitHub web UI.

---

## 2. The five competitions

| Code | Name | Org UUID |
|---|---|---|
| EFNL | Eastern Football Netball League | `383836bb` |
| WFNL | Western Football Netball League | `4c8b472e` |
| SEJ | South East Juniors | `1cf85e52` |
| SER | South East Region (Outer) | `0f20da4f` |
| YJFL | Yarra Junior Football League | `4f9a099e` |

These are the five in `config.json`. Twelve additional organisations are in
`core.json`'s `organisationCodes[]` but have not been migrated to the full
`organisations[]` shape, because each needs a short name chosen first — the
short name becomes half of every match id.

---

## 3. Storage layout (as of 2026-08-12)

### 3.1 The files

```
data/
  core.json                       manifest + cross-organisation keys
  grades.json                     1,006 grades across 18 seasons
  clubs.json                      179 club id → name mappings (cache)
  seasons/
    <seasonId>-core.json          matches, roster, gradeMeta, meta
    <seasonId>-players.json       player records
  orgs/                           ROLLBACK PATH — delete after a clean weekend
    <org>-current.json
    <org>-archive.json
```

36 season files (18 seasons × 2). The `data/orgs` directory is the previous
layout, kept as a rollback path. It was used on 2026-08-12 to restore 179,624
player records after a bug wrote empty files. Delete it once scheduled runs
have been stable for a full weekend.

### 3.2 Why two files per season

Player records are 78% of all stored bytes (82.57 MB of 105.25 MB total). The
dashboard fetches only the core files on page load (22.68 MB → ~5.4 MB for
five live seasons). Players arrive after first paint via `requestIdleCallback`.

### 3.3 `core.json`

Holds the manifest (all 18 seasons with status, dates, compName, phases) and
the cross-organisation keys: `clubs`, `teamClub`, `teamOrg`, `compLogos`,
`teamLogos`, `gotwFlags`, `lastRound`. These cannot be per-season because they
span competitions.

### 3.4 Grade identity

Every match record carries a `gradeId` field (PlayHQ's own UUID for the grade)
and has the grade id as the third segment of its `id`. 99.91% of records are
migrated. The 49 unmigrated are YJFL bye sentinels that collide on their
round-keyed identifiers; they self-heal when the next results run touches them.

### 3.5 Measurements (2026-08-13)

| | |
|---|---|
| Total match records | 53,606 |
| Total player-season records | 179,624 |
| Distinct people | 70,672 |
| Average seasons per person | 2.54 |
| Season files total | 105.25 MB |
| Core files only | 22.68 MB |
| Player files | 82.57 MB (78%) |
| Default page load | ~5.4 MB |
| Club mappings | 7,670 team(s) → 179 club(s) |

---

## 4. Scripts

### 4.1 Library (`scripts/lib/`)

**`lib/store.js`** — v5  
The per-season storage layer. All five writers go through this.  
- `store.load(scope, { players: false })` — loads data in the shape
  `data.json` had. `scope` is a list of compNames or null for everything.
  `players: false` skips player files (78% of bytes, not needed for results).  
- `store.save(data, scope, opts)` — distributes data back. Only rewrites files
  whose contents changed. Refuses to replace a populated player file with an
  empty one unless `allowEmptyPlayers: true` is passed — this guard saved
  179,624 records on 2026-08-12 when a spread operator dropped the
  `__hadPlayers` marker.  
- `store.saveCore(data)` — writes only `core.json`. For writers that touch no
  season files (e.g. `build-club-index.js`).  
- `store.liveComps(statuses)` — returns compNames whose status matches the
  given set.

**`lib/playhq.js`**  
Session management and transport for all PlayHQ API calls. Manages the three
cookies PlayHQ requires (`phq_tier`, `phq_session`, `phq_sub`) in the
documented order. All writers use this — never write a local `getSession()`.

**`lib/results-engine.js`** — v13  
Core match processing. Called by `fetch-results.js` and `backfill.js`.  
Key functions: `processGrade()`, `buildGradeMeta()`, `parseGradeName()`.  
The grade identity migration pass 1/2/3 logic lives here.  
v13 (2026-08-13): added `organisation { id }` to the fixture query so club
identity is read directly from PlayHQ rather than parsed from a Cloudinary
URL. The URL fallback is kept for records fetched before this change.

### 4.2 Writers

**`fetch-results.js`**  
Fetches live season results for the five competitions in `config.json`. Calls
`results-engine.js`. Passes `players: false` to `store.load` — player records
are written by `fetch-stats.js`, not here.

**`fetch-stats.js`**  
Fetches player statistics. Writes player files. Skips retired seasons by
default (`STATS_INCLUDE_RETIRED=true` to include them for backfill).

**`fetch-fixtures.js`** — v5  
Fetches scheduled future fixtures. Passes `players: false` to `store.load`.

**`backfill.js`**  
Fetches results and ladders for retired seasons. Phase A (results) and Phase B
(player stats) are complete across all five organisations. Takes a `--comp`
filter to limit scope.

**`build-club-index.js`** — v4  
Builds `data/clubs.json` and the `teamClub`/`clubs` keys in `core.json`.
Loads all eighteen seasons (`players: false`). Three evidence sources in order:

1. `teamOrg` — written by `fetch-results.js` at fetch time from the logo URL
   or `organisation.id`. Authoritative; exact key (comp|team|age known).
2. `hLogo`/`aLogo` on match records — fallback for records written before
   `teamOrg` existed, and for fixtures which still carry logo fields.
3. `teamLogos` — keyed by bare team name. Catches teams whose rounds were all
   stored before `teamOrg` was introduced and whose per-match logos were
   subsequently stripped. This resolved 566 SER teams on 2026-08-13 that had
   appeared as Unattributed since the club index was first built.

Requires a PlayHQ session to resolve new organisation ids. Uses
`data/clubs.json` as a cache to avoid re-fetching known ones.

**⚠️ Why SER teams were Unattributed (resolved 2026-08-13):**  
SER match records do have logos, but those rounds were fetched before `teamOrg`
was introduced. Every subsequent run skipped them as already stored. Per-match
logo fields were stripped at the same time. The evidence was sitting in
`teamLogos` all along — the v4 `teamLogos` fallback resolved all 566.

**`discover-seasons.js`**  
Discovers seasons per organisation from PlayHQ and writes the manifest in
`core.json`. Run this before any backfill when a new season appears.

**`discover-orgs.js`**  
Discovers organisation IDs from PlayHQ search. Writes `data/org-discovery.json`.

**`migrate-grade-ids.js`**  
One-off (but idempotent): rewrites stored match ids to carry PlayHQ grade ids,
resolving grade collisions using the season team registry. Pass 1 resolves
offline; pass 2 needs the registry; pass 3 resolves remaining bye sentinels by
elimination. 99.91% complete; 49 YJFL byes remain.

**`rebuild-grade-meta.js`**  
Offline (no PlayHQ calls): regenerates `gradeMeta` for every stored season from
`data/grades.json`. Needed because `fetch-results.js` only regenerates
`gradeMeta` for the five live seasons. Archived seasons had pre-migration
entries (keyed by `rawGrade`, no label, no grade id) until this was run.

**`split-by-season.js`**  
One-off migration (2026-08-12): moved data from `data/orgs/` to
`data/seasons/`. Proved correctness by reading back and comparing all counts.
`data/orgs` was left intact as the rollback path.

### 4.3 Diagnostics and reporting

**`audit-data.js`** — v10  
Read-only. Reads `data/seasons` and reports: file sizes and the core/players
split, per-season record counts, round gap analysis (live vs retired),
`grades.json` coverage, grade identity migration state, and a sized estimate
of what a cross-season player search index would cost. Exits non-zero if
`AUDIT_STRICT=true` and any warnings are present. Run this after any major
data change.

**`report-field-usage.js`**  
Read-only. Given a field name, finds every script and template that reads it.
Used before removing or renaming any stored field — the `hLogo`/`aLogo`
removal that broke `build-club-index.js` was the incident that prompted it.  
**⚠️ The SOURCES list is missing `results-engine.js`, `migrate-grade-ids.js`,
`rebuild-grade-meta.js`, `split-by-season.js`, and `cleanup-obsolete.js`.
These must be added before relying on this for the next field removal.**

**`report-grade-collisions.js`**  
Read-only. Reports grades that collapse to the same `age|rawGrade` key —
relevant to the 49 remaining unmigrated records.

**`repo-audit.js`**  
Read-only. Inventories the repo: duplicate basenames, identical content,
orphan scripts, broken workflow references, divergent duplicates.

**`repo-tidy.js`**  
Removes files by group after a reference scan. Groups: `oneoffs`,
`placeholders`, `legacy`, `storage2026`, `probes`, `historic`, `migration`,
`assets`. A file referenced anywhere in code is REFUSED, not removed.
Dry-run unless `--apply`. **Run `storage2026,probes,historic` — confirmed
safe in the 2026-08-12 dry run.**  
`probe-ser-logos.js` should be added to the `probes` group once the SER
investigation is closed.

**`probe-team-join.js`**  
Recurring diagnostic: measures how well stored team names join to the season
team registry. Not a one-off — kept for ongoing use.

**`probe-finals-rounds.js`**  
Reusable round-structure tool for finals analysis.

**`probe-ser-logos.js`**  
One-off probe (2026-08-13): confirmed that SER logo URLs and `organisation.id`
are returned correctly by the API. The Unattributed issue was a timing problem,
not a data gap. Add to `probes` group in `repo-tidy.js` and remove.

### 4.4 Verification

All verification scripts exit 0 (all passed) or 1 (any failed). They execute
their target scripts as child processes against fixtures, so the code under
test is exactly the committed code.

| Script | Tests | Covers |
|---|---|---|
| `verify-store.yml` *(umbrella)* | — | runs all 7 suites; fires on every push |
| `verify-per-season.js` | 53 | `store.js` and `split-by-season.js` |
| `verify-backfill.js` | 75 | `backfill.js` |
| `verify-discover-seasons.js` | 20 | `discover-seasons.js` |
| `verify-migrate-grade-ids.js` | 54 | `migrate-grade-ids.js` |
| `verify-dashboard-grades.js` | 77 | `index.html` silent failures |
| `verify-rebuild-grade-meta.js` | 22 | `rebuild-grade-meta.js` |
| `verify-audit.js` | 43 | `audit-data.js` |

`verify-dashboard-grades.js` covers only things that **fail silently**: a
promoted team appearing on two ladders, a scorer filtered out because their
team isn't in the roster, the page hanging because `render()` threw, year
and competition lists that can't be built for a season with nothing loaded.
Layout is not tested here — it's visible on screen in a second, and a regex
over the source cannot judge whether it reads well.

---

## 5. Workflows

All workflows use `workflow_dispatch` unless noted.

| Workflow | Script | Notes |
|---|---|---|
| `verify-store.yml` | all 7 verify-*.js | **Auto-runs on push to scripts/**, index.html, org-discovery.html |
| `fetch-results.yml` | fetch-results.js | Three jobs: VIP-only, all, scheduled (Sa/Su via Cloudflare Worker) |
| `fetch-stats.yml` | fetch-stats.js | Has `include_retired` input for backfill |
| `fetch-fixtures.yml` | fetch-fixtures.js | |
| `backfill.yml` | backfill.js | Has `comp` filter and `dry_run` inputs |
| `discover-seasons.yml` | discover-seasons.js | Run before any backfill when a new season appears |
| `discover-orgs.yml` | discover-orgs.js | Writes data/org-discovery.json |
| `build-club-index.yml` | build-club-index.js | Has `comp` filter and `refresh` inputs |
| `migrate-grade-ids.yml` | migrate-grade-ids.js | Has `org` and `dry_run` inputs |
| `rebuild-grade-meta.yml` | rebuild-grade-meta.js | Has `org` and `dry_run` inputs |
| `split-by-season.yml` | split-by-season.js | Has `dry_run` input; one-off migration |
| `repo-tidy.yml` | repo-tidy.js | Has `groups` and `apply` inputs |
| `audit-data.yml` | audit-data.js | Has `strict` and `org` inputs |
| `report-grade-collisions.yml` | report-grade-collisions.js | Read-only |
| `probe-ser-logos.yml` | probe-ser-logos.js | One-off; add to probes group and remove |

**Workflows to be deleted by repo-tidy (`storage2026,probes,historic`):**
- `cleanup-obsolete.yml`, `split-data.yml`, `report-data-size.yml`
- `probe-api-session.yml`, `probe-grade-teams.yml`, `probe-team-grades.yml`,
  `probe-stored-grade.yml`, `probe-search.yml`, `probe-ser-logos.yml`

---

## 6. The dashboard (`index.html`) — Beta 0.164

### 6.1 Data loading

On page load, `loadStoredData()` fetches `data/core.json` and then the five
live seasons' `-core.json` files (matches, roster, gradeMeta). Player records
are fetched separately, after first paint, via `requestIdleCallback`.

When a past year is selected, `loadSeasons()` fetches that year's core files
and merges them into the in-memory state. The fetched season stays in memory
for the session, so switching back is instant. Players for the new season are
loaded via `loadPlayers()` in the background.

### 6.2 Grade grouping

Ladders group by `gradeId` (PlayHQ's own UUID). Grade tabs are labelled via
`gLabel(gradeId)`, which reads from `S.gradeLabelById` (built from
`S.gradeMeta`). When two grades collapse to the same `rawGrade` key, the
disambiguation appends a suffix.

A promoted team counts on one ladder only — the grade its roster entry
currently says it is in. `precomputeMatches()` runs on every batch of new
records (load, backfill load, year-switch load) and must run after the roster
is merged in.

### 6.3 Season selector

Year is the outer scope. Choosing a year narrows the competition list to the
competitions that ran in it. Both lists come from the manifest (`S.manifest`),
not from loaded records — a past year has nothing in `S.matches` until its
files are fetched, so deriving the list from records would show an empty
competition list.

### 6.4 Player search

Scoped to the selected season. Searches the currently-selected year only.
Token matching in any order: `toby jo`, `jovic to`, and `to jov` all find
Toby Jovic. When no players are loaded, a "Loading players…" message appears
and the fetch is triggered.

### 6.5 Finals view — By Club

Teams within a club card sort: premiers first → GF appearances → still in
finals → eliminated; grade strength as tiebreaker within each band; age last.

Columns are per-grade, positional, derived from a **global** round index built
across all clubs before the per-card loop. This matters: a team that won FR1
and went straight to the GF may belong to a different club from the team that
lost FR1 and played PF — they're in the same grade and must share the same
column index so they align.

Each grade defines its own column positions from the rounds played across all
teams in that grade. The card's total column count is the maximum across all
grades in all clubs. Grades that reached the GF are right-aligned so GF is
always in the last column; grades eliminated before the GF left-align from
column 1.

Round labels use `finalsAbbrev` (QF, EF, GF etc) on the cell, with the full
`finalsName` ("Qualifying Final") on hover. `finalsName` is PlayHQ's round
name ("Finals Round 1"), not the game type — the abbreviation is what matters.

---

## 7. Key principles (working_practice.md)

- **Authority comes from execution, not reading.** Never infer behaviour from a
  filename, a summary, or a partial grep. Run the script; read the output.
- **Read a whole file before touching it.** Never trust a partial view.
- **Before removing or renaming any stored field,** run
  `scripts/report-field-usage.js` and read every file it names.
- **Verify by execution.** Stub the network; run the real script.
- **Never new Date(string) for parsing.** Split YYYY-MM-DD; use Date.UTC.
- **Anything derived from a filtered grade list must MERGE per competition,
  never replace.** This defect was fixed four times in four writers.
- **Harvest before you strip.** Read a value into its new home before deleting
  the old copy, in the same pass.
- **Design questions are written down and approved before anything is built.**
- **Probe before building.** Key PlayHQ API behaviours are established by
  targeted probe scripts before any feature is built.
- **Small-sample inference is unreliable.**
- **Every script that produces output read from a log must print a version
  line.** Without it, a stale cached copy and a real failure look identical.
- **Scoped writes must be structurally isolated.**

---

## 8. Key PlayHQ API findings

(Full reference: `docs/playhq_api_reference.md`)

- Finals rounds restart numbering at 1 universally.
- `abbreviatedName` is stable where `name` is not. `finalsAbbrev` is the game
  type (QF, EF, GF); `finalsName` is the round name (Finals Round 1) — these
  are different things.
- `discoverTeams(filter:{seasonID})` works without an organisation.
- `discoverCompetitions` requires `organisationID` (UUID form).
- PlayHQ issues three session cookies (`phq_tier`, `phq_session`, `phq_sub`)
  in a specific order. `lib/playhq.js` handles this.
- `organisation { id }` on `DiscoverTeam` returns the club's 8-character code
  directly — no URL parsing needed. Verified across 60 EFNL organisations
  (2026-08-11) and confirmed working for SER (2026-08-13).
- `discoverFixtureByRound` returns 0 games for completed rounds that were
  fetched in a prior run — the data is in storage, not re-served by the API.

---

## 9. Known defects and limitations

### 9.1 `lastRound` and `gotwFlags` keying collision

Both are keyed `age|rawGrade` with no competition component. When two
competitions share an age/grade combination, they collide. The real fix
requires a data migration. Recorded; not yet actioned.

### 9.2 Concurrent competitions (SEJ 2026 U10)

Two leagues run in one age group. A team can only be on one ladder, so the
Lightning Premiership ladders don't appear. Needs a design decision before
any code is written.

### 9.3 49 unmigrated bye sentinels

YJFL only. Ambiguous collisions that could not be resolved by elimination in
pass 3. They self-heal on the next results run when a real round is fetched
for the grade.

### 9.4 Empty `rawGrade` in YJFL archived seasons

Some YJFL grades parsed to an empty `rawGrade` key. Match ids are correct
once migrated, but `gradeMeta` still has a legacy entry at the empty key.
Cosmetic only after grade identity migration.

---

## 10. Data files that still exist from previous layouts

- **`data/orgs/`** — 105.25 MB. The rollback path from the 2026-08-12
  per-season split. Delete after a clean weekend of scheduled runs.
- **`data/data.json`** — if still present. The rollback path from the
  2026-08-11 per-organisation split. Nothing reads or writes it any more.

---

## 11. Document index

| Document | Purpose |
|---|---|
| `docs/dashboard_context.md` | This file |
| `docs/working_practice.md` | Delivery standards, principles |
| `docs/playhq_api_reference.md` | Established API behaviour |
| `docs/storage_ingestion_design.md` | Storage design decisions (pre-2026-08-12) |
| `docs/per_season_storage_design.md` | Per-season layout design (2026-08-12) |
| `docs/season_selection_design.md` | Year selector design |
| `docs/grade_identity_migration.md` | Grade id migration design and build order |
| `docs/team_registry_design.md` | Team registry design (open questions remain) |
| `docs/finals_support.md` | Finals view design |
| `docs/OUTSTANDING_TASKS.md` | Actions, questions, and decisions needed |
