# Junior Footy Dashboard — Context Document

**Repo:** `markjovic/junior-footy-dashboard`  
**Dashboard:** Beta 0.216, served from GitHub Pages  
**Last updated:** 2026-08-16  

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
  player-index.json               cross-season player search index (6.30 MB)
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
`teamLogos`, `gotwFlags`. These cannot be per-season because they span
competitions.

`lastRound` is **GONE** as of 2026-08-19. Reader removed in Beta 0.176, writer in
engine v19, `CORE_KEYS` entry in store v7. Removing it from `CORE_KEYS` does not by
itself clear the stored map — `save` composes core as `{ ...core }` and only
overwrites keys present in `data` — so `store.js` carries a `RETIRED_KEYS` list
that deletes it explicitly on both write paths. The first save by any writer
removes it, and audit section 9 then reports 0 keys.

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

### 3.6 Season state — `state` and `stateAt` on each manifest entry (2026-09-07)

```json
{ "seasonId": "2dcbf383", "compName": "EFNL 2026", "retired": false,
  "status": "ACTIVE",                 // PlayHQ's own word, unmodified (was already here)
  "state": "active",                  // upcoming | active | complete — derived
  "stateAt": "2026-09-07T05:02:11Z" } // when state last changed
```

Written only by `discover-seasons.js` v4, daily. **The design's `phqStatus` was
NOT added**: the manifest already carried PlayHQ's status as `status`, so a second
copy would have been byte-identical. Decided 2026-09-07.

**The rule, in order.** `COMPLETED` → `complete`. `UPCOMING` → `upcoming`.
`ACTIVE` → `active`, unless the **backstop** says otherwise: for a tracked season
(one with a `compName`) whose season file holds no `scheduled: true` record AND
whose latest dated result is 14 or more days old, `complete`. Anything else —
null, a draft state — keeps the prior `state`, or defaults to `active` with a
WARNING when there is none. Recomputed every run, not sticky; `stateAt` moves only
when `state` does.

⚠️ **`retired` and `state` are different.** Retired means no longer walked;
complete means the season has ended. A 2022 season is both; a 2026 season the day
after the grand final is complete but still walked for late corrections.

**Readers:** `index.html` (SEASON COMPLETE / UPCOMING tag beside the Season
label, Beta 0.217); the season gate in `fetch-results.yml`. `store.liveComps`
still reads `status`, not `state`.

**Day one, 2026-09-07:** 65 entries, 52 complete, 13 active, 0 upcoming, 0
transitions. SEJ 2026 and SER 2026 were already complete on PlayHQ's word
(`endDate 2026-09-01`); EFNL and WFNL held active by scheduled finals; YJFL held
active only by the two-week clause, with no fixtures left and its last result the
day before — the first backstop transition is expected 2026-09-20 unless PlayHQ
flips it first.

### 3.7 Next-season registrations — `data/registrations.json.gz` (2026-09-07)

Written whole by `scripts/walk-registrations.js` and nothing else; not in
`core.json` (a walk must never touch the manifest) and not in a season file
(never in a results run's checkout). **Gzip only**: the plain file was 8.7 MB for
40,002 people, the .gz about 1.4 MB, and it is committed daily. It is therefore
not readable in the GitHub web UI — the run log prints what you would look for.
Design: `registrations_design.md`.

```json
{ "meta": { "version": 2, "walkedAt": "…", "cohortSeasons": ["2dcbf383", "…"],
            "people": 40002, "clubTeams": { "<seasonId>": { "<clubOrg>": 12 } },
            "lastRun": { "calls": 5715, "answered": 5714, "notFound": 0, "errored": 1 } },
  "players": {
    "<uuid>": { "name": "…", "at": "ISO", "nextCheck": "ISO", "triggered": false,
                "from": { "seasonId": "2170ac5a", "compName": "WFNL 2026",
                          "club": "9009ad1c", "clubName": "Hoppers Crossing FC" },
                "tracked": [ { "seasonId": "…", "compName": "WFNL 2027", "status": "UPCOMING",
                               "club": "…", "clubName": "…", "team": null, "name": "…" } ],
                "other":   [ { "league": "Gippsland League", "season": "2027", "status": "UPCOMING",
                               "startDate": "2027-04-01", "endDate": "2027-09-01" } ] } } }
```

- **Cohort**: every distinct person in the most recent season WITH A PLAYERS FILE
  of each tracked organisation — the five 2026 files, 40,002 people on
  2026-09-07. 2025-only players are not walked.
- **`from.club`** is harvested from the player's own cohort-season record in the
  API answer, not from `teamClub`/`teamOrg`: those are keyed on a differently
  normalised team name and resolve only ~60% of a cohort (WFNL 2026: 4,688 of
  7,675). About 3.5% of answered players return no record for the season they
  played in (201 of 5,714; inferred permit players and a few empty profiles) and
  keep `club: null`.
- **A registration is kept only if its season starts AFTER the cohort season
  ENDS** (`startDate > endDate`, both from the manifest). The first rule —
  "starts after ours starts" — stored 1,187 CONCURRENT 2026 seasons (school
  comps, second leagues) as "next season" on the first run; file version 2
  marks the fix and migrated them.
- `tracked` = seasons in the manifest, in full; `team` is set only when the
  DiscoverTeam name differs from the club name (the assignment signal).
  `other` = everything else as league, season, status and dates; the dates exist
  because "AFL Nines at Byron" (two days in October) was a player's only
  post-season registration on 2026-09-07.
- `nextCheck`: +7 days when nothing tracked was found, +28 when something was
  (the transfer check) or the profile was NOT_FOUND.

### 3.8 `config.json` — organisations, no season ids (2026-09-08)

```json
{ "organisations": [
    { "code": "383836bb", "name": "EFNL", "tracked": true,  "vip": true,  "excludeGrades": [] },
    { "code": "1cd834de", "name": "Victorian Amateur Football Association (VAFA)", "tracked": false } ] }
```

Five tracked, twelve watched. Nothing in this file changes at season rollover:
**what gets fetched comes from the manifest**, via `store.fetchTargets()` —
tracked organisations' seasons, not retired, whose `state` is `active` or
`upcoming`, or `complete` for under 7 days (the same rule as the season gate in
`fetch-results.yml`). `opts.includeComplete` (workflow input
`ignore_season_gate`) adds every non-retired complete season. Readers:
`fetch-results.js` (passes the list to the engine), `fetch-stats.js` and
`fetch-fixtures.js` (filter `grades.json` to it — a non-VIP fixtures run no
longer walks every retired grade since 2022), `backfill.js` (`excludeGrades` by
organisation), `discover-seasons.js`. All read through `store.readConfig()`,
which also accepts the OLD shape (`competitions[]` + `organisationCodes[]`) and
returns it verbatim, so the flip was the last commit and changed nothing before it.
Design and the trap it avoids: `season_rollover_design.md`. Flipped 2026-09-08,
65 manifest entries round-tripped with 0 differences.

## 4. Scripts

### 4.1 Library (`scripts/lib/`)

**`lib/store.js`** — v7  
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

**`lib/results-engine.js`** — v20  
Core match processing. Called by `fetch-results.js` and `backfill.js`.  
Key functions: `processGrade()`, `buildGradeMeta()`, `parseGradeName()`.  
The grade identity migration pass 1/2/3 logic lives here.  
v13 (2026-08-13): added `organisation { id }` to the fixture query so club
identity is read directly from PlayHQ rather than parsed from a Cloudinary
URL. The URL fallback is kept for records fetched before this change.
v14 (2026-08-13): `lastRound` re-keyed to `compName|age|gradeId`, merged per
competition, and legacy two-segment keys dropped by segment count. The grade
token is resolved through the roster — `entry.gradeId || entry.grade ||
rawGrade`, the same expression the page uses — because for a promoted team that
differs from `m.gradeId`. Exported as `lastRoundKey()` so the promoted case can
be unit-tested. The `writeLastRound` option is GONE: it existed only because the
key had no competition, and both callers stopped passing it.
v15 (2026-08-13): a round with games but no final result no longer stops the round
walk when its latest GAME date is in the past. Such a round is a placeholder or an
abandonment, not the leading edge of the season. SEJ 2026 round 10 of `cb7b3db3`
is one PENDING dummy fixture, and it had stopped the walk permanently — rounds 11
to 14 held eight real games that were never fetched.
`unplayed_round_blocker_design.md`.
v16 (2026-08-13): every record carries `gameId`, PlayHQ's own fixture id, and a
re-fetch whose `gameId` matches a stored record SUPERSEDES it rather than adding
a second one. The match id embeds both team names and PlayHQ renames teams
mid-season, so a rename used to create a phantom duplicate — sixteen in SEJ
`a5a8276d`, six in `cb7b3db3`, each inflating a ladder's P column by one. Records
written before v16 have no `gameId`, so existing duplicates persist and need a
one-off cleanup — see `grade_attribution_split_design.md` §5.
v17 (2026-08-13): `buildGradeMeta` no longer SKIPS a grading grade. It used to
`continue` on `rawGrade === 'Grading'` so the grade consumed no rank slot — sound
reasoning, but it left the grade with no metadata at all, so the page could not
label it and could not tell it from a grade whose metadata was simply missing.
A grading grade now gets an entry with `r: 0` and `grading: true`: unranked, so
A/B/C/D keep 1..4 and a team row still reads "2 of 4", and flagged, so zero is
distinguishable from absent. The entry also carries `name`, PlayHQ's verbatim
grade name, because `index.html` never loads `grades.json` and a LABEL is no use
for identifying a grading grade — labels are "A", "Blue", "Division 1".
Detection widened from the exact `rawGrade === 'Grading'` to `/grading/i` on the
name: "U13 Mixed GRADING", "U12 Girls (Grading)" and "U12 Mixed Grading" all
occur across the five competitions and the exact test caught only some.
v18 (2026-08-16): a result that supersedes a stored FIXTURE now CLEARS the
`scheduled` flag, and the promotion counts as an update so the run commits.
`fetch-fixtures.js` writes its record under the same match id this builds, so a
played game merges into it at `{ ...prev, ...m }` — and a result record has no
`scheduled` key, so there was nothing to overwrite `prev.scheduled` and `true`
survived the spread. The record kept correct scores and stayed classified as a
fixture, which put it in `S.fixtures` instead of `S.matches` and made
`isPlayed()` false, so it was absent from the results list and drawn with blank
score cells in the finals view. **It never self-corrected**: the scores merged in
on the first run after the game, so every later run found them equal, reported
`0 new, 0 updated`, and the workflow skipped the commit — a log indistinguishable
from a run with nothing to do. Measured 2026-08-16 on EFNL 2026 Veterans: four
Semi Finals records stored with hScore 59, 33, 86 and 68, all four flagged
`scheduled`, none on screen. `provisional` is deleted with the flag, because
`isProvSide()` tests `m.provisional && !m.hLogo` and the logo strip runs on
records that are no longer scheduled — a surviving flag would render a played
team as a greyed placeholder. `time` is kept. Reported as `Promoted N stored
fixture(s) to results`.
v20 (2026-08-19): `cleanTeam`'s no-gradeAge fallback strips NOTHING and warns.
It used to strip any `U`-number, so one PlayHQ name became two stored names —
`Mt Eliza JFC U17 Boys Red` in a `U17.5` grade was stored both as itself (the
gradeAge path cannot match `U17` against `U17.5`) and as `Mt Eliza JFC Boys Red`.
Because a match id embeds team names, the same game was then stored twice. Four of
the 24 duplicates repaired on 2026-08-19 came from this. The `.5` behaviour is
deliberately unchanged: stripping the base number would rewrite the id of every
stored `U17.5` and `U18.5` record and create a new duplicate for each.
v19 (2026-08-16): `lastRound` is GONE — the build loop, the per-competition merge,
`lastRoundKey()` and its export. It recorded the highest home-and-away round per
grade for one reader: a small round tag on the ladder grade tabs, removed in Beta
0.176. It never drove fetching; `knownRounds` does that, built in memory from the
stored records, so the round walk is unchanged. The `covered` set and the
`gradeMeta` per-competition merge that sat beside it are untouched.

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

**`repair-scheduled-results.js`** — v1  
Offline (no PlayHQ calls). Clears the `scheduled` flag from stored records that
are actually results — the backlog engine v18 stops accruing but cannot reach.
The engine only repairs a record whose round is re-fetched, and three things stop
that: a round holding one proper result is skipped as already stored, a grade
whose season has ended is skipped entirely, and archived seasons are out of scope
for `fetch-results.js`. This reads every season through `store.load(null,
{ players: false })`, so none of those apply.

**The rule** (agreed 2026-08-16). A record is a disguised result when all three
hold: `scheduled === true`; any of the six score fields is non-zero; and it has
no date, or a date of today or earlier (AEST, string compare on `YYYY-MM-DD`).
The score test is what makes it safe — an unplayed game cannot carry a non-zero
score, so no real fixture can be caught. A future-dated record carrying a score
is a contradiction and is LISTED, never repaired: either the date or the score is
wrong and the script cannot tell which. A genuine 0-0 or an all-zero forfeit is
indistinguishable from a fixture by this rule and is deliberately left alone,
counted separately so the residue is a number rather than an assumption.

Per-match logos are NOT stripped here — `results-engine.js` harvests them into
`teamLogos` and strips them in the same pass, and will do so on the next run now
the records are no longer scheduled. Dry-run unless `--apply` or
`REPAIR_APPLY=true`. Idempotent: a second run finds nothing.

**`cleanup-rename-duplicates.js`** — v5  
Offline. Removes a duplicate record left by a team rename, where one of the pair
carries PlayHQ's `gameId` and the other does not. Requires identical scores and
date plus the same clubs — either an exact shared team name (one club renamed) or
one identical extra token on BOTH sides (a competition marker such as ` - LP`).
Colours are refused as a marker: two teams from one club can differ only by colour
and did both score 24-40 in the same round.

It also REPORTS, without deleting, pairs where NEITHER record has a `gameId` —
those cannot be resolved offline because nothing stored says which name PlayHQ
serves now. Dry-run unless `--apply`.

**`repair-duplicate-names.js`** — v2  
Online. Handles exactly what the above reports: fetches each affected round and
keeps the record whose team names PlayHQ still serves, stamping it with the
`gameId` so the pair cannot recur. Where both names are served they are two real
fixtures sharing a score and date, and where neither is, it says so and prints what
WAS served.

**⚠️ These rounds are unreachable by the normal fetch path.** `knownRounds` is
built in memory from stored records and `fetchGrade` skips anything at or below it,
so neither `fetch-results.js` nor `backfill.js` will ever revisit them.

Applied 2026-08-19: 21 records removed across SER 2026 and SEJ 2026 — 4 from
`cleanTeam` storing one PlayHQ name two ways, 17 from a ` - LP` Lightning
Premiership marker. 13 archived pairs were correctly refused as two real games.

**Retired 2026-09-13: the round-refetch probe.** It settled whether
`discoverFixtureByRound` re-serves a completed round — it does, in full — and that
answer is recorded in `playhq_api_reference.md` and at §9 below. The method is
worth remembering even though the script is gone: it compared returned games
against stored `gameId`s, NOT against the stored record count, which was inflated
by the very duplicates it was investigating.

**`enrich-games.js`** — v7  
Backfills PlayHQ game ids AND per-quarter scores across every stored season, from
ONE dispatch. Replaces `backfill-game-ids.js` and `fetch-quarter-scores.js`, which
walked the same rounds twice and each needed re-running as extraction bugs were
found.

Per grade it fetches the round list once, stamps `gameId` onto records that lack
one, then fetches each game's periods.

**⚠️ IT IS DESIGNED TO BE INTERRUPTED.** ~53,000 games will not fit in a six-hour
runner. It commits and pushes as it goes, stops on a time budget, and
re-dispatches itself. Nothing needs watching.

Four separate pieces of state make that work, and each was added only after a run
proved it necessary:

| | what it stops |
|---|---|
| `qV: 2` on a record | re-fetching what this version already got |
| `qNo: <date>` on a record | re-asking a game PlayHQ has nothing for |
| `enrichPass` in `core.json` | re-walking grades this PASS already covered |
| checkpoint + push | losing everything when a run is cancelled |

**⚠️ `qNo` EXPIRES AFTER ONE DAY FOR A LIVE SEASON**, never for a retired one. A
scorer filling quarters in on the Monday after a game is the normal case. The
saving comes from the retired seasons — 45,000 of 52,000 records — where the answer
is settled for good.

**⚠️ PUSHING IS NOT FREE.** Every push rebuilds and redeploys GitHub Pages. Saving
to disk happens every 200 records; pushing happens at most every 20 minutes. At
checkpoint frequency a 17-hour walk produced ~680 Pages builds.

**⚠️ `store.saveCore` WOULD HAVE DROPPED THE CURSOR SILENTLY** — it copies only
keys in `CORE_KEYS`. The cursor is read-patch-written directly instead, rather than
adding a scratch value to a file every reader loads.

**`build-player-index.js`** — v2  
Offline. Builds `data/player-index.json`, the cross-season player search index.
`cross_season_search_design.md`.

**One row per PERSON**, seasons nested, every string dictionary-encoded:

```
{ seasons:[...], teams:[...], ages:[...], grades:[...],
  people: [ [uuid, name, [[seasonIdx, teamIdx, ageIdx, gradeIdx], ...]], ... ] }
```

Team, age and grade ride on every season entry so a search result is identifiable
at a glance. Written as plain strings that costs 13.29 MB, because 7,670 team names
repeat across 160,172 person-seasons; through dictionaries it is **6.30 MB raw and
2.65 MB gzipped**, which is what a reader downloads.

**⚠️ Reads ONE SEASON AT A TIME** and releases each before the next.
`store.load(null, { players: true })` would hold all eighteen player files at once
— 82.66 MB of JSON parsed into objects is several times that live.

**⚠️ Folds two grades in one season into ONE season entry.** `fetch-stats.js`
stores one record per grade, so 19,571 records are a second or later grade within a
season the person already appears in. An abort guard throws if rows ever exceed
distinct uuids — one row per person is the invariant the sizing rests on.

**Skips manifest entries that are not seasons.** 47 of the 65 entries are
organisations from `organisationCodes[]` with no `compName` or `seasonId`; each was
being loaded and interned as an empty season slot.

**Write-only-if-changed**, ignoring `generatedAt`, or the weekly run would commit
6 MB every week whose content is identical.

**`build-player-index.yml`** — WEEKLY, Monday 03:15 UTC (14:15 AEST), clear of the
weekend results runs. Not chained to `fetch-stats.js`: few players are added
mid-week, so the index may be up to a week behind for a brand-new player. Decided
deliberately — `cross_season_search_design.md` §10.2.

**`discover-seasons.js`** — v6  
Discovers seasons per organisation from PlayHQ and writes the manifest in
`core.json`. **Scheduled DAILY** since 2026-09-07 (04:30 AEST); also run by hand
before a backfill when a new season appears.

v3 (2026-09-07): **carries EVERY key of an existing manifest entry forward.**
Until then it rebuilt entries from the API and preserved exactly one key,
`phases` — measured by writing `state` onto an entry and finding it gone after one
run. The prior entry is now spread under the derived fields, the same shape
`store.save` uses, so fields the API supplies win and anything else survives.

v4 (2026-09-07): derives **`state`** (`upcoming | active | complete`) and
**`stateAt`** per season — see §3.6 and `offseason_mode_design.md`. Prints
`NEW season …`, `STATE <id> <comp> a -> b (reason)`, `backstop …` and
`WARNING …` lines, and a `season state: {…}, N transition(s)` summary.

v5–v6 (2026-09-08): the `organisations[]` config shape (§3.8). A `tracked: true`
organisation's `name` is the short name compName is built from; untracked ones
keep `compName: null`. **Round-trip guard:** before writing, every prior entry
that had a compName must get the identical string back, or the run exits 1
with the drifts named and `core.json` untouched. Log: `round trip proven for N
stored compName(s)`, `tracked organisations: 5 (…); watched only: 12`. The
proposed-config block and the UNPROVEN warning print only under the old shape.

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

**`audit-data.js`** — v17  
Read-only. Reads `data/seasons` and reports: file sizes and the core/players
split, per-season record counts, round gap analysis (live vs retired),
`grades.json` coverage, grade identity migration state, a sized estimate
of what a cross-season player search index would cost, and (v11) the shape of
the `lastRound` and `gotwFlags` keys in `core.json`.
v13 (2026-08-13): a record with NO `gradeId` is no longer bucketed into round
coverage under a `compName|age|rawGrade` fallback. That fallback merged unrelated
grades and INVENTED gaps — it reported `LIVE YJFL 2026|U10| — has 1..14, missing
8..13`, where the key is six pools piled together and no single pool has a
contiguous run. Such records are counted and reported as unattributed instead.
v14 (2026-08-13): section 11 counts player records per person per season.
v15 (2026-08-13): section 10 states in its own output that it CANNOT show the
Beta 0.166 attribution change working — it tests `hg === ag` from the roster,
which that change deliberately left alone, so a steady figure is not a failure.
v16 (2026-08-16): section 8 divides by PERSON-SEASONS rather than records, and
labels the record count as records. `fetch-stats.js` stores one record per grade,
so a child in two grades in one season was counted as two seasons — 2.54 against a
true 2.27. **The index BYTE figure was never wrong**: it is built from a `Set` of
season ids, so a second record in the same season adds no entry. The earlier note
calling 5.67 MB inflated is retracted. Section 9 no longer shape-checks
`lastRound`; it reports it as RETIRED with its count, and raises INFO while any
key remains.

**Section 9** — the shape of the `lastRound` and `gotwFlags` keys.
**Section 10** — records the dashboard never shows, split three ways: DEFUNCT
(the stored grade has no team resolving to it), LIVE (a promotion), and NO GRADE
(neither side resolves at all). Measured 2026-08-13: 3,967 records, 7.6%, in every
one of the eighteen seasons.
**Section 11** — player records per person per season. Measured 2026-08-13:
18,540 person-seasons hold MORE THAN ONE record, up to four. `fetch-stats.js`
stores per grade, so `index.html` must aggregate. **Section 11 has no assertions
in `verify-audit.js` and its figures are unverified.**
v12 (2026-08-13): round-gap examples are ranked LIVE first, then by rounds
missing, before ten are printed. They used to be the first ten found in file-read
order, so on 2026-08-13 one live gap and 67 retired ones produced ten retired
examples — the only gap with a per-run cost was the one not shown. Exits non-zero if
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
| `verify-per-season.js` | 74 | `store.js` and `split-by-season.js`; `readConfig`/`fetchTargets` in both config shapes |
| `verify-registrations.js` | 58 | `walk-registrations.js` — cohort, due order, budget, tracked/other split, after-season-end rule, club trigger, migration, gzip conversion, pacing |
| `verify-backfill.js` | 126 | `backfill.js`, `fetch-results.js`, `results-engine.js` |
| `verify-discover-seasons.js` | 78 | `discover-seasons.js` — carry-forward of every manifest key; `state` in every branch; the `organisations[]` shape and the round-trip guard |
| `verify-migrate-grade-ids.js` | 54 | `migrate-grade-ids.js` |
| `verify-dashboard-grades.js` | 312 | `index.html` silent failures |
| `verify-rebuild-grade-meta.js` | 22 | `rebuild-grade-meta.js` |
| `verify-audit.js` | 81 | `audit-data.js` |

`verify-dashboard-grades.js` covers only things that **fail silently**: a
promoted team appearing on two ladders, a scorer filtered out because their
team isn't in the roster, the page hanging because `render()` threw, year
and competition lists that can't be built for a season with nothing loaded.
Layout is not tested here — it's visible on screen in a second, and a regex
over the source cannot judge whether it reads well.

---

**`walk-registrations.js`** — v4 (2026-09-07)  
The daily registrations slice — `registrations_design.md` §3. Picks the players
most due (triggered → never checked → oldest `nextCheck`), up to
`ceil(cohort / 7)` calls (5,715 on 2026-09-07) and a 100-minute wall clock, at
100 calls per 80 s (§8d: this operation blocks at ~147 unpaced calls, 2.07
req/s; 1.88 req/s ran clean). One `discoverTeams(filter:{seasonID})` call per
UPCOMING tracked season feeds the **club trigger**: a club whose team count rose
since the last run marks every cohort player from that club due now. Logs:
`migrated …`, `cohort: N people`, `club trigger …`, `due: N (…)`, the summary,
the first five error messages, the first five players with no own-season record,
and the first ten pre-season records raw. Exit 0 changed, 2 no change, 1 fatal.
Two real runs on 2026-09-07: 5,715 calls each, ~80 minutes, no WAF block,
one PlayHQ 500.

**`probe-registration-budget.js`** — v1, read-only  
Measured the `publicProfileTeams` budget and looked for pre-season records
(§8d, `playhq_api_reference_updates.md` §12). Keep for the day a 2027 season
appears: it prints the first pre-assignment records raw and asks
`discoverTeams` whether the upcoming season returns teams yet.

## 5. Workflows

All workflows use `workflow_dispatch` unless noted.

| Workflow | Script | Notes |
|---|---|---|
| `verify-store.yml` | all 7 verify-*.js | **Auto-runs on push to scripts/**, index.html, org-discovery.html |
| `fetch-results.yml` | fetch-results.js, fetch-stats.js, fetch-fixtures.js | Three CHAINED JOBS, not three run modes — see 5.1. **Season gate** in every job since 2026-09-07 (see 5.3); `FETCH_INCLUDE_COMPLETE` carries `ignore_season_gate` to the scripts; `concurrency: playhq-data-write` |
| `fetch-stats.yml` | fetch-stats.js | Has `include_retired` input for backfill |
| `fetch-fixtures.yml` | fetch-fixtures.js | |
| `backfill.yml` | backfill.js | Has `comp` filter and `dry_run` inputs |
| `discover-seasons.yml` | discover-seasons.js | **SCHEDULED DAILY** 18:30 UTC / 04:30 AEST since 2026-09-07; `concurrency: playhq-data-write`. Also run by hand before a backfill |
| `discover-orgs.yml` | discover-orgs.js | Writes data/org-discovery.json |
| `build-club-index.yml` | build-club-index.js | Has `comp` filter and `refresh` inputs |
| `migrate-grade-ids.yml` | migrate-grade-ids.js | Has `org` and `dry_run` inputs |
| `rebuild-grade-meta.yml` | rebuild-grade-meta.js | Has `org` and `dry_run` inputs |
| `split-by-season.yml` | split-by-season.js | Has `dry_run` input; one-off migration |
| `repo-tidy.yml` | repo-tidy.js | Has `groups` and `apply` inputs |
| `audit-data.yml` | audit-data.js | Has `strict` and `org` inputs |
| `build-player-index.yml` | build-player-index.js | **Scheduled WEEKLY**, Mon 03:15 UTC. Has `dry_run` |
| `enrich-games.yml` | enrich-games.js | Self-chaining. `concurrency: playhq-data-write` |
| `walk-registrations.yml` | walk-registrations.js | **DAILY** 19:30 UTC / 05:30 AEST. Off-season gate: runs when any tracked season is complete or upcoming, skips when all are active; input `ignore_gate`. Commits only `data/registrations.json.gz`. `concurrency: playhq-data-write` |
| `probe-registration-budget.yml` | probe-registration-budget.js | Read-only. `concurrency: playhq-data-write` (shares the WAF budget) |
| `probe-round-periods.yml` | probe-round-periods.js | Read-only |
| `probe-preseason-roster.yml` | probe-preseason-roster.js | Read-only |
| `probe-round-flags.yml` | probe-round-flags.js | Read-only |
| `probe-nonfinal-scores.yml` | probe-nonfinal-scores.js | Read-only |
| `cleanup-rename-duplicates.yml` | cleanup-rename-duplicates.js | Offline; dry-run default |
| `repair-duplicate-names.yml` | repair-duplicate-names.js | Online; dry-run default |
| `report-grade-collisions.yml` | report-grade-collisions.js | Read-only |
| `repair-scheduled-results.yml` | repair-scheduled-results.js | Has `apply` and `comp` inputs; no PlayHQ calls |
| `probe-ser-logos.yml` | probe-ser-logos.js | One-off; add to probes group and remove |

### 5.1 `fetch-results.yml` inputs — read this before dispatching it

Corrected 2026-08-13 against the real file. The previous entry said "three jobs:
VIP-only, all, scheduled", which described neither the jobs nor the inputs and
sent a dispatch looking for an "all" control that does not exist.

**Three inputs:**

| Input | Values | Default | Effect |
|---|---|---|---|
| `fetch` | `both`, `results`, `stats`, `fixtures` | `both` | which of the three jobs actually do work |
| `vip_only` | `'false'`, `'true'` (strings) | `'false'` | sets `VIP_ONLY`; `'true'` limits to competitions with `vip: true` |
| `include_retired` | `'false'`, `'true'` | `'false'` | sets `STATS_INCLUDE_RETIRED` — Phase B backfill only |

**To fetch results for all five competitions: `fetch: both`, `vip_only: false`.**
There is no "all" option. "All competitions" IS `vip_only: false`.

**Three jobs, chained by `needs: fetch-results`:** `fetch-results`, `fetch-stats`,
`fetch-fixtures`. Each reads the same `fetch` input and decides for itself whether
to do work, so `fetch: results` still starts the other two — they exit at their own
mode check. `fetch: both` runs results and stats but NOT fixtures, which only runs
on `fetch: fixtures`.

Each job commits separately with `git add -A data/` then
`git pull --rebase -X theirs`, and only when its script exited 0.

**Scheduling is external, with ONE exception.** A Cloudflare Worker (`footy-cron`)
triggers `workflow_dispatch` at AEST times for the fetch workflows.
`build-player-index.yml` is the only workflow carrying its own GitHub Actions
`schedule:` block — it needs no PlayHQ session, so it does not need the Worker.
The first step logs the expected cron match, so an unexpected trigger time prints
`NO MATCH` rather than failing.

**Dead code in `fetch-stats`'s "Determine stats mode".** The scheduled branch ends
`exit 0`, and two lines after it — a comment and `echo "vip_only=false"` — can
never execute. Harmless, but the step does not do what reading the bottom of it
suggests.

### 5.2 Which rows above have been verified against the real file

Verified: `fetch-results.yml`, `verify-store.yml`, `probe-team-join.yml`,
`report-field-usage.yml` (new 2026-08-13), `probe-concurrent-comps.yml`
(new 2026-08-13).

**Not verified — carried forward and liable to the same drift the fetch-results row
had:** `fetch-stats.yml`, `fetch-fixtures.yml`, `backfill.yml`,
`discover-seasons.yml`, `discover-orgs.yml`, `build-club-index.yml`,
`migrate-grade-ids.yml`, `rebuild-grade-meta.yml`, `split-by-season.yml`,
`repo-tidy.yml`, `audit-data.yml`, `report-grade-collisions.yml`. Open the file
before trusting a row.

### 5.3 The season gate — `fetch-results.yml`, 2026-09-07

Each of the three jobs has a `Season gate` step that reads `data/core.json` and
sets `in_season`. **Off season** when every tracked manifest entry (one with a
`compName`) has a `state` other than `active` or `upcoming`; the Fetch and Commit
steps are then skipped and the log says `OFF SEASON — every tracked season is
complete for 7+ days`. A `complete` season whose `stateAt` is under 7 days old
still counts as in season (`RECONCILING (complete < 7 days): …`) — the final
reconciliation pass, decided 2026-09-07, is the following week of normal
dispatches. A manifest with no `state` anywhere (pre-v4) is treated as in season —
the failure that costs a few calls, not a missed weekend. Input
`ignore_season_gate=true` runs regardless, for a late correction after the grand
final. The gate's shell text was executed against six manifests before delivery;
the off-season branch has not yet been true on real data. The fetch scripts do
not read `state` or PlayHQ `status` at all, so the gate is the only thing that
stops a complete season being walked.

The gate skips `retired` seasons (added 2026-09-08 after the 2022–2025 seasons,
all stamped on the day `state` was introduced, read as "complete for a day" and
held it open — the scripts would not have fetched them, `fetchTargets` excludes
retired, but the gate should agree). A manifest with no non-retired tracked
season is OFF SEASON. First real transition seen 2026-09-08: YJFL 2026 flipped
on PlayHQ's word the day after its `endDate`; the backstop was not needed.

All three checkouts use `ref: ${{ github.ref_name }}` (one had none, two had
`main`). `setup-node@v4` is still present in all three jobs and has never caused a
403 here — see `working_practice.md`, "actions/setup-node … UNVERIFIED".

**Workflows to be deleted by repo-tidy (`storage2026,probes,historic`):**
- `cleanup-obsolete.yml`, `split-data.yml`, `report-data-size.yml`
- `probe-api-session.yml`, `probe-grade-teams.yml`, `probe-team-grades.yml`,
  `probe-stored-grade.yml`, `probe-search.yml`, `probe-ser-logos.yml`

---

## 6. The dashboard (`index.html`) — Beta 0.219

**Beta 0.219 (2026-09-07):** next-season line in the player panel.
`#pm-next`, one line under the team line, shown ONLY when the panel is on the
player's latest season (the one the walker started from). Rules in order:
`2027 — registered with <club>` (`· <team>` once assigned, `(<comp>)` if a
different tracked competition); `2027 — now at <league>` for an outside
registration whose season is 60+ days (carnivals never qualify); `2027 — no
registration yet` when the next manifest season for that competition exists, the
player was checked after it appeared (`at` > the entry's `stateAt`) and has a
harvested club. Data from `data/registrations.json.gz`, fetched on the first
panel open, inflated with `DecompressionStream` (or taken as JSON if the server
already inflated it — decided by the gzip magic bytes). Today, with no 2027
season anywhere, every player shows nothing.

⚠️ This heading goes stale. The version badge in the committed `index.html` is
the only authority.

**Beta 0.217 (2026-09-07):** season-state tag. A small mono tag at the right end
of the sidebar's "Season" label reads SEASON COMPLETE or UPCOMING, with `Since
<date>` in the tooltip, from the manifest entry of the SELECTED COMPETITION
(`state` is per season, so it follows the competition chip, not the year). Hidden
for `active`, for an entry with no `state`, and for any other value. Rendered by
`renderSeasonState()` from `renderAgeTabs()` once `S.selComp` is settled. No fetch.

**Beta 0.218 (2026-09-07):** `renderAgeTabs()` hid `#comp-filter-group` when a
year had one competition — but that id is on the SEASON group (it kept its id when
the year selector moved in above it); the Competition group is
`#comp-filter-group2`. Never fired: every stored year has more than one
competition. Corrected to `comp-filter-group2`.

### 6.1 Data loading

On page load, `loadStoredData()` fetches `data/core.json` and then the five
live seasons' `-core.json` files (matches, roster, gradeMeta). Player records
are fetched separately, after first paint, via `requestIdleCallback`.

When a past year is selected, `loadSeasons()` fetches that year's core files
and merges them into the in-memory state. The fetched season stays in memory
for the session, so switching back is instant. Players for the new season are
loaded via `loadPlayers()` in the background.

### 6.2 Grade grouping

The round tag that sat on each ladder grade tab is GONE (Beta 0.176), and
`lastRound` with it. It rendered nothing at all from Beta 0.133 until engine v14,
because the writer built a two-segment `age|rawGrade` key and the reader a
three-segment `compName|age|gradeId` one; once it worked it was not worth the
space.

Ladders group by `gradeId` (PlayHQ's own UUID). Grade tabs are labelled via
`gLabel(gradeId)`, which reads from `S.gradeLabelById` (built from
`S.gradeMeta`). When two grades collapse to the same `rawGrade` key, the
disambiguation appends a suffix.

A promoted team counts on one ladder only — the grade its roster entry
currently says it is in. `precomputeMatches()` runs on every batch of new
records (load, backfill load, year-switch load) and must run after the roster
is merged in.

### 6.2a Game of the Week key

`gotwFlags` is keyed `compName|age|roundKey` and built in one place,
`gotwKeyFor(comp, age, rKey)`. There are five call sites — the admin picker
writes and four readers look up — and they must agree, because a divergence shows
the automatic closest-margin pick and looks entirely normal. The competition comes
from the match record, not `S.selComp`: the admin picker has its own competition
dropdown independent of the sidebar filter.

Picks are written to browser storage only. Nothing pushes them to the repo, and
`core.json` wins on load when its `gotwFlags` is non-empty.

### 6.2b Grade attribution — listing versus ladder

`grade_attribution_split_design.md`. `matchGrade()` is GONE, split in two because
seventeen call sites were asking two different questions through one name:

- **`matchListGrade(m)`** — where a result is LISTED. Always `m.gradeId`, PlayHQ's
  own answer to which grade the game was played in. Falls back to the roster grade
  then `rawGrade` for pre-migration records.
- **`matchLadderGrade(m)`** — what it COUNTS TOWARDS, or null. A grading grade
  returns itself; otherwise the teams' agreed grade; otherwise null.
- **`matchCounts(m)`** — one predicate meaning "does this count", defined as
  `matchLadderGrade` returning something. Thirteen call sites use it. `matchIsValid`
  survives only as the raw sides-agree test used by `precomputeMatches`.

`precomputeMatches` caches `_valid`, `_grade` (the ladder grade), `_ladder`, and
`_hg`/`_ag` so the cached and live paths cannot diverge.

**A grading grade is its own competition.** It gets its own tab and ladder, and its
ladder counts EVERY game played in its rounds whatever division the two teams were
later placed in. `matchIsValid` was removed from the ladder filter for this — and
it was redundant for every other grade anyway, because `matchLadderGrade` already
returns null when the sides disagree.

**A tab comes from LISTING, not from counting.** `gradesForAge` has no counts
filter: a result that counts nowhere must still have somewhere to appear.

**Grading grades have no Scorers list.** A player has one record per season, in the
grade they ended in, with `gp` and `goals` summed across grades — `aggregatePlayers`
groups on `uuid`, never on name.

### 6.2c Upcoming Fixtures — the grade filter joins on the grade id

`renderFixtures` tested `grades.has(m.rawGrade)` until Beta 0.175. `activGrades()`
returns `gradesForAge()`, which is built from `matchListGrade()` and
`matchLadderGrade()` and therefore holds PlayHQ grade IDs — never "A", "Premier"
or "Blue". A fixture record's `rawGrade` is one of those strings, so the test
could never match and every fixture in a migrated grade was dropped. With 99.91%
of records migrated that is effectively all of them, and the empty-list guard then
hides the whole section, so it failed in complete silence.

It was invisible for as long as it was because the section only has something to
show when fixtures exist ahead of the results — through the home-and-away season
`fetch-results.js` had usually caught up, so an empty section looked correct.

The grade tag and the `openTeamDrilldown` argument in the same function had the
same defect: `rawGrade` where `renderResults` passes the id, which mislabelled the
tag (blank for the 83 grades whose `rawGrade` is empty) and opened a drilldown
keyed on something nothing else uses. All three now use `matchListGrade(m)`.

### 6.3 Season selector

Year is the outer scope. Choosing a year narrows the competition list to the
competitions that ran in it. Both lists come from the manifest (`S.manifest`),
not from loaded records — a past year has nothing in `S.matches` until its
files are fetched, so deriving the list from records would show an empty
competition list.

### 6.3b The player panel

A LIVE PlayHQ fetch, not a read of `S.matches` — it covers competitions the
dashboard never stores, such as representative football, which is why some rows
show a dash.

Its query returns `round { name }`, so a row's round is the STRING "Round 1", not
a number. Score and result are joined from `S.matches` on the parsed round number
plus both team names stripped of age. **Finals are detected by the name containing
"final", not by the absence of a digit** — PlayHQ's finals round names are "Finals
Round 1", which contains one, and a no-digit test sent every finals row to the
home-and-away branch to find a different game. Finals then match on team names
alone within `isFinals` records, because a pair meets at most once in a finals
series; home-and-away rounds keep matching on the number, because two teams can
meet twice.

**The score is NOT available from the query.** `result { home { score } }` was
added on 2026-08-16 and PlayHQ rejected it — the game type returned by
`gameStatistics` has no such field, and a GraphQL validation error fails the WHOLE
query, so every player showed "No 2026 season stats found". Reverted.

**⚠️ ONE PERSON MAY HAVE SEVERAL STORED RECORDS.** `fetch-stats.js` stores one
record per GRADE, so a child who turns out for two teams has two. The header strip
took `S.players.find(uuid)` — the first of them — and read `gp` and `goals`
straight off it, while the list below is a live per-PLAYER fetch showing every
team. Measured 2026-08-18 on one player: U12 B 16 games / 28 goals plus U13 B
2 games / 1 goal, so the strip said 16 and 28 above a list of 18 games and 29
goals, with nothing on screen to explain the gap. Fixed in Beta 0.191 — the strip
sums every record for that person, the tooltip carries the per-team split, and a
"+ N other teams" note sits under the name.

**Scoped to the SELECTED SEASON, then to the biggest team within it.** Picking the
primary record by games played across everything loaded looks right and is not: a
previous season usually has more games than a part-finished current one, so
viewing 2026 would have shown 2025's totals and 2025's team. The season comes from
`S.selYear`, matched against the year inside `compName`; a player with no records
in that year falls back to the year holding most of their games rather than
rendering an empty strip. Summing is by year and not by competition, because a
player can appear in two competitions in one season and both belong in the total.

**⚠️ ROWS JOIN ON PlayHQ's OWN `gameId`** (Beta 0.197). `gameStatistics` returns a
`game.id` on every row and engine v16 stamps the same id onto every stored record,
so that is an exact key on both sides — no name matching, no round parsing, no way
to land on a different game.

The panel matched on round + team names for its whole life, and those names are
ambiguous by construction: `cleanTeam` strips the age, so a club's U9, U10 and U11
sides all reduce to one string. Measured 2026-08-20 — a U11 player's list carried a
U9 row scoring 0-0 and a U10 row scoring 1-82, because `find` reached another age
group's record first, and the score, result AND age all came from it. Two rounds of
hardening the name match (0.190 added the age to the row, 0.196 constrained the
join by it) were fixing a problem that only existed because an exact key was
available and unused. **Before hardening a fuzzy match, check whether an exact key
exists.**

The name join REMAINS as a fallback, still age-constrained: records written before
engine v16 carry no `gameId`, which is every retired season.

**The games shown are the SELECTED season** (Beta 0.195). This read
`seasons.find(s => s.name === '2026')` — a literal year — so a 2025 header sat above
2026 games. A player with no record for the selected year gets "No 2025 games for
this player" and the list of seasons PlayHQ does hold; it does NOT fall back to
another season, which is the defect being fixed.

**A season switcher in the header** (Beta 0.199–0.201). Every season the person
played, newest first, year only, current one in gold. Clicking one goes through
`openPlayerFromSearch`, the same path a search result takes, so the two routes
cannot drift. It lives in the header rather than its own row — a separate strip
pushed everything below it down and duplicated the year badge beside the close
button — and wraps to a second line, capped at two with a scroll.

Seasons come from the index when loaded, otherwise the loaded records. **The index
is fetched when the panel OPENS**, not only on a search keystroke: before Beta
0.201 a player opened from Scorers showed one button, and after any search every
player grew the rest. The panel renders immediately and the strip redraws when the
file lands, guarded on the panel still showing that player.

**Each row shows its AGE GROUP beside the grade** (Beta 0.190). Without it, two
rows in the same round were indistinguishable — a U12 player's U13 games read as
duplicate rounds against the wrong opponent with the wrong result, when both were
real U13 games. The age comes from the joined stored record's `m.age`, which is
the string the rest of the dashboard groups by; a row that joined to nothing falls
back to parsing PlayHQ's grade name ("U13 - B", "Division 5") and then the team
name ("The Basin Senior Women Green").

### 6.3c The team drilldown

Opened from a team name. Shows every match for that team, age and competition —
all grades, so a side that played grading and was then placed appears once with
the non-counting rows dimmed.

**Finals sort LAST and carry their abbreviation** (Beta 0.188). Finals rounds
restart numbering at 1, so sorting on `m.round` alone put Finals Round 1 beside
home-and-away round 1 and the preliminary final beside round 2. Measured
2026-08-18: the list showed two "Rd 1" rows and two "Rd 2" rows, one of each a
final, which read as duplicates. Rows now print `finalsAbbrev` (FR1, PF, GF) in
gold with `finalsName` on hover.

**Season totals include finals; MR% and Pct do not** (Beta 0.189). Played, Won,
Drawn and Lost are the whole season, because that is what a reader means by
"played" — before this the strip could read `0 LOST` above a list containing a red
finals loss, a contradiction with no way to resolve it. MR% and percentage stay
home-and-away because they are LADDER figures and a ladder is home-and-away only;
including finals would make them disagree with the ladder on the same screen. Said
in the tooltip, which is the only place with room.

**A third breakdown cell for finals**, beside Home and Away, shown only when the
team played one. `.team-ha-strip` uses `grid-auto-flow:column` rather than a fixed
column count, because the cell is conditional — a hard `1fr 1fr` wrapped the third
onto its own row, and the same mistake put a seventh stat cell onto a second row
in `repeat(6,1fr)`. **Both strips have a fixed column count: check it before
adding a cell.**

### 6.4 Player search — every season (Beta 0.192)

Token matching in any order: `toby jo`, `jovic to` and `to jov` all find Toby
Jovic. **One row per PERSON**, not per person-season — a player who has been in the
data four years returns one result, not four.

Search used to be scoped to the SELECTED season, so a player who left in 2024 was
unfindable from a 2026 view. It now reads `data/player-index.json`, loaded on the
first keystroke and held for the session. `cross_season_search_design.md`.

A row is named by the player's most recent season and carries **team · age ·
grade**, which is what tells two people called Jack Smith apart — a bare index row
could not. Earlier seasons appear as year chips. **Ordering is the selected season
first, then most recent.**

**⚠️ If the index cannot be fetched, search falls back to the loaded seasons and
SAYS SO** — `index unavailable — searching 2026 only`. Silently narrowing is how
"not loaded" gets read as "no such player", which is the ambiguity the old scope
note existed to prevent. The fallback groups by `uuid` too, so one person in two
loaded seasons is still one row without the index doing the work.

`openPlayerFromSearch(uuid, seasonId)` opens a result. **The season switch is
unconditional; only the LOADING is conditional.** It sat inside the "needs
loading" branch until Beta 0.194, so clicking a year already in memory set nothing
and the panel — which scopes by `S.selYear` — showed the previously selected year.
It also moves the competition, age group and grade, and re-renders, so the page
behind the panel describes the same team the panel does. The grade is set as a
single-entry Set of the GRADE ID, not the rawGrade — `activGrades()` holds ids.

### 6.4a URL state and deep linking (Beta 0.202–0.206)

`url_state_design.md`. Every view is reachable by link:

```
#y=2026&c=EFNL&a=U12&g=B&l=B&v=finals&fm=club&fc=The%20Basin&q=cum&r=14&t=Norwood
```

| key | meaning |
|---|---|
| `y` `c` `a` | season year, competition short name, age group |
| `g` | sidebar grade filter — LABELS, comma separated |
| `l` | LADDER tab — which grade's ladder is showing |
| `v` | `finals` (omitted for the dashboard) |
| `fm` `fv` `fc` `fg` `fl` | finals mode, venue nesting, club NAME, gender, level |
| `q` | quarter display — `cum` or `q` |
| `r` `t` | round, team |

**⚠️ `g` and `l` ARE DIFFERENT THINGS.** `g` is which grades are visible; `l` is
which grade's ladder is on screen. Every grade can be visible while the B ladder
shows, so one key cannot carry both. `selLdrGrade` persisted nowhere until Beta
0.203, so a shared link opened on whichever ladder came first for that age.

**⚠️ LABELS AND NAMES, NEVER IDS.** `g`, `l` and `fc` carry human-readable values.
A link built on an 8-character grade or club id is unverifiable by eye and breaks
the moment a season is re-graded. They are resolved back through the same
validation the localStorage restore uses.

**Precedence is URL → localStorage → defaults, per key.** A hand-written
`#y=2026&c=EFNL` keeps the reader's saved age and grade.

**⚠️ AN UNLOADED SEASON IS FETCHED BEFORE ANYTHING IS VALIDATED.** Every check
runs against `S.matches`; with the season absent, each finds nothing, discards
every key as invalid, and the link degrades to the default view — indistinguishable
from a broken link.

`pushState` on season, competition, view and finals mode; `replaceState` on age,
grade, round and team. So the back button steps through navigation, not through
every grade click.

The URL rides on `saveFilters()` rather than sixteen call sites, so the URL and the
saved filters cannot disagree. **⚠️ `selLdrGrade` was the exception** — it swaps
tabs by class toggling and never called `saveFilters`, which is exactly why it was
missing from the link.

### 6.4b Live scores (Beta 0.204–0.205)

`live_scores_design.md`. A game being scored on the PlayHQ app carries a running
score, fetched from the spectator endpoint and stored with `live: true` and
`liveAt`.

**It counts towards NOTHING.** The gate is in `matchLadderGrade()`, which returns
`null` for a live record.

**⚠️ THE GATE IS NOT IN `matchCounts()`** — that was the first attempt and it does
not work. `computeLadder()` does not call `matchCounts` at all; it joins on
`matchLadderGrade(m) === grade`, deliberately, since `matchIsValid` was removed
from that filter in Beta 0.166. A live game failed `matchCounts` and still appeared
on the ladder with P=1.

Shown with a pulsing LIVE badge and the age of the reading — "14m ago" — because a
score fetched at 14:12 and read at 20:00 is stale, and saying so matters.

**⚠️ A live game OBEYS THE GRADE FILTER.** It fails `matchCounts` by design, and
`renderResults` has a show-regardless branch keyed on exactly that, so live games
appeared under every grade tab until Beta 0.205. Failing `matchCounts` is a
statement about COUNTING, not about attribution.

**⚠️ THE BADGE IS FULL-WIDTH, NOT INSIDE `.mr-score`.** That column is 64px on a
phone and `.mr-det` is `display:none` there, so a badge tucked beside it is
invisible on the device most likely to be reading a score from the sideline.

In the finals view it is rendered ONCE PER MATCH. `fvSide()` renders one team, so a
badge inside it appears twice.

### 6.4c Quarter scores (Beta 0.207–0.216; MOVED Beta 0.237)

⚠️ **THE CONTROL IS NO LONGER IN THE RESULTS HEADER AND IS NO LONGER THREE-STATE.**
Quarter scores moved into the box score modal (§6.9) in Beta 0.237, so the header
button controlled nothing and was removed. It is now a two-way toggle inside the
modal — **Total / Per quarter**, cumulative by default.

`S.qtrMode` still persists through `saveFilters()` and the URL. The old `off`
value is retired: every read goes through a `qtrMode()` accessor that maps
anything unrecognised to `cum`, so a saved filter or a shared link carrying
`q=off` lands on Total rather than on a state that no longer exists.

Pressing the toggle repaints the open game, not the page — `render()` would
rebuild the results list underneath and leave the modal untouched, which reads as
a dead button.

The rest of this section describes the rendering, which is unchanged.

A three-state control in the Results header: **off → total → each**.

- **total** — cumulative, `10 16 42 42`, matching PlayHQ's "END OF PERIOD" display
- **each** — per quarter, `10 6 26 0`, which is how it is STORED and which shows
  where a game turned

Laid out as a fixed grid, one row per team, spanning **columns 2 to 4** of
`.match-row`. Not `1/-1`: that row is `28px 1fr 80px 1fr minmax(160px,1fr)` and the
venue column makes it asymmetric, so centring across the whole row put the strip
130px left of the score. Each cell is a flex column with `align-items:flex-end`, so
the two-character points and the four-character `2.3` land on the same edge.

Goals and behinds appear beneath the points; cumulative mode totals them
separately. **Dropped entirely below 768px** — four columns of two numbers will not
fit beside a 64px score column, and the points are what matters from the sideline.

Stored per quarter because that is the primitive the API returns; the cumulative
view is derived, never the other way round.

**⚠️ A ROW WITH NO BREAKDOWN RENDERS NOTHING.** No placeholder, no row of dashes.
PlayHQ itself prints a table of dashes for a game nobody entered quarters for, and
that reads as a fault.

**⚠️ A NULL QUARTER IS A GAP, NOT A ZERO.** `qPart` marks quarters never recorded;
they render as `–`. A blank quarter and a scoreless quarter are different things.
In cumulative mode the running total **stops at the first gap** — a total that
silently skips a missing quarter is a wrong number. This applies to the goals and
behinds too: `cumGB` destructured every element until Beta 0.216, and a null entry
threw, killing `render()` and leaving the whole page blank.

**`qFlag`** marks a game whose quarters do not sum to the score — about 1%, almost
all out by one behind or one goal on a single side, because the quarter figures and
the final total are entered separately by the scorer. Shown as an amber `≠`.

**`hQDer`/`aQDer`** mark a quarter CALCULATED from the total when exactly one period
was missing. Dotted underline, because a derived quarter reconciles by construction
and would otherwise look more certain than the reported ones beside it.

**Team codes skip a leading article** — "The Basin" gives `BAS`, not `THE`, which
would be the same for every club beginning with it.

### 6.4d ⚠️ `selLdrGrade` must not early-return

`selLdrGrade()` does not only set state — it toggles the `.ldr-tab` and `.ldr-pane`
classes that decide WHICH PANE IS VISIBLE. Beta 0.203 added
`if (S.selLdrGrade === g) return;` to skip a redundant URL write; after changing age
or grade the panes are rebuilt and the visible one has to be re-selected, often to
the same id, so the guard left the previous age's pane showing until something else
forced a render.

The write it avoided cost nothing: `syncURL` already compares against the last hash.

**Treat `if (x === y) return` as suspicious in any function with side effects
beyond the assignment.** The same shape caused the season switch to be skipped when
a season was already loaded (Beta 0.194).

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

**Within a club, teams sort: premiers first, then by HOW FAR THEY GOT, deepest
first**, with grade strength, age and grade name as tiebreaks (Beta 0.174). Depth
is the maximum `globalGradeRoundIdx` column — offset so every grade's grand final
lands in the last column, making it a measure of distance from the GF and
comparable across grades with different numbers of finals rounds. Unplayed
fixtures count: a scheduled preliminary final is how a live team is identified.
Until 0.174 this was three bands with grade strength inside each, which put a team
knocked out in the first final above a lower-grade team still alive.

Round labels use `finalsAbbrev` (QF, EF, GF etc) on the cell, with the full
`finalsName` ("Qualifying Final") on hover. `finalsName` is PlayHQ's round
name ("Finals Round 1"), not the game type — the abbreviation is what matters.

### 6.6 Finals view — By Venue

Added Beta 0.176. The fourth finals mode, and the only one not organised around a
team, a club or a grade: it answers "where do I need to be, and when". Every
finals match — results and scheduled fixtures alike — grouped by DATE, then by
VENUE, ordered by start time.

Three ordering decisions, none of them arbitrary:

- **Date ascending.** The other modes read backwards from the Grand Final because
  they are about how a campaign ended. This one is a schedule, and a schedule runs
  forwards. Matches with no date go into a "Date TBC" group placed LAST — an empty
  string sorts before every real date, so the naive ordering would put the
  unknowns at the top of the page.
- **Venue alphabetical within a date.** There is no meaningful ranking between
  grounds. "Venue TBC" sorts last, for the same reason as the date.
- **Time ascending within a venue**, then grade strength, then round for matches
  sharing a start time. A venue with no time on any match keeps round order.

Dates are formatted from split parts through `Date.UTC` — never
`new Date(string)` — and compared as `YYYY-MM-DD` strings, which sort correctly
lexically. Times are `HH:MM:SS` and sort the same way.

The venue link is taken from the first record at that ground that carries a
`venueUrl`. Every record at one ground should hold the same coordinates, but a
fixture written before the venue was allocated may have the name and no URL.

Rendered and checked against EFNL 2026 Veterans on 2026-08-16: 14 August before
15 August before 23 August before Date TBC; Mooroolbark Heights Reserve before
Morton Park; 09:00 before 12:30 within Morton Park; provisional sides
("Winner Game 1") drawn without scores.

**Either nesting** (Beta 0.177). `S.venueGroup` decides which level is outer:
`date` answers "what is on this Saturday, and where", `venue` answers "what is on
at this ground, and when". One renderer serves both, so the two cannot drift.
Neither is a filter — the same matches appear both ways — which is why it is a
grouping switch (`DATE › VENUE` / `VENUE › DATE`, inline beside the mode buttons,
shown only in this mode) rather than a sort.

The maps link and the suburb follow the VENUE to whichever level is showing it.
In venue-first the outer heading is the ground, so the link belongs there; leaving
it on the inner heading dropped it entirely, because the inner heading is then a
date. Found by rendering both nestings side by side on 2026-08-16.

**Jump to a group.** A select in the sidebar, labelled "Jump to date" or "Jump to
venue" to match the current grouping, listing the outer groups in display order
with a match count. It is populated by `syncFinalsJump()` from `fvGroupIndex`,
which `renderFinalsByVenue` writes as it renders — **from what was actually drawn,
never derived separately from the pool**, or the dropdown would eventually offer
headings that no longer exist. Group DOM ids come from the key
(`fvGroupId`), not a loop index, so a stale selection misses rather than
scrolling somewhere arbitrary. `scrollIntoView` rather than a hash: a hash pushes
a history entry per jump and puts the whole view behind a Back button that does
not restore it. On a narrow screen the sidebar closes after a jump, or it covers
the thing just scrolled to.

### 6.6a Finals view — By Venue, the grouping switch and the jump

`S.venueGroup` decides which level is outer: `date` answers "what is on this
Saturday, and where", `venue` answers "what is on at this ground, and when". One
renderer serves both. Neither is a filter — the same matches appear both ways —
so it is a grouping switch, not a sort.

The maps link and the suburb follow the VENUE to whichever level shows it. In
venue-first the outer heading is the ground, so the link belongs there; leaving it
on the inner heading dropped it entirely, because that heading is then a date.

**Jump to a group.** A select in the sidebar, labelled to match the grouping,
populated by `syncFinalsJump()` from `fvGroupIndex` — which `renderFinalsByVenue`
writes AS IT RENDERS. Built from what was drawn, never derived separately from the
pool, or the dropdown offers headings that no longer exist. Group ids come from
the key (`fvGroupId`), not a loop index, so a stale selection misses rather than
scrolling somewhere arbitrary.

### 6.6b Finals view — GF-first columns, ladder positions, ALL TEAMS

**Column 0 is the grand final** for every grade (Beta 0.179), no offset, ragged
edge on the right. Per-grade round maps are unchanged, so a team that won its
qualifying final and had a bye still leaves the preliminary-final column blank.
The depth sort was inverted in the same change — deepest run is now the SMALLEST
index — because a sort that silently reversed with the columns would put the
first-eliminated teams at the top of every card, which reads as plausible rather
than obviously broken.

**Ladder position on every row.** `ladderPosOf`, memoised per render because
`computeLadder` rescans `S.matches` on every call. It looks up the LADDER grade,
not the record's own: a promoted team belongs to the grade it is in now, and the
wrong key renders a dash on every row — indistinguishable from a grade that
legitimately has no ladder.

**ALL TEAMS switch**, default off. Non-finalists are held on `extraTeams` and
deliberately NOT merged into `e.teams`: every existing figure is computed from
that array, so folding them in would silently restate the card header, the
summary's Finals column and the sort options.

### 6.7 Finals view — the club summary table

Added Beta 0.177, extended in 0.178. One row per club, above the club cards,
**collapsed by default** — the cards are what the by-club view is for, and this is
a summary you open when you want it.

| Column | Meaning |
|---|---|
| Entered | teams the club fielded, under the current filters |
| Finals | teams that reached the finals |
| Top grade | finals teams in a grade PlayHQ ranks strongest for its age |
| Remaining | teams not eliminated and not yet in a grand final |
| GF | teams named in a grand final, played or scheduled |
| Premierships | teams that have won one |

Every column after Entered carries a percentage of Entered, so the column reads
down consistently. A zero prints as a dash with no percentage.

**Clubs that reached no finals are included.** They cannot come from
`finalsPool()`, so `finalsFilters()` was factored out of it and `enteredPool()`
added — the same records without the `isFinals` test. Both pools share that one
filter deliberately: if the gender or level filter applied to one and not the
other, 6 of 40 and 6 of 12 would both render as perfectly ordinary numbers. A
table of only successful clubs makes every club look successful.

**Counting identity is `comp|team|age`, with NO grade** (`teamCountKey`). A side
that played grading and was then placed in a division is ONE team the club
entered. The club card's own key carries `rawGrade`, so counting on that lets a
club's finals total exceed the teams it fielded and print a percentage over 100.

The table and the cards share one comparator (`cmpEntries`) and are built from the
same `entries` array, so they cannot order the same clubs differently or report
different figures on one screen. Totals are summed from the rows for the same
reason.

Open state lives in `S.clubSummaryOpen` and persists through `saveFilters`. It is
not a `<details>` element: the finals body is rebuilt by `innerHTML` on every
render, so the element's own open state would be discarded and the section would
snap shut on any filter change.

**Sort basis: VALUES or %** (Beta 0.180). "Most GF appearances" and "the highest
proportion of teams entered that reached one" are different questions, and a big
club wins the first almost by size alone. `enteredBy` is computed BEFORE the sort,
because a share needs a denominator at comparison time; reading it from a map
built later compares against `undefined`, which sorts every club equal and looks
like a stable order. A club with nothing entered scores −1 rather than dividing by
zero — `NaN` in a comparator does not throw, it returns a nonsense order.
Choosing % turns `finalsWeighted` off: both decide how to compare the same
measure, so leaving both on makes one control silently inert.

**A gold top-grade figure on every measure** (Beta 0.186), replacing the
standalone Top grade column. As one column it could only describe one measure and
said nothing about whether the teams that went deep were the strong ones. Both
numbers in a cell are a share of TEAMS ENTERED — one denominator for the whole
table — so the gold figure is directly comparable with the white one beside it.
The gold Entered count comes from the ENTERED list, not from `e.teams`: a club can
enter a top-grade team that never reaches finals, and taking it from the finals
list undercounts the denominator the whole gold column starts from. A zero prints
nothing rather than a second dash.

**Sort: most teams in top grade** (Beta 0.187). Counts teams ENTERED in the
strongest grade, not teams that reached finals there — the one thing the other
four measures cannot show, since a club can field several top-grade sides and win
nothing. `enteredTop` is attached to the entry before the sort runs, because the
sort reads it through `FINALS_SORTS.topgrade.flat(e)`; computing it twice in two
places is how two figures for one thing start to disagree. It is also set on the
zero rows, or a club that entered top-grade teams and reached no finals compares
as `undefined` and lands wherever the tiebreaks put it. The grade weighting hides
on this measure: weighting ranks a club's finalists BY grade, and this measure is
already one grade.

**Rank column** (Beta 0.182). Standard competition ranking — 1, 2, 2, 4 — so the
gap says how many clubs are ahead. Ties are decided by `primaryCmp`, the measure
the reader picked, NOT by `cmpEntries`, which always separates two clubs on
premierships and then on name; ranking on that would make every number distinct
and the column would be the row index. Alphabetical shows a dash: every pair ties
on the measure there, so a number would read as "everyone is first".

**Sticky column headings** (Beta 0.183–0.185). `top` comes from `--sticky-top`,
which `syncStickyTop()` keeps equal to the page header's BOTTOM EDGE, clamped at
zero, on every frame that scrolls. It is not a constant: `.hdr` is sticky at
`top:0` but its containing block is `body`, `body` is `height:100%`, and a sticky
element cannot leave its containing block — so the header releases after about one
viewport and scrolls away. Reading the rect each frame rather than toggling a
class at a threshold means the headings follow it down continuously instead of
snapping. The throttle flag is raised BEFORE scheduling and cleared by the
callback, never assigned from `requestAnimationFrame`'s return value: with a
synchronous rAF the callback clears the flag first and the assignment sets it back,
after which every later frame is skipped and the offset freezes.

`.main` is `overflow-x:clip`, not `hidden`. `hidden` makes an element a scrollport
that never scrolls, and a sticky descendant then anchors to it and sits still.
**`body` must stay `overflow-x:hidden`** — it is the page's scroll container and
`.hdr` sticks to it. Changing body to `clip` in Beta 0.183 removed that scrollport
and the page header stopped sticking altogether.

---

## 6.9 The box score (Beta 0.233–0.242) — `per_game_stats_design.md`

**Clicking any completed match row opens a modal.** So does a game in a player's
history, and a record card in LEADERS. There is no button — a chip labelled
`BOX SCORE` was tried in 0.233 and removed: a row that opens when you click it
needs no label.

The modal is `#box-modal` at **z-index 500**, against the player panel's 400, so
it opens ON TOP of a player's history and closing it reveals the panel again.
Nothing is hidden and nothing is restored. Its header carries the two teams, the
score, the competition/age/grade/round, the quarter toggle and a PlayHQ link.

⚠️ **CLICK DETAILS RIDE ON `data-*` ATTRIBUTES, NEVER INSIDE THE `onclick`
STRING.** A team name with an apostrophe — Sacred Heart O'Connor, and there are
several — closes the handler's quote and breaks the row silently.

⚠️ **`S.matches` HOLDS THE SELECTED SEASON ONLY.** A history row or an all-time
leaderboard row may name a game from a season that is not loaded, so the modal
takes the teams and score from the caller when it cannot find the record, and
still opens. Where it cannot resolve a season id at all it says the game is
outside what we hold and leaves the PlayHQ link in the header.

### 6.9a What a side shows

- Goalkickers first, `2.1`, then the rest of the side as a name list.
- A gold ★ for a best-player vote. **112 of 257 grades have `bestPlayers.max` of
  0 or null**, so an absent vote column is normal.
- ⚠️ **`2` NOT `2.0` WHERE NO BEHINDS WERE CREDITED.** Only 27% of a team's
  behinds reach a named player; `2.0` asserts none were kicked. A side that does
  record them keeps the `G.B` form, because there the zero is a real zero.
- **A side short of its team's goals says so.** A side with no players while the
  other has them says that too — 1,230 sides in 2026, mostly YJFL, whose goal
  attribution is 67% against 96–98% elsewhere.

### 6.9b Files the browser fetches

| File | When | Size |
|---|---|---|
| `data/seasons/<sid>-lines.json.gz` | first box score opened for that season | ~1 MB |
| `data/player-lines/{xx}/{uuid}.json` | player panel opens | ~200 B |

Both cached for the session. The lines file is read with `DecompressionStream`
behind the same magic-byte check `loadRegistrations()` uses — GitHub Pages may
serve it already inflated.

⚠️ **NEITHER LOADS ON PAGE LOAD.** The player panel renders its games list first
and fills the behinds column when the file lands; blocking would make every panel
open wait for a file most people never look at.

⚠️ **BOTH FILLERS CHECK `_panelUuid` BEFORE PAINTING.** The panel may have moved
to another player or year while a file downloaded, and painting then puts one
player's figures on another's rows.

### 6.9c ⚠️ Never flag a persistent element

The career behinds figure is written into a dedicated `#pm-bhd` span, found or
created, and set every time — including to empty.

Two earlier cuts instead set a dataset key on `#pm-meta` to avoid appending
twice. **That element is reused for every player the panel ever shows**, so the
flag survived the close and every player after the first was skipped: the figure
appeared once and then never again until the page was reloaded.

### 6.9d `hideScores` is not the gate

Games in a `hideScores` grade are stored with an `hs` flag and rendered normally.
PlayHQ hides the score on its own page; our team scores come from the results
engine and are already on the card, so suppressing the box score would conceal
nothing. What actually hides those games is the **Show young age groups (U8–U10)**
switch (§6.10) — a hidden age group has no match row to open.

## 6.10 The young-age-groups switch

`S.showAllAges`, default **false**, a small On/Off button in the admin Manage
tab. It filters `DEFAULT_HIDDEN_AGES` — U8, U9, U10 and their Girls equivalents —
out of the age list and out of the match rows entirely.

⚠️ **IT IS AN AGE FILTER, NOT A `hideScores` FILTER.** The two overlap and are not
the same axis: `hideScores` is a PlayHQ grade setting on 47 of 257 grades. This
switch is ours, and it is the only thing that hides those matches.

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
- `discoverCompetitions` requires `organisationID` — the **8-character code**,
  not the UUID, and it works from a guest session. The earlier note here saying
  UUID, and the 2026-08-10 note saying it fails from a guest session, are both
  retracted. See `docs/playhq_api_reference.md`.
- PlayHQ issues three session cookies (`phq_tier`, `phq_session`, `phq_sub`)
  in a specific order. `lib/playhq.js` handles this.
- `organisation { id }` on `DiscoverTeam` returns the club's 8-character code
  directly — no URL parsing needed. Verified across 60 EFNL organisations
  (2026-08-11) and confirmed working for SER (2026-08-13).
- `discoverFixtureByRound` **RE-SERVES completed rounds in full** — SETTLED
  2026-08-19 by the round-refetch probe (since retired). The earlier note here,
  that it returns 0
  games for a round already fetched, was WRONG. Three rounds probed across two
  competitions: every game returned matched a stored `gameId`, and no stored
  `gameId` was absent from the response.
  **⚠️ The first version of that probe reported the opposite**, because it compared
  the returned count against the STORED count — and stored was inflated by the
  duplicate records the probe existed to investigate. Comparing a measurement
  against the defect it is measuring gives the defect's answer. Compare against
  records carrying a `gameId`.
- Finals round NAMES are "Finals Round 1", "Finals Round 2" — they contain a
  number. `finalsAbbrev` is the game type (QF, EF, GF); `finalsName` is the round
  name. Detecting finals by the absence of a digit is wrong.
- The game type returned by `gameStatistics` carries `id`, `round { name }`,
  `date`, `home` and `away` — and NO `result`. Asking for one fails the whole
  query.

---

## 8a. Two workflow defects that cost a day — FIXED 2026-08-31

Both in `.github/workflows/fetch-results.yml`, and both presented as data
problems. Recorded because every symptom pointed at the fetch logic and none of it
was there.

### Fixtures never ran on a schedule

```bash
[ "$INPUT" = "fixtures" ] && echo "run=true" || echo "run=false"
```

The results and stats jobs both treat `both` as "run me". The fixtures job tested
for `fixtures` alone, and the Cloudflare Worker dispatches `both` — so fixtures had
not run since 2026-08-16 while results ran daily.

**The visible symptom** was a grade whose finals started after that date having no
FR2, PF or GF fixtures at all, while every grade whose finals started earlier had
them. Nothing was wrong with `fetch-fixtures.js`; it had not been run.

### The stats job reverted the fixtures commit

`fetch-stats` and `fetch-fixtures` both had `needs: fetch-results`, so they ran in
PARALLEL. Both check out `main` at the same moment, both load the season file,
both write the WHOLE file back, and both commit. Whichever pushes second holds a
copy loaded before the other's changes and silently reverts them.

Run #335: commit `21de89a` "fixtures" landed, then `49f55ff` "stats" from the same
run landed on top and undid it.

**⚠️ THE JOB REPORTED SUCCESS AND `lastFixtureFetch` UPDATED**, because that is a
key in `core.json` — a different file, which survived while the season file was
reverted. Every cheap signal said the fetch had worked.

`fetch-fixtures` now needs `[fetch-results, fetch-stats]`. `git pull --rebase -X
theirs` does not protect against this and contributes to it: on a conflict it takes
the upstream side and drops the local commit without failing.

**Any new job that calls `store.save` must be serialised behind the others.** The
per-season split shrank the blast radius and hid this for weeks.

## 8b. Quarter scores — where they live, and three wrong answers first

**`discoverGame.statistics.<side>.periods`**, and also on the fixture query, so the
engine carries them at no extra cost (engine v25).

```
statistics {
  home { periods { period { value } statistics { count type { value } } } }
  away { periods { period { value } statistics { count type { value } } } }
}
```

**⚠️ IT IS NOT ON `result.<side>.periods`.** That field EXISTS, is accepted, takes
no arguments, and is ALWAYS EMPTY. Three probes read that emptiness as "PlayHQ does
not expose quarter data" — the wrong conclusion from a real field. It was settled
only by capturing the game-centre page's own request.

**⚠️ ACCEPTED IS NOT POPULATED.** That is the lesson, and it cost four probe
cycles: `result.periods` accepted, `periods(scope:)` rejected the argument,
`periods` bare returned `[]` for a game that has a visible table on the site.

Three traps in the data itself:

**THE ARRAY IS UNORDERED.** One real response returned THIRD, FIRST, FOURTH,
SECOND. Reading it positionally gives a scrambled quarter line. Order comes from
`round.grade.periods`.

**`TOTAL_SCORE` IS NOT ALWAYS PRESENT.** Requiring it discarded whole games over a
single quarter recorded as goals and behinds alone. `6_POINT_SCORE` × 6 +
`1_POINT_SCORE` is exact, from the tenant's own config.

**THE API IS PER-QUARTER; THE SITE SHOWS CUMULATIVE.** `10, 6, 26, 0` sums to the
stored 42; PlayHQ prints `10, 16, 42, 42` because the grade's
`periodScoresDisplayType` is `END_OF_PERIOD`.

**`grade.hasPeriodScores` is NOT a useful filter.** A grade can have it `true` and
every game blank — PlayHQ renders the table and fills it with dashes. Only 56 games
in a full 2026 pass were skipped on that flag.

**Coverage, measured:** roughly two thirds of games that can be asked about carry a
breakdown. The rest were never recorded, which was confirmed against the PlayHQ
page for a game reported as empty.

## 8c. Live scores — the spectator endpoint

`discoverFixtureByRound` returns an EMPTY result block for any game not marked
FINAL, and `discoverGame` says the same. Measured across all 86 live EFNL grades,
46 non-final games, zero scores.

| main API status | score available? |
|---|---|
| `UPCOMING` | no |
| `IN_PROGRESS` | **yes — spectator only**, which calls it `LIVE` |
| `PENDING` | **NO, on any route** |
| `FINAL` | yes, everywhere |

**⚠️ `PENDING` IS THE SURPRISING ONE.** A game that finished hours ago and awaits
confirmation carries no score anywhere. There is nothing to show early for it.

**The spectator endpoint needs NO SESSION COOKIE on the `afl` tenant** — 40 calls,
zero 403s, with only `tenant: afl` and `x-phq-tenant: afl`.

**⚠️ "game could not be found or was not electronically scored" IS AN ANSWER, NOT
AN ERROR.** It arrives for the majority of games. Counting it as a GraphQL error
made a clean run report `graphqlError=44`, which is the sort of figure that gets
ignored and then hides a real one.

## 8d. `lib/playhq.js` — two retry defects, fixed 2026-09-04

**A 400 was retried four times.** A GraphQL validation error is never transient.
Probing eleven candidate field names cost 36 requests instead of 11, and that burst
is the most likely reason the WAF then refused every session attempt on the next
run. It now returns the body — which carries the "Did you mean…?" suggestion, the
whole point of probing a field that way.

**`acquireSession` did not recognise a WAF block.** It retried on a 2–15 second
ramp whatever the cause, so ten attempts fitted inside about 90 seconds — barely
one CloudFront window — and each attempt extended the block it was waiting out. It
now detects the HTML 403 and waits the full 80 seconds.

## 8e. PlayHQ's rate limit — MEASURED 2026-09-05

Three consistent rounds with `scripts/probe-waf-window.js`:

| | |
|---|---|
| calls before a block | **108–150** `discoverGame` |
| recovery | **76, 76, 77 seconds** |

So `lib/playhq.js`'s flat 80-second sleep is CORRECT. It was inherited from a
comment and had never been measured; it now has been.

**⚠️ THE LIMIT IS A CALL BUDGET, NOT A CONCURRENCY LIMIT.** About 1.5 requests per
second, and that is the ceiling however the requests are arranged. Dropping
concurrency from 6 to 1 did not avoid blocks — it reached the same budget more
slowly while doing less work between them. An adaptive concurrency scheme was
built, measured, and removed for exactly this reason.

**⚠️ IT APPEARS TO BE PER-OPERATION.** 60 concurrent `discoverGrade` calls did not
trip it at all, while `discoverGame` blocked after ~120. Every one of the 122
blocks in the 2026-09-05 walk named `DiscoverGame`.

`enrich-games.js` now paces with a token bucket at 100 calls per 80 seconds, just
under the measured limit, which delivers the same throughput without the blocks.

## 8f. Quarter-score coverage — measured 2026-09-05

Across 52,659 completed records:

| | | |
|---|---|---|
| with quarter scores | 34,575 | 65.7% |
| ...with goals and behinds | 31,597 | 60.0% |
| ...partial, some quarters blank | 1,366 | |
| ...a quarter calculated | 2,667 | |
| ...do not sum to the score | 224 | |
| asked, PlayHQ had nothing | 17,300 | 32.9% |
| no `gameId`, cannot be asked | 779 | |

**The remaining third was never recorded**, confirmed against the PlayHQ page for a
game reported as empty: the site renders a Period Scores table full of dashes. Not
a gap in the fetch.

## 8g. Per-game player lines — `gameView`, built 2026-09-11/12

**One `discoverGame` call per completed game** returns every player on both
sides. Same operation as the quarter scores. Full detail in
`docs/playhq_api_reference.md` §11a and `docs/per_game_stats_design.md`.

**Stored** as `data/seasons/<sid>-lines.json.gz`, dictionary-encoded:
`players: [[uuid, name], …]` and a line of `[playerIndex, goals, behinds, votes]`.
MEASURED at **281 B/game gzipped**, against 923 for a full uuid on every line.
A fill-in or anonymous player has a name and a **null uuid** — 1.2% of lines.

**Derived** into `data/player-lines/{xx}/{uuid}.json`, ~200 bytes per player, by
`build-player-lines.js`. ⚠️ A SEPARATE TREE from `data/players/`, which
`fetch-career-stats.js` writes whole — a derived field there would be erased on
its next sweep.

⚠️ **`bRec` IS BEHINDS *RECORDED*.** 27% of a team's behinds reach a named player
and there is no age at which that improves. Only 16,474 of 48,687 players have
any, which is why the figure is omitted rather than shown as zero.

⚠️ **NEGATIVES ARE STAMPED AND EVERY ONE EXPIRES.** "No player block" stands for
a day in a live season and for good in a retired one: a scoresheet entered on the
Monday after the game is the normal case, not the exception. An earlier cut also
stamped `hideScores` permanently and discarded the response — 2,700 of 2,708 such
games carried full lines.

**Maintenance:** the `fetch-lines` job in `fetch-results.yml` runs on the
All-competition dispatches (Sat 11pm, Sun 11pm, Mon 3am, Mon 12pm AEST);
`build-player-lines` runs on the Monday dispatch only.

⚠️ **RATE: 100 CALLS PER 80 s, AND THE BUCKET IS THE POINT.** An earlier cut had
adaptive concurrency and no rate cap, reached 260 req/min and blocked sixteen
times in a row. Stepping concurrency down does not help — the limit is a rate.

## 8h. Venues — where they come from

Nothing discovers venues. There is no registry, no venue file and no job that
looks for new ones.

`lib/results-engine.js` selects them **inside the round query**, alongside the
fixtures and results:

```
allocation { court { venue { name suburb state latitude longitude } } }
```

So a ground appears on a match the first time that round is fetched, which means
**whenever `fetch-results` runs** — the Worker's sixteen weekend dispatches. The
round is re-served on every later fetch, so a ground allocated late is filled in
by the next pass without anything special happening.

Stored on the match record as `venue`, `vSuburb` and `venueUrl`. The state is
selected and not stored.

⚠️ **`venueUrl` IS DERIVED, NOT FETCHED.** The engine builds
`https://maps.google.com/?q=<lat>,<lng>` and only when BOTH coordinates are
present. A ground with a name and no coordinates yields a name and an empty URL —
which is why the By Venue view (§6.6) takes its link from the first record at that
ground that has one, rather than from the record it is drawing.

## 9. Known defects and limitations

### 9.0 A result merged into a fixture kept the `scheduled` flag — FIXED 2026-08-16

Engine v18 and Beta 0.175. Two defects, discovered together because they produced
one symptom: no finals results beyond the first finals round, and no fixtures
anywhere on the page.

**The storage half.** `fetch-fixtures.js` writes a scheduled record under the same
match id `results-engine.js` builds, so a played game merges into it at
`{ ...prev, ...m }`. A result record has no `scheduled` key, so nothing overwrote
`prev.scheduled` and `true` survived. `index.html` splits on exactly that flag —
`S.matches` excludes anything scheduled — so the record never reached the results
list, and `isPlayed()` (`!m.scheduled && …`) made the finals view draw it as an
unplayed fixture with blank scores.

**Why it never self-corrected, and why the log looked clean.** The scores were
merged in on the first run after the game. Every run after that found
`prev[k] === m[k]`, reported `0 new, 0 updated`, and skipped the commit. A run
carrying an unrepairable defect and a run with genuinely nothing to do printed the
same thing. The fix counts the promotion as an update so the run commits.

**The rendering half.** `renderFixtures` joined the grade filter on `rawGrade`
against a Set of grade IDs — §6.2c.

**Measured, not inferred.** EFNL 2026 Veterans: four Semi Finals records with
hScore 59, 33, 86 and 68, all flagged `scheduled`. After the fix they carry no
flag and no `hLogo`/`aLogo`, the second being the confirmation — the logo
harvest-and-strip loop returns early on scheduled records, so the URLs could only
have been stripped by a pass that already saw them as results.

**Scope, measured 2026-08-16 by `repair-scheduled-results.js`:** 84 scheduled
records across all eighteen seasons, none carrying a score. The contamination was
finals-only; home-and-away results were never affected.

### 9.1 `lastRound` and `gotwFlags` keying — FIXED 2026-08-13

Recorded here until Beta 0.165 as a single defect: both keyed `age|rawGrade`,
colliding when two competitions share an age and grade name, fixable only with a
data migration. **All three parts of that were wrong.** There were two unrelated
defects, they had different shapes, and neither needed a migration.

`lastRound` was never colliding — it was never read at all. The writer built
`age|rawGrade` (two segments, a parsed grade name); the reader built
`compName|age|gradeId` (three segments, a PlayHQ UUID). They could never match,
so the round number on each ladder grade tab rendered as an empty string from
Beta 0.133 until 0.165. The reader was moved to the grade-id key during the grade
identity migration and the writer was not: `migrate-grade-ids.js` recorded the
re-keying as deferred to build-order step 6, and step 6 was done on the page side
only. No migration was needed because `lastRound` is rebuilt from scratch on
every full run.

`gotwFlags` was keyed `age|roundKey` — no competition, no season, and no grade —
so any two competitions sharing an age group collided on every round, and so did
one competition across two seasons. The symptom would have been an
administrator's pick silently disappearing, not a wrong game on screen:
`getGOTWMatch()` checks the flagged id is in the current round and falls through
to the automatic pick. No migration was needed because `core.json` held
`gotwFlags: {}` and `localStorage` held no key containing `gotw` — no pick had
ever been made.

Both keys now carry the competition, and `compName` carries the season with it.
Design and evidence: `docs/lastround_gotw_keying_design.md`.

### 9.2 Concurrent competitions (SEJ 2026 U10) — LARGELY RESOLVED 2026-08-13

Recorded as "two leagues in one age group, needs a design decision". Measurement
found something wider: SEJ 2026 U10 is one instance of a pattern across three
organisations and seven seasons — a short-form competition inside a normal season
whose grades are told apart by a venue, session, pool, zone or parallel league,
all of which `parseGradeName` discards. `report-grade-collisions.js` measured 62
colliding keys and 121 shadowed grades.

Resolved by `grade_attribution_split_design.md`: grading grades get their own tab
and ladder; everything else is listed by `m.gradeId` and counts only when both
sides agree.

**Still open:** a short-form competition NOT named "grading" — SEJ's Lightning
Premiership, WFNL's Lightning Cups, YJFL's pools — takes the fallback and its
games are listed but count nowhere. Accepted deliberately rather than built
around; see §2.3 of that design.

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
| `docs/lastround_gotw_keying_design.md` | lastRound / gotwFlags keying (built 2026-08-13) |
| `docs/unplayed_round_blocker_design.md` | Placeholder rounds stopping the fetch (built 2026-08-13) |
| `docs/grade_attribution_split_design.md` | Grade attribution, grading grades (BUILT 2026-08-13) |
| `docs/OUTSTANDING_TASKS.md` | Actions, questions, and decisions needed |
| `docs/offseason_mode_design.md` | Off-season mode — decisions 2026-09-04, BUILT 2026-09-07 |
| `docs/offseason_build_brief.md` | Self-contained build brief for off-season mode (built) |
| `docs/per_game_stats_design.md` | The match box score — BUILT 2026-09-11/12 |
