# Outstanding Tasks

**Repo:** `markjovic/junior-footy-dashboard`  
**Last updated:** 2026-08-13 (Beta 0.165)

This document is the single place for anything that needs a decision, an action
from you, or work from me. Read top to bottom; the order is priority.

---

## YOUR ACTIONS — do these now

### 1. Delete `probe-ser-logos.js` and its workflow by hand

Repo Tidy ran and applied on 2026-08-13, removing 18 files (164K). These two are
in no tidy group, so delete them through the GitHub web UI:

- `scripts/probe-ser-logos.js`
- `.github/workflows/probe-ser-logos.yml`

### 2. Delete `data/orgs` (after a clean weekend)

**Wait for:** two full weekends of stable scheduled results runs.  
**How:** GitHub web UI → navigate to `data/orgs/` → delete the directory.  
**Why:** 105.25 MB rollback path. The audit reports it as INFO every run until
it's gone.

### 3. Delete `data/data.json` if still present

The rollback path from the 2026-08-11 per-organisation split. Nothing reads
or writes it.

### 4. Run a full, non-VIP Fetch Results, then Audit Data

This is the run that rebuilds `lastRound` under the new `compName|age|gradeId`
key and drops the legacy two-segment ones. The log will report both counts:

```
lastRound: dropped N pre-v14 key(s) that no reader could match
lastRound: N rebuilt for 5 covered competition(s), N kept
```

Then **Audit Data**. Section 9 should report 0 wrong-shape keys for both
`lastRound` and `gotwFlags`.

Then look at the ladder grade tabs. The small round number should appear for the
first time since Beta 0.133. No verification suite can judge that — it is a
look-at-the-screen check.

### 5. Run Build Club Index after the next results run

`results-engine.js` v13 writes `teamOrg` directly from PlayHQ for teams whose
rounds were previously skipped. Run **Build Club Index** with no filter once a
results run has landed, to pick them up.

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

### A1. Fix `repo-tidy.js`'s reference classifier (HIGH)

`repo-tidy.js` reports a mention in a `.yml` workflow or a `.js` script as
"Mentioned in documentation only". It is matching on filename, not on whether the
mention is live code. On 2026-08-13 it classified `.github/workflows/verify-store.yml`
and `scripts/probe-team-join.js` that way. Both turned out to be comments, so the
verdict was right twice by luck — a real `require()` would have read identically
and the REFUSED guard would not have fired.

Upload `scripts/repo-tidy.js` and say "go".

### A2. Fix the stale empty-`rawGrade` audit warning

The warning says the affected grades share a ladder "until build-order step 6".
Step 6 is done — ladders group by `gradeId` — so the sentence is wrong. The
`data/orgs` INFO resolves itself once you delete the directory (action 2).

Small change, low priority.

### A3. Cross-season player search index

If D4 approved: 5.67 MB index, loaded on first keystroke. Results show the
player's seasons; opening one fetches that season's player file only.

### A4. Phase B player stats for new organisations

When new organisations are added (D5), they need a backfill run with
`STATS_INCLUDE_RETIRED=true`. Standard procedure once the orgs are configured.

### A5. Concurrent competitions

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
diagnostics. `probe-team-join.js` was rewritten on 2026-08-13 to read through
`store.load` — it was still walking the retired `data/orgs` layout and would have
reported "nothing stored" and exited 0 once that directory is deleted.
`probe-ser-logos.js` answered its question — see action 1.

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

- **`lastRound` and `gotwFlags` re-keyed** (Beta 0.165, engine v14). Recorded as
  one defect needing a migration; it was two defects needing none. `lastRound`
  was never read at all — writer `age|rawGrade`, reader `compName|age|gradeId` —
  so the round number on the ladder grade tabs was blank from Beta 0.133.
  `gotwFlags` was `age|roundKey`, colliding across competitions AND seasons, but
  no pick had ever been made anywhere so there was nothing to migrate. Both keys
  now carry the competition. `writeLastRound` retired.
  `docs/lastround_gotw_keying_design.md`.
- **`report-field-usage.js` v2 and its first workflow.** SOURCES went from 8 files
  to 18: `lib/store.js`, `lib/results-engine.js` and `backfill.js` were all
  absent, and `backfill.js` is a writer. `gradeId` and the per-season file
  structure are now tracked. **There was no workflow at all**, so the tool built
  to prevent the next `hLogo` incident had never been runnable. Its first run
  found that `OUTSTANDING_TASKS.md` A5 named `fetch-results.js`, which references
  neither key, and omitted `migrate-grade-ids.js`, which does.
- **Repo Tidy applied**: 18 files, 164K.
- **`probe-team-join.js` v4**: reads through `store.load` instead of walking
  `data/orgs`. It would have exited 0 reporting "nothing stored" once that
  directory is deleted — confirmed by running the committed v3 against a fixture
  with the directory absent.
- **Verification**: 8 suites now total 401 assertions (was 302).
  `verify-backfill` 75→94, `verify-dashboard-grades` 77→88, `verify-audit` 43→52.
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
