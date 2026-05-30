# Local Footy Dashboard — Beta 0.92

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
    fetch-results.yml       ← Scheduled + manual fetch workflow
scripts/
  fetch-results.js          ← Fetches match results from PlayHQ GraphQL API
  fetch-stats.js            ← Fetches player statistics from PlayHQ GraphQL API
  migrate-grades.js         ← One-off migration for grade name/compName remapping
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
      "excludeGrades": ["U8", "U9", "U10"]
    },
    {
      "name": "WFNL 2026",
      "seasonID": "2170ac5a",
      "vip": false,
      "excludeGrades": ["U8", "U9", "U10"]
    }
  ]
}
```

- **`seasonID`** — fixed for the whole season, found via DevTools
- **`vip`** — `true` = fetched on every scheduled run. `false` = fetched only on standard schedule times
- **`excludeGrades`** — substring matches against grade names

---

## How data updates work

Two separate scripts run on separate schedules. Both can be triggered manually via the Admin panel.

### fetch-results.js
Fetches match fixtures and results. Each run:
1. Calls `gradeListDiscoverSeason` to discover all grades for configured competitions
2. For each grade, fetches only rounds not yet stored
3. Stops at the current round (uses PlayHQ's `current` flag)
4. Merges new results into `data.json` and commits

### fetch-stats.js
Fetches player statistics independently. Each run:
1. Fetches all pages of `publicGradeStatistics` for each grade, sorted by goals DESC
2. Buckets raw appearance records by `uuid|age|compName`
3. For players under multiple clubs: fetches `publicProfileStatistics` to determine current club
4. Resolves each bucket into a canonical player record
5. **Merges into existing `data.players` by `uuid|age|compName`** — records not covered by this run (other comps, or players missed due to API timeouts) are left unchanged

**Retry logic:** up to 4 attempts with 2s/4s/6s backoff on HTTP errors.

---

## Scheduling

| Time (AEST) | Results | Stats | Comps |
|-------------|---------|-------|-------|
| Sat 2pm/5pm/8pm | ✓ | — | VIP only |
| Sat 11pm | ✓ | — | All |
| Sat 11:30pm | — | ✓ | All |
| Sun 11am–4pm hourly | ✓ | — | VIP only |
| Sun 5pm | ✓ | — | All |
| Sun 5:30pm | — | ✓ | VIP only |
| Sun 8pm | ✓ | — | VIP only |
| Sun 11pm | ✓ | — | All |
| Sun 11:30pm | — | ✓ | All |
| Mon 3am | ✓ | — | All |
| Mon 9am | ✓ | — | VIP only |
| Mon 12pm | ✓ | — | All |
| Mon 12:30pm | — | ✓ | All |

---

## Player statistics

The dashboard resolves player goal-kicking statistics across multiple grades and clubs:

**Same club, multiple grades** (e.g. played A grade then moved to B): goals and GP are summed. The player appears under their current grade.

**Transfer (different clubs)**: total GP and goals are summed across both clubs. The player is attributed to their current (most recent) club. Old club appearances are dimmed in the player panel.

**Private profiles**: excluded — PlayHQ does not return these from the stats API.

---

## Player panel

Click any player name (top scorers, team roster, or search) to open a panel showing:
- Current team crest, name (linked to PlayHQ profile), team (clickable → team drilldown), grade, XFER badge
- Season summary: GP, goals, goals/game, best player awards (full-width 4-column strip)
- Game-by-game breakdown fetched live from PlayHQ via Cloudflare Worker proxy
- Columns: Round, Home, Away, Grade, Comp (logo), G, BP
- Player's team shown in gold + bold; opponent in regular weight

The live game data is fetched from `publicProfileStatistics` via `solitary-snowflake-cb3e.insanoflash.workers.dev`.

---

## Player search

Sidebar includes a live search field. Type 2+ characters to match player names. Results show team crest, name, age group, grade, and goals. Click to open the player panel.

---

## Team drilldown

Click any team name (ladder, results, GOTW, scorers, player panel header) to open a modal showing:
- Season stats strip (Played/Won/Drawn/Lost/MR%/Pct)
- Home/Away breakdown
- Results list (valid matches full opacity, invalid/not-counted dimmed)
- Season Roster (collapsible) — shows players attributed to this team with GP, G, G/G, BP

---

## Admin panel

Access via ⚙ button → enter password. Three tabs:

### Game of Week
Select competition, age group, and round. Matches sorted by closest margin% (gold = closest). Select to pin as GOTW.

### Fetch
Trigger GitHub Actions workflow runs from the dashboard. Requires a GitHub classic PAT with `workflow` scope (github.com/settings/tokens — must be classic, not fine-grained). PAT stored in localStorage.

### Manage
- Version display
- Password hash generator (SHA-256)

**To change admin password:** Admin → Manage → Generate hash → paste into `ADMIN_HASH` in `index.html` → commit.

---

## Multi-competition support

Each competition appears as a filter chip in the sidebar. Match and roster IDs are scoped by `compName` to prevent cross-competition collisions.

---

## Grade naming

PlayHQ grade names vary by competition. The dashboard uses PlayHQ's structured `age`/`gender` fields for reliable parsing. Grade abbreviations:
- `Division N` → `DN` (e.g. D1, D2)
- `Premier` → `Prem`

---

## Grade movement rules

A team's current grade = the grade they last appeared in (from the roster).

- A match counts for the **ladder** only if both teams share the same current grade
- Mismatched matches appear greyed out with "not counted"
- Individual player goals always count regardless of grade movement

---

## Age group sort order

Senior Men → Senior Women → Reserve Men → Veterans → U19.5 → U18 Girls → U17.5 → U16 → U16 Girls → U15 → U14 → U14 Girls → U13 → U12 → U12 Girls → U11

Unknown age groups fall to the end alphabetically.

---

## PWA — installing as an app

**Android (Chrome):** Three-dot menu → Add to Home Screen.
**iOS (Safari):** Share button → Add to Home Screen. Must use Safari.

Works offline using last-loaded data. Service worker skips POST requests (Cache API limitation).

---

## Cloudflare Worker proxy

Browser requests to PlayHQ are blocked by CORS. A Cloudflare Worker at `solitary-snowflake-cb3e.insanoflash.workers.dev` proxies GraphQL POST requests for the player panel, adding required headers server-side. Only accepts requests from `markjovic.github.io`.

---

## Version history

| Version | Key changes |
|---------|-------------|
| 0.92 | Comp logo in player panel uses p.compName directly (API doesn't return comp for all leagues) |
| 0.91 | Debug logging for comp name extraction |
| 0.90 | sw.js: skip non-GET requests; expanded debug logging |
| 0.89 | Player panel stat strip full-width (4-col override) |
| 0.88 | Comp name extracted from club.name org parenthetical |
| 0.87 | Grade extraction regex fixed for WFNL sponsor-prefix format; comp logo fallback |
| 0.86 | Grade column uses pre-dash token; drillTeam uses p.team; rawGradeResolved passed to drilldown |
| 0.85 | openTeamDrilldown from player panel passes p.age as ageOverride |
| 0.84 | Grade extraction from API grade name; competition field added to profile query |
| 0.83 | Player panel team drilldown uses p.team (bare club name) not teamDisplay |
| 0.82 | Team name in player panel header clickable → team drilldown (not game rows) |
| 0.81 | Player panel: grade/comp split columns; comp logo; player team gold in game rows |
| 0.80 | Roster comp filter uses matches[0].compName; fetch-stats merge by uuid key |
| 0.79 | Crest lazy-loading in player panel; close player panel returns to team modal |
| 0.78 | Correct Cloudflare Worker URL |
| 0.77 | Favicon link tag added |
| 0.76 | Remove tenant header from browser fetch |
| 0.75 | Admin password pre-filled from localStorage |
| 0.70 | VIP competition flag; full VIP/standard schedule |
| 0.66 | Player panel with live PlayHQ stats; player search |
| 0.61 | Mobile tab navigation |
| 0.50 | Top scorers: crest, GP, BP columns |
| 0.46 | Team roster in drilldown |
| 0.41 | Age dropdown no longer flashes white |
