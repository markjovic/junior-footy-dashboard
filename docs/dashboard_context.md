<!-- docs/dashboard_context.md -->
# Dashboard Context — Local Footy Dashboard

<!-- Repo-specific. Do NOT copy into another project — several rules here are -->
<!-- the OPPOSITE of the sports-players-stats conventions. -->
<!-- Revision: 2026-08-11 -->

Read alongside `working_practice.md` (portable) and `playhq_api_reference.md`
(PlayHQ behaviour). This file covers only what is true of **this** repository.

Two design documents lead the work queue: `storage_ingestion_design.md`
(approved, partly built) and `team_registry_design.md` (approved, not started).

---

## Reading the repo

Claude can fetch any file here, but only from a URL already present in the
conversation — a constructed URL is refused, folder pages are robots-blocked,
and `raw.githubusercontent` is refused. **The GitHub blob view truncates at
1,000 lines**, so anything longer must be uploaded rather than fetched.

```
https://github.com/markjovic/junior-footy-dashboard/blob/main/README.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/dashboard_context.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/working_practice.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/playhq_api_reference.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/storage_ingestion_design.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/team_registry_design.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/finals_support.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/OUTSTANDING_TASKS.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/project_setup.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/index.html
https://github.com/markjovic/junior-footy-dashboard/blob/main/org-discovery.html
https://github.com/markjovic/junior-footy-dashboard/blob/main/config.json
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/lib/playhq.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/lib/store.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-results.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-stats.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-fixtures.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/build-club-index.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/discover-seasons.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/discover-orgs.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/split-data.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/workers/footy-cron.js
```

---

## What this is

**Repo:** `markjovic/junior-footy-dashboard` (public)
**Live:** `https://markjovic.github.io/junior-footy-dashboard/`
**Version:** read the badge in `index.html`. It was Beta 0.132 on 2026-08-11;
check rather than quote. `org-discovery.html` is versioned **separately** — Beta
0.3 — and has nothing to do with the dashboard badge.

A single-file HTML dashboard for AFL results, fetched from PlayHQ and served
from GitHub Pages. No build step, no framework, no server.

Five competitions currently fetched: EFNL, WFNL, SEJ, SER, YJFL. **EFNL is the
only `vip: true` competition**, which matters more than it looks — see the
merge-per-competition rule below.

---

## ⚠️ Storage layout changed on 2026-08-11

**`data/data.json` is no longer written and no longer read.** It is left in place
as a rollback path and should be deleted once the split layout is trusted.

```
data/
  core.json                     manifest + cross-organisation keys (~450 KB)
  orgs/
    <orgCode>-current.json      live seasons for one organisation
    <orgCode>-archive.json      retired seasons for one organisation
  grades.json                   current-season grade cache
  org-discovery.json            all 1,175 AFL associations (2.13 MB)
```

As at 2026-08-11: five organisation files, 25.88 MB total, largest 9.88 MB
(EFNL) — a tenth of GitHub's 100 MB per-file limit.

**Every writer goes through `scripts/lib/store.js`.** `store.load(scope)` returns
the shape `data.json` had, so writer logic is unchanged; `store.save(data, scope)`
distributes it back. **A scoped save rewrites only the organisation files in
scope**, which is what makes a VIP-only run safe by construction.

`core.json` holds the keys that cannot be split, each for a stated reason:
`clubs`, `teamClub`, `teamOrg`, `compLogos`, `teamLogos`, `gotwFlags`,
`lastRound`, plus the `manifest` and an `orgFiles` index of which files exist.

**A season retires 30 days after it completes** — status `COMPLETED` *and*
`endDate` + 30 days in the past. Its records then move from `-current` to
`-archive` on the next run. **This path has never executed against real data.**
Force a dry run before November rather than discovering it in the off-season.

---

## Ownership — which script writes what

Never cross-write. Two writers disagreeing about a record's key silently produce
duplicates.

| Writer | Owns |
|---|---|
| `fetch-results.js` | `matches` (played), `roster`, `gradeMeta`, `lastRound`, `teamLogos`, `teamOrg`, `compLogos`, `grades.json` |
| `fetch-fixtures.js` | `matches` where `scheduled: true` — purges and rewrites them, scoped to the competitions it covers |
| `fetch-stats.js` | `players` |
| `build-club-index.js` | `clubs`, `teamClub`, `clubs.json` — writes via `store.saveCore()` only |
| `discover-seasons.js` | `manifest`, `organisations` in `core.json` |
| `discover-orgs.js` | `data/org-discovery.json` |
| `split-data.js` | one-time migration; writes `data/orgs/*` and merges core keys |

---

## ⚠️ THE RULE THIS REPO KEEPS BREAKING

**Anything derived from a filtered grade list must merge per competition rather
than replace.** EFNL is the only VIP competition, so a VIP-only run covers one
competition and any wholesale assignment deletes the other four.

This has been fixed **four separate times**, in four writers:

| Writer | What it wiped | Fixed |
|---|---|---|
| `fetch-results.js` | `grades.json`, `gradeMeta` | earlier |
| `fetch-stats.js` | `players` | 2026-08-11 |
| `fetch-fixtures.js` | scheduled records | 2026-08-11 |
| `build-club-index.js` | `teamClub` on a full run | guarded 2026-08-11 |

`store.save(data, scope)` now makes it structural: a scoped save never opens the
other organisations' files. **Any new writer must use a scope.**

---

## ⚠️ Before removing or renaming ANY stored field

**Run `scripts/report-field-usage.js` first.** It scans every writer,
`index.html` and `org-discovery.html`, and reports which files reference each
field.

On 2026-08-11 `hLogo`/`aLogo` were removed from match records after confirming
`index.html` rendered crests from `teamLogos`. That check was correct and the
conclusion was still wrong: `build-club-index.js` derived every club identity by
scanning those fields, and the next full run would have replaced `teamClub` with
an empty object. The dependency was documented in three places and still missed,
because the check was aimed at one consumer instead of all of them.

Fields touched by more than one writer, from that scan: `matches`, `roster`,
`gotwFlags`, `teamOrg`, `clubs`, `home`/`away`, `age`/`compName`,
`isBye`/`isPartial`/`provisional`, `venue`/`vSuburb`/`venueUrl`, `seasonID`.

The tool's own blind spot is the `SOURCES` and `FIELDS` lists at the top of it —
a file or field missing from those is invisible. Update them when either changes.

---

## Conventions specific to this repo

These differ from `sports-players-stats`.

- **`actions/setup-node` IS used here** (v4, node 20; node 22 for fixtures) and
  works fine against `api.playhq.com`. The "never use setup-node" rule is a
  basketball-repo rule and does not apply.
- **Git pattern:** `git add -A data/` → `git diff --staged --quiet || git commit`
  → `git pull --rebase -X theirs` → `git push`. **Do not name root-level
  `data.json`, `grades.json` or `clubs.json` in the pathspec** — they were moved
  into `data/` and `git add` fails with exit 128 on an unmatched pathspec. That
  broke a run on 2026-08-11.
- **Organisation files are written MINIFIED**, `JSON.stringify(payload)`.
  `core.json` and `grades.json` are pretty-printed with `null, 2`. All writers
  must agree or the next run re-inflates and produces a whole-file diff.
- **Exit codes:** `0` = changed, commit. `2` = no change, skip commit. `1` =
  fatal. All four writers follow this; `fetch-fixtures.js` only since 2026-08-11.
  The older workflows treat exit 1 as green with no commit; newer ones fail.
- **Session and transport live in `scripts/lib/playhq.js`.** All three cookies in
  the order `phq_tier; phq_session; phq_sub`, ten attempts, refresh on age and on
  403, and typed failures. Never write a local `getSession()` again.

---

## Standing traps

- **`FINAL` already means "completed game"** (`status.value === 'FINAL'`). Never
  name a finals-related field `isFinal`.
- **Finals rounds restart numbering at 1.** Order by position in `roundList`, or
  by the two-key sort `(isFinals, round)`.
- **`cleanTeam` strips the grade's age from team names**, so
  `"Norwood U12 Purple"` and `"Norwood U14 Purple"` both become
  `"Norwood Purple"`. Any key built from a team name must include age.
- **Never derive a club from a team name.** Use `teamClub`, or `teamOrg` which
  `fetch-results.js` captures at fetch time from the logo URL.
- **`organisation` on a team IS the club — verified 2026-08-11.** One EFNL season
  returns 60 distinct organisations; the league would be one. The id is the
  8-character form.
- **`compName` is half of every stored key.** Match ids are
  `compName|age|rawGrade|roundToken|teams`, and `roster` and `gradeMeta` keys
  start with it. Change how it is composed and every stored record is orphaned.
  It is derived as `config.name + " " + season.name`.
- **`excludeGrades` shifts grade ranks.** Empty in all five competitions.
- **`S.selRound` holds a round *key*, not a number.** Use `ladderCutoff()`.
- **The dashboard is scoped to one `S.selectedAge` and one `S.selComp`.**
- **Provisional records must never reach** `rebuildRoster`, `allTeamsForAge`,
  `teamLogos`, the team dropdown, or the ladder.
- **`hLogo`/`aLogo` survive only on `provisional` records** (69 of 13,181).
  Everything else renders crests from `teamLogos`.

---

## Known broken, not fixed

- **`parseGradeName` collapses 17 grades into 5 keys.** Confirmed live
  2026-08-11 by `buildGradeMeta`'s collision warnings: EFNL U8 four grades, YJFL
  U10 six, WFNL U10 three, SEJ U10 Blue two, SEJ U10 Red two. It also produces
  six roster warnings of the form `X (U10 Girls) in both grade  and A in R1`,
  so `currentGrade()` can return a grade a team is not in. `rawGrade` is part of
  every match id, so fixing it needs a migration. See `team_registry_design.md`.
- **`logoKey()` colour stripping does not work.**
  `new RegExp('\s+' + c + '\s*$')` uses a plain string, so `\s` collapses to a
  literal `s`. Masked because `teamLogos` usually hits on the full name.
- **`lastRound` and `gotwFlags` keys omit the competition.** `lastRound` is
  `age|rawGrade`, `gotwFlags` is `age|roundKey`. Both collide across
  competitions. Moving them into the per-organisation files fixes it by
  construction; they are currently still in `core.json`.
- **Session acquisition takes three attempts on every run**, with two 403s
  first. Present before 2026-08-11 but invisible, because the old `getSession()`
  logged nothing unless all attempts failed. `playhq.js` now classifies the
  failure as CloudFront or application; the cause is not yet established.

---

## Current state — 2026-08-11

**Done this session.** Shared session and transport layer across all four
writers. Per-match logo URLs removed (−3.82 MB) with club identity captured at
fetch time into `teamOrg`. Unread player fields removed (−6.62 MB). `data.json`
went 36.57 MB → 26.24 MB before the split. Organisation discovery
(`discover-orgs.js` + `org-discovery.html`), season discovery
(`discover-seasons.js`), the one-time split (`split-data.js`), and the cutover
to the per-organisation layout with `index.html` at Beta 0.132.

**`config.json`** carries the original `competitions[]` plus an
`organisationCodes[]` array of 17 codes. It has **not** been migrated to the
`organisations[]` shape — the writers still read `competitions`. Migrating needs
the twelve new organisations' short names decided first, because each becomes
half of every match id under that competition.

**Manifest:** 17 organisations, 65 seasons, 17 live and 48 retired. Only 13
seasons carry a resolved `compName` — the five proven against existing config.
The other twelve organisations have `compName: null` until their names are
chosen.

**Next:** Phase A backfill — results and ladders for the five current
organisations across their retired seasons. It needs no naming decision and it
exercises the archive path, which is the untested half of the new layout.

---

## Infrastructure

| Thing | Where |
|---|---|
| Scheduling | Cloudflare Worker `footy-cron.insanoflash.workers.dev` — dispatches `workflow_dispatch` at AEST times. GitHub cron is not used. |
| Player panel proxy | Cloudflare Worker `solitary-snowflake-cb3e.insanoflash.workers.dev` — CORS bypass for `publicProfileStatistics` |
| Hosting | GitHub Pages, main branch, root |
| Tenant | `afl` (basketball uses `basketball-victoria`) |

**Workflows.** `fetch-results.yml` holds three jobs — results, stats, fixtures —
gated by a `fetch` input whose value `both` means results **and stats only**, not
fixtures. Separate workflows: `discover-orgs.yml`, `discover-seasons.yml`,
`split-data.yml`, `report-data-size.yml`, `report-field-usage.yml`,
`probe-search.yml`.
