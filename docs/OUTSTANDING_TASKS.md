# Outstanding Tasks

**Repo:** `markjovic/junior-footy-dashboard`  
**Last updated:** 2026-08-13 (Beta 0.164)

This document is the single place for anything that needs a decision, an action
from you, or work from me. Read top to bottom; the order is priority.

---

## YOUR ACTIONS — do these now

### 1. Run Repo Tidy to remove dead files

**Workflow:** Repo Tidy  
**Inputs:** `groups: storage2026,probes,historic`, `apply: false` (dry run first)

The 2026-08-12 dry run confirmed 17 items. `probe-ser-logos.js` and its
workflow should also be added to the `probes` group in `repo-tidy.js` before
running — add the two entries, then include `probes` in the groups.

Read the dry run output, then re-run with `apply: true`.

### 2. Delete `data/orgs` (after a clean weekend)

**Wait for:** two full weekends of stable scheduled results runs.  
**How:** GitHub web UI → navigate to `data/orgs/` → delete the directory.  
**Why:** 105.25 MB rollback path. The audit reports it as INFO every run until
it's gone.

### 3. Delete `data/data.json` if still present

The rollback path from the 2026-08-11 per-organisation split. Nothing reads
or writes it.

### 4. Commit `results-engine.js` v13

Delivered 2026-08-13. Adds `organisation { id }` to the fixture query so club
identity is read directly from PlayHQ. The next scheduled results run after
committing this will write `teamOrg` entries for teams whose rounds were
previously skipped. Then run **Build Club Index** (no filter) to pick them up.

### 5. Add `probe-ser-logos.js` to repo-tidy's probes group

The probe answered its question (2026-08-13). Add to `repo-tidy.js` probes
group and remove via tidy run.

---

## YOUR DECISIONS — needed before work can start

### D1. Concurrent competitions (SEJ 2026 U10)

Two leagues run in the same age group. A team can only be on one ladder. The
Lightning Premiership grades currently don't appear.

**Options:**
- Show both ladders separately, labelled by sub-competition
- Show only the main ladder, with a note that Lightning Premiership exists
- Add a tab within the age group to switch between them

**Decision needed before any code is written.**

### D2. `lastRound` and `gotwFlags` keying collision

Both keys use `age|rawGrade` with no competition component. When two
competitions share an age/grade name, the values collide. This causes incorrect
behaviour for affected grades.

**The fix requires a data migration.** If yes, I'll write the design first.

### D3. URL state / deep linking

The competition, age, and year are not in the URL. Sharing a link opens the
default view for everyone.

**Is this worth building?**

### D4. Cross-season player search index

Search currently covers only the selected season. A 5.67 MB index (uuid + name
+ seasons for 70,672 distinct people) would span all 18 seasons. The
architecture is clear.

**Do you want this built?**

### D5. The twelve new organisations

`config.json` covers five organisations. Twelve more are in
`organisationCodes[]` but need short names before they can be added — the
short name becomes half of every match id.

**Which do you want to add, and what short names?**

---

## ACTIONS FOR ME — ready when you say go

### A1. Update `report-field-usage.js` SOURCES list (HIGH)

Missing five writers added on 2026-08-12: `results-engine.js`,
`migrate-grade-ids.js`, `rebuild-grade-meta.js`, `split-by-season.js`,
`cleanup-obsolete.js`. Also missing the `gradeId` field. Without these it
under-reports field usage — the tool that was supposed to prevent the next
`hLogo` incident is partially blind.

Upload `scripts/report-field-usage.js` and say "go".

### A2. Fix the two stale audit warnings

- The empty `rawGrade` warning says "until build-order step 6" — step 6 is
  done since Beta 0.133.
- The `data/orgs` INFO resolves itself once you delete the directory.

Small change, low priority.

### A3. Cross-season player search index

If D4 approved: 5.67 MB index, loaded on first keystroke. Results show the
player's seasons; opening one fetches that season's player file only.

### A4. Phase B player stats for new organisations

When new organisations are added (D5), they need a backfill run with
`STATS_INCLUDE_RETIRED=true`. Standard procedure once the orgs are configured.

### A5. Fix `lastRound`/`gotwFlags` keying collision

If D2 approved: design first, then implement. Requires changes to `store.js`,
`results-engine.js`, `fetch-results.js`, and `index.html`.

### A6. Concurrent competitions

If D1 decided: design first, then implement.

---

## MONITORING — after every scheduled run

1. **Verify storage layer** — runs automatically; check Actions tab for green
2. **Audit data** — 0 errors is the target; warnings are expected and documented
3. **The dashboard** — Season selector, a live ladder, Scorers for the week

---

## DEFERRED

### Probe scripts

`probe-team-join.js` and `probe-finals-rounds.js` are kept as reusable
diagnostics. `probe-ser-logos.js` answered its question and should be removed.

### `team_registry_design.md` open questions

Four open questions remain. Not urgent; review when `discoverTeams` behaviour
needs to be pinned down for a future feature.

### Grade identity migration — 49 remaining records

Self-healing YJFL bye sentinels. No action needed unless the count grows.

### `assets/clubs/**` directory

~10.7 MB of club badge assets confirmed dead. The `assets` group in
`repo-tidy.js` will remove them. Include in a future tidy run.

---

## WHAT CHANGED ON 2026-08-13

- **Finals by-club view** (Beta 0.162–0.164): global grade round index, so
  teams from different clubs in the same grade share one column scheme. Correct
  `finalsAbbrev` labels (QF/EF/GF) rather than round names. Column placement
  fixed for teams that won FR1 and went straight to GF.
- **SER unattributed clubs resolved**: 566 SER teams appeared as Unattributed
  since the club index was first built. Root cause: those rounds were fetched
  before `teamOrg` was introduced; subsequent runs skipped them as already
  stored; per-match logo fields were stripped. Evidence was in `teamLogos` all
  along. `build-club-index.js` v4 adds a `teamLogos` fallback that resolved
  all 566. 0 unattributed teams remain across all competitions.
- **`results-engine.js` v13**: adds `organisation { id }` to the fixture
  query. Future fetches write `teamOrg` directly from PlayHQ rather than
  parsing a Cloudinary URL, which is more reliable and format-independent.
- **`verify-backfill.js`**: version regex loosened to match any date, so it
  doesn't need updating every session when `results-engine.js` changes.
- **`probe-ser-logos.js`**: diagnostic confirmed the API returns logos and
  organisation ids for SER correctly — the problem was timing, not a data gap.

## WHAT CHANGED ON 2026-08-12

- **Per-season storage layout**: `data/orgs` → `data/seasons`.
- **Season selector**: Year is the outer scope.
- **Page load**: 26.27 MB → ~5.4 MB.
- **Players deferred**: loaded after first paint.
- **Store.js v5**: write-only-if-changed; player-file blank guard.
- **Grade identity migration**: 99.91% complete.
- **gradeMeta rebuilt**: all 18 seasons have id-keyed entries with labels.
- **Finals by-club view**: initial build — positional columns, GF last, global
  column count, team sort by result band then grade strength.
- **Player search**: token matching in any order; scoped to selected season.
- **Verification**: 7 suites, 302 assertions, runs automatically on push.
- **Repo tidy**: 17 dead files identified and ready for removal.
- **Two data-loss incidents**: both recovered; both now guarded.
