# Local Footy Dashboard — Beta 0.124

A single-file HTML dashboard for AFL football results, automatically fetched from PlayHQ. Renders a live ladder, results, top scorers, Game of the Week, finals progress, and player profiles across all age groups and grades for multiple competitions simultaneously.

**Live URL:** `https://markjovic.github.io/junior-footy-dashboard/`

---

## Repo structure

```
index.html                  ← Single-file dashboard PWA (all HTML/CSS/JS)
data.json                   ← Match data, player stats, logos, club index (auto-committed)
grades.json                 ← Grade cache (auto-populated by fetch workflow)
clubs.json                  ← Club id → name cache (auto-populated by club index workflow)
config.json                 ← Competition config (season IDs, VIP flag, grade exclusions)
manifest.json               ← PWA manifest (home screen install)
sw.js                       ← Service worker (offline support, cache-first shell)
favicon.ico                 ← Browser tab icon
README.md
.github/
  workflows/
    fetch-results.yml       ← workflow_dispatch only (scheduling via Cloudflare Worker)
    build-club-index.yml    ← Manual — rebuilds the club index
    probe-finals-rounds.yml ← Manual, read-only diagnostic
    probe-team-club.yml     ← Manual, read-only diagnostic
    probe-club-index.yml    ← Manual, read-only diagnostic
scripts/
  fetch-results.js          ← Match results + grade metadata from PlayHQ
  fetch-stats.js            ← Player statistics from PlayHQ
  fetch-fixtures.js         ← Future scheduled fixtures from PlayHQ
  build-club-index.js       ← Resolves teams to PlayHQ clubs
  probe-finals-rounds.js    ← Diagnostic: round structure and numbering
  probe-team-club.js        ← Diagnostic: whether DiscoverTeam exposes a club
  probe-club-index.js       ← Diagnostic: validates the club id derivation
  migrate-grades.js         ← One-off migration for grade name/compName remapping
  fetch-u10-2024.js         ← Standalone one-off script for U10 2024 historical data
assets/
  icons/
    icon-192.png            ← PWA home screen icon (192×192)
    icon-512.png            ← PWA home screen icon (512×512)
```

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

## data.json contents

| Key | Shape | Written by |
|-----|-------|------------|
| `matches` | match records, including bye/partial sentinels and scheduled fixtures | fetch-results, fetch-fixtures |
| `players` | player records keyed `uuid\|age\|compName` | fetch-stats |
| `roster` | `"comp\|team\|age"` → current grade | fetch-results |
| `gradeMeta` | `"comp\|age\|grade"` → `{r, lvl, g}` — rank, level, gender | fetch-results |
| `clubs` | `clubId` → `{name, type}` | build-club-index |
| `teamClub` | `"comp\|team\|age"` → `clubId` | build-club-index |
| `lastRound`, `teamLogos`, `compLogos`, `gotwFlags` | lookup maps | fetch-results |

---

## How data updates work

Three fetch scripts plus a club indexer. All can be triggered from the Admin panel.

### fetch-results.js
Fetches match fixtures and results. Each run:
1. Calls `gradeListDiscoverSeason` to discover all grades for configured competitions
2. For each grade, fetches only rounds not yet stored (skips known rounds, re-checks highest known round every run)
3. Tracks home-and-away and finals rounds as **two independent sequences** — see [Finals](#finals)
4. Partial rounds (some games not yet final) are flagged and re-fetched next run
5. Partial rounds with a later complete round are promoted to complete (forfeit/error)
6. Grades starting mid-season get implied bye sentinels for missing early rounds
7. Emits `gradeMeta` — grade strength rank, junior/senior level, and gender
8. Merges new results into `data.json` and commits

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
Resolves every team to its PlayHQ club and writes `clubs` and `teamClub` into `data.json`. Run it after a new season's first results, or when new teams appear. Resolved clubs are cached in `clubs.json` and never re-fetched.

---

## Scheduling

Scheduling is handled by a **Cloudflare Worker** (`footy-cron.insanoflash.workers.dev`) which dispatches the GitHub Actions workflow at the correct AEST times. GitHub Actions scheduled crons are not used (unreliable on free plans).

### Cloudflare cron triggers (UTC)
```
10 4,7,10,13 * * 7                      Saturday
10 1,2,3,4,5,6,7,10,13,17,23 * * 1      Sunday
10 2 * * 2                               Monday
```

### Effective AEST schedule

| Time (AEST) | Results | Stats | Comps |
|-------------|---------|-------|-------|
| Sat 2pm/5pm/8pm | ✓ | — | VIP only |
| Sat 11pm | ✓ | ✓ | All |
| Sun 11am–4pm hourly | ✓ | — | VIP only |
| Sun 5pm | ✓ | ✓ | All |
| Sun 8pm | ✓ | — | VIP only |
| Sun 11pm | ✓ | ✓ | All |
| Mon 3am | ✓ | — | All |
| Mon 9am | ✓ | — | VIP only |
| Mon 12pm | ✓ | ✓ | All |

Stats run alongside results at the 11pm/5pm/12pm slots (fetch=both dispatch).

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

**By club** — one block per PlayHQ club, listing every team it has in finals across all ages, each tagged with age, grade, and grade rank (`TOP` in gold, otherwise `2/4`).

**Filters:** gender (male / female / both, default both) and level (junior / senior / both, default both). Both apply to every statistic including the headline totals.

**Sorting:** alphabetical (default), grade strength, most teams, most remaining, most GF appearances, most premierships.

**Grade strength** compares tier by tier — two top-grade finalists rank above ten second-grade ones. It is deliberately not a weighted score.

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

PlayHQ has a first-class club but does not expose it on `DiscoverTeam`. Club identity is recovered from the Cloudinary logo URL, whose first eight hex characters are the organisation code:

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
- Season summary: GP, goals, goals/game, best player awards (full-width 4-column strip)
- Game-by-game breakdown fetched live from PlayHQ via Cloudflare Worker proxy
- Columns: Round, Home, Away, Grade (abbreviated), Comp (logo), G, BP
- Player's team shown in gold + bold

The live game data is fetched from `publicProfileStatistics` via `solitary-snowflake-cb3e.insanoflash.workers.dev`.

---

## Player search

Sidebar includes a live search field. Type 2+ characters to match player names. Results show team crest, name, age group, grade, and goals. Click to open the player panel.

---

## Team drilldown

Click any team name (ladder, results, GOTW, scorers, player panel header) to open a modal showing:
- Season stats strip (Played/Won/Drawn/Lost/MR%/Pct) — home-and-away only
- Home/Away breakdown
- Results list — all matches including cross-grade and finals (greyed out = doesn't count toward ladder)
- Season Roster (collapsible) — all players including transferred players who previously played for this team

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

- A match counts for the **ladder** only if both teams share the same current grade
- Mismatched matches (e.g. grading rounds where teams ended up in different divisions) appear greyed out
- Individual player goals always count regardless of grade movement

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

## Known issues

- **`lastRound` is dead code in the dashboard.** It reads `S.lastRound["comp|age|grade"]` while `fetch-results.js` writes `"age|grade"` with no competition prefix, so the round label on the ladder grade tabs never renders.
- **`logoKey()` colour stripping does not work.** `new RegExp('\s+' + c + '\s*$')` uses a plain string, so `\s` becomes a literal `s`. Unnoticed because `teamLogos` is keyed by full team name and usually hits exactly.
- **Team identity is derived from a cleaned display name**, not the PlayHQ team `id` — which both fetchers request and discard. This is the root cause of the club-name heuristics in `fetch-stats.js`. Deferred to the multi-season work.

---

## Version history

| Version | Key changes |
|---------|-------------|
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
