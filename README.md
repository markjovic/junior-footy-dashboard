# Local Footy Dashboard — Beta 0.106

A single-file HTML dashboard for AFL football results, automatically fetched from PlayHQ. Renders a live ladder, results, top scorers, Game of the Week, and player profiles across all age groups and grades for multiple competitions simultaneously.

**Live URL:** `https://markjovic.github.io/junior-footy-dashboard/`

---

## Repo structure

```
index.html                  ← Single-file dashboard PWA (all HTML/CSS/JS)
data.json                   ← Match data, player stats, logos (auto-committed by workflow)
grades.json                 ← Grade cache (auto-populated by fetch workflow)
config.json                 ← Competition config (season IDs, VIP flag, grade exclusions)
manifest.json               ← PWA manifest (home screen install)
sw.js                       ← Service worker (offline support, cache-first shell)
favicon.ico                 ← Browser tab icon
README.md
.github/
  workflows/
    fetch-results.yml       ← workflow_dispatch only (scheduling via Cloudflare Worker)
scripts/
  fetch-results.js          ← Fetches match results from PlayHQ GraphQL API
  fetch-stats.js            ← Fetches player statistics from PlayHQ GraphQL API
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
6. Open the live URL — data populates automatically

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

---

## How data updates work

Two scripts run in sequence via GitHub Actions. Both can be triggered manually via the Admin panel.

### fetch-results.js
Fetches match fixtures and results. Each run:
1. Calls `gradeListDiscoverSeason` to discover all grades for configured competitions
2. For each grade, fetches only rounds not yet stored (skips known rounds, re-checks highest known round every run)
3. Partial rounds (some games not yet final) are flagged and re-fetched next run
4. Partial rounds with a later complete round are promoted to complete (forfeit/error)
5. Grades starting mid-season get implied bye sentinels for missing early rounds
6. Merges new results into `data.json` and commits

### fetch-stats.js
Fetches player statistics. Each run:
1. Fetches all pages of `publicGradeStatistics` for each grade
2. Buckets raw appearance records by `uuid|age|compName`
3. For players under multiple clubs: fetches `publicProfileStatistics` to determine current club
4. Same-club multi-team players (e.g. "St Bernards Mixed Davey" + "St Bernards Mixed Hardwick") are correctly identified as one club — not flagged as transfers
5. Resolves each bucket into a canonical player record
6. **Merges into existing `data.players` by `uuid|age|compName`** — records not in this run are left unchanged (other comps, API timeouts)

**Retry logic:** up to 4 attempts with 2s/4s/6s backoff on HTTP errors.

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
- Season stats strip (Played/Won/Drawn/Lost/MR%/Pct)
- Home/Away breakdown
- Results list — all matches including cross-grade (greyed out = doesn't count toward ladder)
- Season Roster (collapsible) — all players including transferred players who previously played for this team

---

## Admin panel

Access via ⚙ button → enter password. Three tabs:

### Game of Week
Select competition, age group, and round. Matches sorted by closest margin% (gold = closest). Select to pin as GOTW.

### Fetch
Trigger GitHub Actions workflow runs from the dashboard. Requires a GitHub classic PAT with `workflow` scope. PAT stored in localStorage.

### Manage
- Show/hide young age groups (U8–U10) toggle — resets each visit
- Version display
- Password hash generator (SHA-256)

**To change admin password:** Admin → Manage → Generate hash → paste into `ADMIN_HASH` in `index.html` → commit.

---

## Multi-competition support

Five competitions in 2026: EFNL, WFNL, SEJ, SER, YJFL. Each appears as a filter chip in the sidebar. Match and roster IDs are scoped by `compName` to prevent cross-competition collisions.

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

A team's current grade = the grade they last appeared in (from the roster).

- A match counts for the **ladder** only if both teams share the same current grade
- Mismatched matches (e.g. grading rounds where teams ended up in different divisions) appear greyed out
- Individual player goals always count regardless of grade movement

---

## Age group sort order

Senior Men → Senior Women → Reserve Men → Veterans → U19.5 → U18 Girls → U17.5 → U16 → U16 Girls → U15 → U14 → U14 Girls → U13 → U12 → U12 Girls → U11 → U10 → U9 → U8

Young age groups (U8/U9/U10) hidden by default. Toggle in Admin → Manage to show them.

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

## Version history

| Version | Key changes |
|---------|-------------|
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
