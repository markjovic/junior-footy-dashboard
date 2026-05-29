# Local Footy Dashboard — Beta 0.41

A single-file HTML dashboard for AFL football results, automatically fetched from PlayHQ. Renders a live ladder, results, top scorers, and Game of the Week across all age groups and grades for any number of competitions.

**Live URL:** `https://markjovic.github.io/junior-footy-dashboard/`

---

## Repo structure

```
index.html                  ← Single-file dashboard app (PWA)
data.json                   ← All match data, roster, logos (auto-committed)
grades.json                 ← Grade list cache (auto-populated by fetch workflow)
config.json                 ← Competition config (season IDs, grade exclusions)
manifest.json               ← PWA manifest (home screen install)
sw.js                       ← Service worker (offline support)
README.md
.github/
  workflows/
    fetch-results.yml       ← Auto-fetch workflow (runs hourly on Sundays)
scripts/
  fetch-results.js          ← Fetches results from PlayHQ GraphQL API
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
4. Edit `config.json` with your competition's season ID (see below)
5. Trigger the fetch workflow manually from the **Actions** tab
6. Open the live URL — data populates automatically

### Finding your season ID

Open any fixture page on PlayHQ for your competition. In DevTools (F12) → Network → Fetch/XHR, look for a `gradeListDiscoverSeason` request. The `id` variable in its payload is your season ID.

---

## config.json

```json
{
  "competitions": [
    {
      "name": "EFNL 2026",
      "seasonID": "2dcbf383",
      "excludeGrades": ["U8", "U9", "U10"]
    },
    {
      "name": "WFNL 2026",
      "seasonID": "2170ac5a",
      "excludeGrades": ["U8", "U9", "U10"]
    }
  ]
}
```

- **`seasonID`** — found via DevTools (see above). Fixed for the whole season.
- **`excludeGrades`** — substring matches against grade names. `"U8"` excludes all U8 grades including `"U8 Girls"`, `"U8 - Eastern"` etc.
- Multiple competitions are supported — add more entries to the array.

---

## How data updates work

The fetch workflow runs automatically every hour on Sundays (10am–9pm AEST) and can be triggered manually any time from the Actions tab.

Each run:
1. Calls the PlayHQ GraphQL API to discover all grades for configured competitions
2. For each grade, fetches only rounds not yet stored (skips known rounds)
3. Stops at the current round (uses PlayHQ's `current` flag)
4. Merges new results into `data.json` and commits

**Bye rounds** are stored as internal sentinels so they don't cause re-fetching on subsequent runs.

**Grading rounds** are included in results but don't count toward the ladder.

---

## Multi-competition support

The dashboard supports multiple competitions simultaneously. Each competition appears as a filter chip at the top of the sidebar. Selecting a competition filters all views — ladder, results, top scorers, GOTW.

Match and roster IDs are scoped by `compName` to prevent cross-competition collisions, even when two competitions have grades with the same name (e.g. both EFNL and WFNL have "Division 1 Senior Men").

**Grade naming:** Uses PlayHQ's structured `age` and `gender` fields from the API rather than parsing the grade name string. This makes parsing robust across competitions with different sponsor-prefixed naming conventions (e.g. "SEDA College U16 Boys Division 1", "Western Bulldogs U14 Mixed Division 3").

---

## Grade movement rules

The roster is rebuilt automatically from match history after every fetch. A team's current grade is whichever grade they last appeared in.

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
**iOS (Safari):** Tap Share → Add to Home Screen. Must use Safari.

The app works offline using the last-loaded data.

---

## Admin password

Stored as a SHA-256 hash in `index.html`. Never in plain text or `data.json`.

**To change:** Admin → Manage → Generate hash → paste into `ADMIN_HASH` in `index.html` → commit.

---

## One-off migrations

After deploying an updated `fetch-results.js` that changes grade naming or adds a new competition, run the migration to update existing data:

1. **Actions** → **Fetch PlayHQ Results** → **Run workflow**
2. Set `run_migration` to `yes`
3. Run

The migration commits first, then the fetch runs immediately after to re-fetch any deleted/reset matches.

**What the migration does:**
- Remaps old-style `age`/`rawGrade` values to new format
- Assigns correct `compName` to all matches using `grades.json` as the source of truth
- Deletes ambiguous matches (e.g. Senior Men/Reserve Men that exist in multiple comps) and resets their `lastRound` so they re-fetch with correct compNames
- Rebuilds the roster and `lastRound` map

---

## Version history

| Version | Key changes |
|---------|-------------|
| 0.41 | Age dropdown no longer flashes white — options only rebuilt when list changes |
| 0.40 | matchesComp no longer calls getComps() per match — fixes slow dropdown with 2 comps |
| 0.39 | matchIsValid/_grade pre-computed on data load |
| 0.38 | Competition filter fixed after WFNL added; grade tabs drop "Grade" prefix |
| 0.37 | Roster and currentGrade keyed by compName\|teamName\|age |
| 0.36 | localStorage keys bumped to v3; bye sentinels filtered on load |
| 0.35 | Age group custom sort order |
| 0.34 | Generic parseGradeName using PlayHQ structured fields |
| 0.33 | matchIsValid fixed for empty rawGrade senior grades |
| 0.32 | Bye sentinels persisted to data.json |
| 0.31 | Away team right-aligned; current-round flag for future detection |
| 0.30 | Grade sort order fixed; colour-stripped roster lookup |
| 0.29 | Colour words preserved in team names |
| 0.28 | Roster keyed by teamName\|age |
| 0.27 | Filter persistence with cascade fallback |
| 0.26 | Filter persistence via localStorage |
| 0.25 | Age group dropdown |
| 0.24 | PWA support |
| 0.1  | Initial build |
