# Local Footy Dashboard — Beta 0.79

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
- **`vip`** — `true` = fetched on every scheduled run. `false` = fetched only on standard schedule times (see Scheduling below)
- **`excludeGrades`** — substring matches against grade names. `"U8"` excludes `"U8 Girls"`, `"U8 - Eastern"` etc.

---

## How data updates work

Two separate scripts run on separate schedules. Both can be triggered manually via the Admin panel in the dashboard.

### fetch-results.js
Fetches match fixtures and results. Each run:
1. Calls `gradeListDiscoverSeason` to discover all grades for configured competitions
2. For each grade, fetches only rounds not yet stored (skips known rounds)
3. Stops at the current round (uses PlayHQ's `current` flag)
4. Merges new results into `data.json` and commits

### fetch-stats.js
Fetches player statistics independently. Each run:
1. Iterates every grade in `grades.json`, fetching all pages of `publicGradeStatistics` sorted by goals DESC
2. Buckets raw appearance records by `uuid|age|compName`
3. For players appearing under multiple clubs: fetches `publicProfileStatistics` to determine current club
4. Resolves each bucket into a canonical player record with total GP, goals, best player awards
5. Completely replaces `data.players` in `data.json` (clean rebuild each run)

**Retry logic:** up to 4 attempts with 2s/4s/6s backoff on HTTP errors.

---

## Scheduling

Scheduled times are AEST. VIP competitions (e.g. EFNL) run on all fetches. Standard (non-VIP) competitions only run on the standard schedule times.

| Time | Results | Stats | Comps |
|------|---------|-------|-------|
| Sat 2pm/5pm/8pm | ✓ | — | VIP only |
| Sat 11pm | ✓ | — | All |
| Sat 11:30pm | — | ✓ | All |
| Sun 11am/12pm/1pm/2pm/3pm/4pm | ✓ | — | VIP only |
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

**Same club, multiple grades** (e.g. played A grade then moved to B): goals and GP are summed across all grades. The player appears in the leaderboard under their current grade.

**Transfer (different clubs)**: total GP and goals are summed across both clubs. The player is attributed to their current (most recent) club. Their old club appearances are dimmed in the player panel.

**Private profiles**: excluded from all stats — PlayHQ does not return these players from the stats API.

---

## Player panel

Click any player name (top scorers, team roster, or search) to open a panel showing:
- Current team crest, name (linked to PlayHQ profile), team, grade, XFER badge
- Season summary: total GP, goals, goals/game, best player awards
- Game-by-game breakdown fetched live from PlayHQ via a Cloudflare Worker proxy

The live game data is fetched from `publicProfileStatistics` via the proxy at `solitary-snowflake-cb3e.insanoflash.workers.dev`.

---

## Player search

The sidebar includes a player search field. Type 2+ characters to see matching players from the loaded stats. Results show team crest, name, age group, grade, and goals. Click any result to open the player panel.

---

## Admin panel

Access via ⚙ button → enter password. Two tabs:

### Game of Week
Select competition, age group, and round. Matches are sorted by closest margin % (gold = closest). Select a match to pin as GOTW — if none pinned, the closest valid match is used automatically.

### Fetch
Trigger GitHub Actions workflow runs directly from the dashboard. Requires a GitHub classic PAT with `workflow` scope (generate at github.com/settings/tokens — must be classic, not fine-grained). PAT is stored in localStorage. Choose VIP only or all comps, optionally run migration, then trigger results, stats, or both.

### Manage
- Version display
- Password hash generator (SHA-256) for changing the admin password

**To change admin password:** Admin → Manage → Generate hash → paste value into `ADMIN_HASH` constant in `index.html` → commit.

---

## Multi-competition support

The dashboard supports multiple competitions simultaneously. Each appears as a filter chip in the sidebar. Match and roster IDs are scoped by `compName` to prevent cross-competition collisions, even when two competitions share grade names (e.g. both EFNL and WFNL have "Division 1 Senior Men").

---

## Grade naming

PlayHQ grade names vary widely by competition (e.g. `"U12 - B"`, `"Western Bulldogs U12 Girls Division 1"`, `"SEDA College U16 Boys Division 3"`). The dashboard uses PlayHQ's structured `age`/`gender` fields for reliable parsing rather than string parsing. Grade abbreviations applied throughout:

- `Division N` → `DN` (e.g. D1, D2)
- `Premier` → `Prem`

---

## Grade movement rules

The roster is rebuilt automatically after every results fetch. A team's current grade = the grade they last appeared in.

- A match counts for the **ladder** only if both teams currently share the same grade
- Mismatched matches appear greyed out in results with a "not counted" label
- Individual player goals always count regardless of grade movement

---

## Age group sort order

Senior Men → Senior Women → Reserve Men → Veterans → U19.5 → U18 Girls → U17.5 → U16 → U16 Girls → U15 → U14 → U14 Girls → U13 → U12 → U12 Girls → U11

Unknown age groups (e.g. "Thirds") fall to the end alphabetically.

---

## PWA — installing as an app

**Android (Chrome):** Tap the three-dot menu → Add to Home Screen.
**iOS (Safari):** Tap the Share button → Add to Home Screen. Must use Safari, not Chrome.

The app works offline using the last-loaded data. The service worker caches the app shell (`index.html`) and serves `data.json` network-first with cache fallback.

---

## Cloudflare Worker proxy

Browser requests to PlayHQ are blocked by CORS. A Cloudflare Worker at `solitary-snowflake-cb3e.insanoflash.workers.dev` proxies GraphQL requests for the player panel, adding the required `tenant` and `origin` headers server-side. Only POST requests from `markjovic.github.io` are forwarded.

---

## One-off migrations

After adding a new competition or changing grade naming:

1. **Actions** → **Fetch PlayHQ Results & Stats** → **Run workflow**
2. Set `run_migration` to `yes`
3. Run

The migration commits first, then the fetch runs immediately after.

---

## Version history

| Version | Key changes |
|---------|-------------|
| 0.79 | Crest lazy-loading in player panel; close player panel returns to team modal |
| 0.78 | Correct Cloudflare Worker URL |
| 0.77 | Favicon link tag added |
| 0.76 | Remove tenant header from browser fetch (added by proxy instead) |
| 0.75 | Admin password pre-filled from localStorage; hidden username field for PAT browser saving |
| 0.74 | Clarify classic PAT requirement in fetch tab |
| 0.73 | GOTW dropdowns populate correctly on first open |
| 0.72 | Fetch tab visible in admin; GOTW comp dropdown; matches sorted by margin%; clear buttons removed |
| 0.71 | Cloudflare Worker proxy URL connected for player panel |
| 0.70 | VIP competition flag in config.json; full VIP/standard schedule implemented |
| 0.69 | Grade display fix in player panel header |
| 0.68 | Player panel: close team modal on open; remove duplicate crest; gold toggle arrows |
| 0.67 | Player panel game rows include age and comp in grade column |
| 0.66 | Player panel with live PlayHQ stats; player search in sidebar |
| 0.65 | Admin login form static HTML for browser password saving |
| 0.64 | Admin Fetch tab: trigger GitHub Actions from dashboard |
| 0.63 | Web Share API button in header |
| 0.62 | Filter button gold and auto-opens on mobile portrait |
| 0.61 | Mobile tab navigation (Ladder/Results/GOTW/Scorers) |
| 0.60 | Prem/D4/D5 colours; crest load debouncing |
| 0.59 | Division → D1/D2 in grade tabs; retry logic in fetch-stats |
| 0.58 | Division/Premier abbreviated everywhere |
| 0.57 | abbrevGrade applied universally; WFNL Senior Women/Thirds scorers fixed |
| 0.56 | toProperCase already implemented; duplicate function removed |
| 0.55 | WFNL U12 Girls rawGrade fix; fetch-results no longer calls fetch-stats |
| 0.50 | Top scorers: crest, GP, BP columns; admin Upload/Roster tabs removed |
| 0.49 | Results open by default, roster collapsed |
| 0.48 | Results section collapsible in team drilldown |
| 0.47 | Team name matching uses age-stripped comparison for roster |
| 0.46 | Roster in team drilldown with BP column |
| 0.41 | Age dropdown no longer flashes white |
