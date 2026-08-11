<!-- docs/dashboard_context.md -->
# Dashboard Context — Local Footy Dashboard

<!-- Repo-specific. Do NOT copy into another project — several rules here are -->
<!-- the OPPOSITE of the sports-players-stats conventions. -->
<!-- Revision: 2026-08-10 -->

Read alongside `working_practice.md` (portable) and `playhq_api_reference.md`
(PlayHQ behaviour). This file covers only what is true of **this** repository.

---

## Reading the repo

Claude can fetch any file here, but only from a URL already present in the
conversation — a constructed URL is refused, and folder pages are robots-blocked
so `docs/` cannot be browsed. Paste this block to unlock every file:

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
https://github.com/markjovic/junior-footy-dashboard/blob/main/workers/footy-cron.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/config.json
```

---

## What this is

**Repo:** `markjovic/junior-footy-dashboard` (public)
**Live:** `https://markjovic.github.io/junior-footy-dashboard/`
**Current version:** Beta 0.124

A single-file HTML dashboard for AFL results, fetched from PlayHQ into a
committed `data.json` and served from GitHub Pages. No build step, no framework,
no server. `index.html` contains all HTML, CSS and JavaScript.

Five competitions in 2026: EFNL, WFNL, SEJ, SER, YJFL. **EFNL is the only
`vip: true` competition**, which matters more than it looks — a VIP-only run
discovers only EFNL's grades, so anything derived from the grade list must merge
per competition rather than replace.

---

## Ownership — which script writes what

| Writer | Owns |
|---|---|
| `fetch-results.js` | `matches` (played), `roster`, `gradeMeta`, `lastRound`, `teamLogos`, `compLogos`, `grades.json` |
| `fetch-fixtures.js` | `matches` where `scheduled: true` — purges and rewrites them every run |
| `fetch-stats.js` | `players` |
| `build-club-index.js` | `clubs`, `teamClub`, `clubs.json` |

Never cross-write. Two writers disagreeing about a record's key silently produce
duplicates.

---

## Conventions specific to this repo

These differ from `sports-players-stats`. Applying that repo's rules here creates
two conventions in one codebase.

- **`actions/setup-node` IS used here** (v4, node 20; node 22 for fixtures) and
  works fine against `api.playhq.com`. The "never use setup-node" rule is a
  basketball-repo rule and does not apply.
- **Git pattern is:** `git add <explicit paths>` →
  `git diff --staged --quiet || git commit -m "<what>: $(date +'%A %-d %B %Y') (run #N)"` →
  `git pull --rebase -X theirs` → `git push`. No retry loop, no `--shortstat`.
  Rebase is used here.
- **`data.json` is pretty-printed** with `JSON.stringify(x, null, 2)`. The
  minified-player-file rule is basketball's.
- **Exit codes:** `0` = changed, commit. `2` = no changes, skip commit. `1` =
  fatal. The workflow captures the code with `set +e` and commits only on `0` —
  which means a fatal error currently shows as a green run with no commit.
- **The repo is small.** `git add -A` is not the hazard it is in the basketball
  repo, though explicit paths are still used.

---

## Standing traps

- **`FINAL` already means "completed game"** (`status.value === 'FINAL'`). Never
  name a finals-related field `isFinal`.
- **Finals rounds restart numbering at 1.** Any code comparing round numbers
  across the home-and-away/finals boundary is wrong. Order by position in
  `roundList`, or by the two-key sort `(isFinals, round)`.
- **`cleanTeam` strips the grade's age from team names**, deliberately, for
  display. It means `"Norwood U12 Purple"` and `"Norwood U14 Purple"` both become
  `"Norwood Purple"`. Any key built from a team name must include age.
- **Never derive a club from a team name.** `"Norwood Gold/Heathmont"` is a
  merged team; Templestowe fields separate senior and junior organisations.
  Use `teamClub`.
- **The club field on a team is `organisation`, not `club`.** A probe asked for
  `club { id name }` on `DiscoverTeam`, got a validation error, and the club
  index was built on logo-URL derivation instead. `club` exists only on
  `publicProfileStatistics`. Whether `organisation` on a team returns the club or
  the league is unverified — see "Next up" below.
- **`excludeGrades` shifts grade ranks.** Excluded grades are filtered before
  discovery and do not consume a rank slot. Empty in all five competitions —
  keep it that way unless the consequence is accepted.
- **`S.selRound` holds a round *key*, not a number.** `parseInt('F:GF')` is
  `NaN`, and every `<=` against `NaN` is false. Use `ladderCutoff()`.
- **The dashboard is scoped to one `S.selectedAge`.** `computeLadder`,
  `getGOTWMatch`, `getTopScorers` and `renderResults` all assume it. Anything
  cross-age needs its own view, not an "All ages" option.
- **`parseGradeName` collapses 17 grades into 5 keys** across EFNL U8, YJFL U10,
  WFNL U10 and SEJ U10. That key is the match id prefix, so those grades share an
  id namespace and can overwrite each other. All U8/U10, hidden by default. See
  `OUTSTANDING_TASKS.md` item 6 — do not patch it without a migration, because
  changing the function changes every match id.
- **Provisional records must never reach** `rebuildRoster`, `allTeamsForAge`,
  `teamLogos`, the team dropdown, or the ladder. `S.matches` excludes scheduled
  records, which is what keeps them out.

---

## Known broken, not fixed

- **`lastRound` is dead in the dashboard.** It reads
  `S.lastRound["comp|age|grade"]`; `fetch-results.js` writes `"age|grade"` with
  no competition prefix. The round label on the ladder grade tabs has never
  rendered.
- **`logoKey()` colour stripping does not work.**
  `new RegExp('\s+' + c + '\s*$')` uses a plain string, so `\s` collapses to a
  literal `s`. Unnoticed because `teamLogos` usually hits on the full name.
- **Team identity is derived from a cleaned display name, not the PlayHQ team
  `id`** — which both fetchers request and discard. Root cause of the club-name
  heuristics in `fetch-stats.js`. Deferred to the multi-season work.
- **A fatal script error does not fail the workflow run** (see exit codes above).

---

## Current state

Finals support is complete and deployed — see `finals_support.md` for the
implementation, and `README.md` for user-facing behaviour.

**Repo state.** 30 files, 37.8 MB as at 2026-08-10 — down from 163 files and
65 MB. `data/data.json` is 36.6 MB of it. Machine-written JSON lives in `data/`,
documentation in `docs/`, the Cloudflare Worker in `workers/`. The fixture generator's leftover club images
were removed (~10.7 MB), along with the superseded `extract-finals-data` script.
`2024.html` and `fetch-u10-2024.js` went in the same pass and should be restored
from git history when multi-season work begins.

**Open lead worth an hour: does `DiscoverTeam.organisation` return the club?**
The API reference documents `organisation { id name }` on `DiscoverTeam`. If it
is the club, both fetchers can capture the club id at fetch time and
`build-club-index.js` becomes unnecessary — it would also cover any team with no
logo. Verify before building anything on it; on `discoverCompetitions` the
equivalent field is the league, not the club.

**`data.json` is written with `JSON.stringify(merged, null, 2)`.** Minifying
reduced a 53 MB file to 36.6 MB — 31% on the real data. Applied 2026-08-10
across all four writers; all must agree or the next run re-inflates it.

**Next up: multi-season support.** The groundwork established so far:

- `discoverCompetitions(organisationID)` returns every season an organisation
  has played, with `id`, `name`, `startDate`, `endDate` and `status` — which
  removes the need to hand-maintain `seasonID` in `config.json`. One call per
  organisation. A probe attempt returned "There was an error, please try again
  later", most likely rate limiting rather than a wrong query, since the same
  call works from a browser.
- Exactly one season per year per organisation, which the `startDate`/`endDate`
  pair confirms.
- **Organisation ids appear stable across seasons; team ids appear
  season-scoped.** This needs verifying before anything is built on it — query
  `discoverTeams` for a club against the 2025 season and check whether any team
  id matches 2026.
- The identity question is the same question: what identifies a team across
  years. Re-keying match ids would touch every record plus `gotwFlags`, `roster`
  and `teamLogos`, so it should be decided once, in a design document, not
  incrementally.

---

## Infrastructure

| Thing | Where |
|---|---|
| Scheduling | Cloudflare Worker `footy-cron.insanoflash.workers.dev` — dispatches `workflow_dispatch` at AEST times. GitHub cron is not used. |
| Player panel proxy | Cloudflare Worker `solitary-snowflake-cb3e.insanoflash.workers.dev` — CORS bypass for `publicProfileStatistics` |
| Hosting | GitHub Pages, main branch, root |
| Tenant | `afl` (basketball uses `basketball-victoria`) |
