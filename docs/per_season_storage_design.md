<!-- docs/per_season_storage_design.md -->
# Per-Season Storage — Design Document

**Repo:** `markjovic/junior-footy-dashboard`
**Status:** APPROVED 2026-08-12. All three §7 questions answered; the answers
are in §7 and reflected in §2. Not yet built.
**Date:** 2026-08-12
**Evidence:** `scripts/audit-data.js` v8 run on GitHub Actions 2026-08-12, and
the EFNL archive measured before and after Phase B. Every figure is from a run.
Where something is derived it says so and shows the arithmetic.

Supersedes the on-demand loading described in `season_selection_design.md` §2.2,
which assumed archives totalling 16.92 MB. They are now 78.98 MB.

---

## 1. What changed, and why it blocks the year selector

Phase B put player records into the archives. Measured 2026-08-12:

| File | Size | matches | players |
|---|---|---|---|
| `4f9a099e-archive.json` | 24.99 MB | 13,170 | 41,597 |
| `1cf85e52-archive.json` | 20.43 MB | 10,570 | 33,577 |
| `383836bb-archive.json` | 18.64 MB | 9,668 | 34,992 |
| `4c8b472e-archive.json` | 10.33 MB | 4,906 | 17,843 |
| `0f20da4f-archive.json` | 4.59 MB | 2,050 | 6,724 |
| **all ten files** | **105.25 MB** | 53,606 | 224,247 |

`season_selection_design.md` §2.2 proposes fetching an organisation's archive
when someone picks a past year. **Fetching 24.99 MB on a phone to look at a 2023
ladder is not viable**, so that design cannot be built as written.

### 1.1 Three quarters of everything is player records

The EFNL archive was 3.93 MB with 9,668 matches and no players before Phase B,
and 18.64 MB with 34,992 players after. That gives, by division:

- a match record ≈ **426 bytes**
- a player record ≈ **441 bytes**

Applying those to the audit's per-season counts — derived, not measured
directly, but from two figures that were:

| Season | core | players | total | players' share |
|---|---|---|---|---|
| EFNL 2026 | 2.21 MB | 7.62 MB | 9.82 MB | 78% |
| EFNL 2025 | 2.05 MB | 7.38 MB | 9.43 MB | 78% |
| YJFL 2022 | 1.51 MB | 4.62 MB | 6.13 MB | 75% |
| SEJ 2025 | 0.31 MB | 0.87 MB | 1.17 MB | 74% |
| **all 18 seasons** | **21.79 MB** | **75.51 MB** | **97.30 MB** | **78%** |

**Every season is roughly three-quarters player records**, and the ratio barely
moves between competitions or years.

### 1.2 The dashboard already loads 26 MB it mostly does not need

The five current files total **26.27 MB**, fetched on every page view. Of that,
**18.87 MB is player records**, which are not read until someone opens Scorers or
a player panel.

This is true today, before any season selector exists. It is the largest single
thing wrong with the storage layout and it has nothing to do with history.

### 1.3 Every run rewrites every file

`store.save()` writes whole organisation files. A results run covering the five
current seasons therefore rewrites all ten files — including 78.98 MB of archived
seasons whose contents cannot have changed. The 2026-08-12 runs show exactly
that: ten files written, every time.

Every one of those is a commit against a repository that has to stay clonable.

---

## 2. The proposal

**One file per season, with player records in a second file beside it.**

```
data/
  core.json                          manifest + cross-organisation keys
  seasons/
    2dcbf383-core.json               matches, roster, gradeMeta, meta
    2dcbf383-players.json            players
    75d8a232-core.json
    75d8a232-players.json
    ...
  grades.json
  org-discovery.json
```

Season ids are PlayHQ's and are globally unique, so the organisation does not
need to be in the path. Thirty-six files for eighteen seasons.

### 2.1 What it gives

**The default page load drops from 26.27 MB to about 5.4 MB.** Five current-season
core files, no player records until they are wanted. That is a change worth
making on its own, for every visitor, today.

**A past year costs 0.3 to 2.2 MB**, not 25. EFNL 2025's core file is 2.05 MB —
smaller than what the dashboard already fetches for EFNL 2026.

**A results run rewrites five files, not ten**, and none of them contains an
archived season. Git stops carrying 79 MB of unchanged data through every commit.

**Players load only when opened.** Scorers for the current season is 7.62 MB for
EFNL — the same bytes as today, just deferred until asked for.

### 2.2 The current/archive distinction goes away

There is no `-current` and `-archive` any more; there is a season, and the
manifest says whether it is retired. That removes the rollover machinery in
`store.js` — the `bucket()` kind switch, `rolledOver`, and the ordering problem
recorded in `storage_ingestion_design.md` §3.2 — because a season's records never
move between files.

`filesForScope()` becomes a direct map: a compName resolves through the manifest
to a season id, and a season id is a filename.

### 2.3 What must not change

`compName` stays exactly as it is. It is half of every match id, every roster key
and every `gradeMeta` key, and none of those are touched here. This is a change
to which bytes live in which file, not to any key.

---

## 3. Migration

A one-time script, offline, no API calls:

1. Read each organisation's `-current` and `-archive` files.
2. Split every record by `compName` → season id, via the manifest.
3. Write `<seasonId>-core.json` and `<seasonId>-players.json` per season.
4. Reassemble from the new files and compare against the source, record by
   record, before anything is deleted.
5. Leave the old files in place as a rollback path, exactly as `data.json` was
   left on 2026-08-11.

A migration that cannot prove it lost nothing is not a migration. The check is
that every record in the old layout appears exactly once in the new one, and that
counts match per season against the audit's figures.

---

## 4. Build order

1. **`store.js` reads and writes the new layout**, with a verification run first.
   All five writers go through it, so this is the change with the widest reach.
2. **The migration script and its verification**, dry run first.
3. **`index.html` loads core files only**, deferring players until Scorers or a
   player panel is opened. This is where the 26 MB becomes 5 MB.
4. **Delete the old organisation files** once a full weekend of scheduled runs
   has passed against the new layout.
5. **Then the year selector**, which at that point is a small change:
   `season_selection_design.md` §2 with a 2 MB fetch instead of a 25 MB one.

Steps 1 and 2 change nothing visible. Step 3 is a large visible improvement with
no new features attached, which makes it easy to attribute if something breaks.

---

## 5. Risks

**Thirty-six files instead of ten.** More HTTP requests when several seasons are
open at once, though never more than the current ten in a normal session.

**A partial migration leaves two layouts.** Mitigated by writing all seasons in
one run and keeping the old files until the new ones are proven.

**`index.html` deferring players changes when Scorers is usable.** There will be
a moment where the tab is open and the data is arriving. That needs a loading
state rather than an empty list, or it reads as a bug.

**The 78% figure is derived**, from two measured points on one organisation. It
is consistent across all five competitions, which is why I trust it — but the
real per-season sizes will only be known after the migration writes them.

---

## 6. What this does not solve

- **Total repository size.** 97 MB of data is 97 MB however it is arranged.
  Splitting stops it being *rewritten* on every run, which is the pressing part,
  but a further backfill would still need a size decision.
- **The concurrent-competition ladder problem.** Unrelated and still open.
- **The 49 unmigrated bye sentinels.** Unrelated and harmless.

---

## 7. Questions, answered 2026-08-12

**Q1 — players split PER SEASON, not per age.**

Three options were weighed:

| | files | one age's scorers | player search |
|---|---|---|---|
| A per season | 18 | 7.62 MB once, then free | works |
| B per season and age | ~350 | ~0.4 MB each time | **breaks** |
| C per season, prefetched | 18 | already loaded | works |

**Player search decides it.** `onPlayerSearch()` filters `S.players` across every
age and competition — it is not scoped. Under B a name in an age the visitor had
not opened would silently return nothing, which reads as missing data rather than
as a loading state. It is a headline control in the sidebar.

B also multiplies the writer's fan-out by about twenty, in the layer that has
already produced four separate data-loss defects, and it improves the
second-largest number while A already fixes the largest: 26.27 MB down to about
5.4 MB on every page view.

The per-age figures in B were estimates. Players are measured per season but not
per age, so a decision resting on them would have rested on arithmetic rather
than a measurement.

**C is a small follow-on if the first Scorers open feels slow** — prefetch the
season's players once the page is idle. Same files, same search behaviour, no
layout change.

**Q2 — `roster` goes in the core file.** It is small (855 entries for EFNL 2026),
needed for every ladder, and splitting it would add a third file per season to
save a fraction of the smallest part.

**Q3 — the old files are deleted**, once a full weekend of scheduled runs has
passed on the new layout. `data/data.json` was left as a rollback path on
2026-08-11 and is still sitting there unread; two dead layouts is one too many,
and §4 step 4 is where this one goes.
