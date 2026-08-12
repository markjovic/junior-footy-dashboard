<!-- docs/grade_identity_migration.md -->
# Grade Identity Migration — Design Document

**Repo:** `markjovic/junior-footy-dashboard`
**Status:** PROPOSED, NOT APPROVED. Q1 answered by measurement; Q2 and Q3 open.
**Date:** 2026-08-12, amended the same day with the §1.4 record counts and the
`gotwFlags` resolution in §3.1.
**Evidence:** `scripts/report-grade-collisions.js` run on GitHub Actions
2026-08-12 against `data/grades.json` (1,006 grades, 18 seasons), and
`scripts/audit-data.js` v4 run the same day against all ten organisation files.
Every figure below is from a run. Where something is inferred it says so.

Written because `team_registry_design.md` §8 puts re-keying match ids out of its
scope and says it needs its own document. This is that document.

---

## 1. The defect, measured

`parseGradeName` reduces a PlayHQ grade name to an `age` and a `rawGrade`. Where
two grades in one season reduce to the same pair, they become one grade as far as
this repository is concerned.

Measured 2026-08-12 across all eighteen stored seasons:

| Season | Grades | Colliding keys | Grades involved | Shadowed |
|---|---|---|---|---|
| EFNL 2024 | 83 | 1 | 5 | 4 |
| EFNL 2025 | 84 | 1 | 4 | 3 |
| EFNL 2026 | 86 | 1 | 4 | 3 |
| SEJ 2022 | 57 | 12 | 45 | 33 |
| SEJ 2023 | 52 | 7 | 27 | 20 |
| SEJ 2024 | 58 | 9 | 18 | 9 |
| SEJ 2025 | 12 | 0 | 0 | 0 |
| SEJ 2026 | 16 | 2 | 4 | 2 |
| SER 2025 | 40 | 0 | 0 | 0 |
| SER 2026 | 41 | 0 | 0 | 0 |
| WFNL 2024 | 44 | 1 | 2 | 1 |
| WFNL 2025 | 48 | 3 | 8 | 5 |
| WFNL 2026 | 40 | 1 | 3 | 2 |
| YJFL 2022 | 64 | 5 | 10 | 5 |
| YJFL 2023 | 67 | 7 | 14 | 7 |
| YJFL 2024 | 73 | 6 | 15 | 9 |
| YJFL 2025 | 75 | 5 | 18 | 13 |
| YJFL 2026 | 66 | 1 | 6 | 5 |
| **TOTAL** | **1,006** | **62** | **183** | **121** |

"Shadowed" is the count that loses its identity: one grade per key keeps it and
the rest become indistinguishable from it.

**Three seasons have no collisions at all** — SEJ 2025, SER 2025 and SER 2026 —
and a migration can skip them entirely.

### 1.1 What actually causes it

Every collision is a prefix or suffix the parser discards. Four patterns:

- **Geographic or pool suffixes.** `U8 - Eastern`, `U8 - North`, `U8 - South`,
  `U8 - West` all reduce to `U8|`. EFNL, every season.
- **A second league inside one season.** `FDJFL - U11A` beside
  `SEJ - McDonalds U11A`. SEJ 2022 to 2024, and the largest share of the total.
- **Sponsor names in the grade.** `SEJ - Garrleigh Trophies U13 Division 1`,
  `Deakin Uni - U16 Girls`.
- **Session and venue splits.** `U9 Round Robin Carnival - Spotswood Morning
  Session` beside `… Afternoon Session`. WFNL.

The worst single key is YJFL 2025 `U10|`, where nine grades collapse into one.

### 1.2 Two different damages, and they are not the same size

**Ladders are wrong now, and this is the visible defect.** Sixty-two ladders
merge teams from grades that never played each other. A four-way EFNL U8 ladder
is four separate competitions on one table.

**Games are rarely lost.** Two grades sharing a key only lose a game when the
round token and both team names also match. The Phase A backfill measured this
directly: EFNL 2025 reported 5,036 fetched against 5,035 stored, and 2024 the
same by one. Roughly one in five thousand. The `audit-data.js` duplicate check
finds none, because the loser was overwritten rather than duplicated.

So this migration is about grade identity, not about recovering lost games.
Recovering the handful of overwritten games is a consequence, not the purpose.

### 1.3 It also breaks `currentGrade()`

`dashboard_context.md` records six roster warnings of the form
`X (U10 Girls) in both grade  and A in R1 — keeping A`. Two real grades parse to
one key, the team appears in both, and `rebuildRoster` breaks the tie by
preferring the non-empty grade. `currentGrade()` can then return a grade the team
is not in. Fixing match ids alone would not fix this; keying on the grade id
does.

---

### 1.4 How many RECORDS are affected — measured

The grade counts above do not bound the record counts, because grades vary
enormously in size. Measured 2026-08-12 by `scripts/audit-data.js` v5 across all
ten organisation files, 53,545 records:

| Season | Matches | Resolvable offline | In a colliding key | % |
|---|---|---|---|---|
| EFNL 2024 | 4,633 | 4,396 | 237 | 5.1% |
| EFNL 2025 | 5,035 | 4,532 | 503 | 10.0% |
| EFNL 2026 | 5,420 | 4,927 | 493 | 9.1% |
| SEJ 2022 | 3,071 | 646 | 2,425 | 79.0% |
| SEJ 2023 | 3,315 | 1,410 | 1,905 | 57.5% |
| SEJ 2024 | 3,425 | 2,131 | 1,294 | 37.8% |
| SEJ 2025 | 759 | 759 | 0 | 0.0% |
| SEJ 2026 | 785 | 709 | 76 | 9.7% |
| SER 2025 | 2,050 | 2,050 | 0 | 0.0% |
| SER 2026 | 1,969 | 1,969 | 0 | 0.0% |
| WFNL 2024 | 2,362 | 2,338 | 24 | 1.0% |
| WFNL 2025 | 2,544 | 2,480 | 64 | 2.5% |
| WFNL 2026 | 2,098 | 2,098 | 0 | 0.0% |
| YJFL 2022 | 3,722 | 3,064 | 658 | 17.7% |
| YJFL 2023 | 3,273 | 2,520 | 753 | 23.0% |
| YJFL 2024 | 3,104 | 2,365 | 739 | 23.8% |
| YJFL 2025 | 3,071 | 2,464 | 607 | 19.8% |
| YJFL 2026 | 2,909 | 2,799 | 110 | 3.8% |
| **TOTAL** | **53,545** | **43,657** | **9,888** | **18.5%** |

**Pass 1 resolves 81.5% of all records with no API call.** The remaining 9,888
need Pass 2, which is eighteen calls regardless of how many records depend on it.

**Nothing is unresolvable in principle: the "unknown" column is zero in every
season.** Every stored record's `age|rawGrade` reduces from at least one real
grade in `grades.json`, so no record is orphaned and the two-pass approach has
complete coverage available to it. Whether Pass 2 realises that coverage depends
on the registry join, which §4 Pass 2 covers.

**Four seasons need no work at all** — SEJ 2025, SER 2025, SER 2026 and WFNL
2026 — a wider set than the three §1 identified from grade counts alone.

The concentration is extreme and worth planning around. SEJ 2022 and 2023 alone
account for 4,330 of the 9,888, both from the FDJFL merge described in §1.1. The
largest single keys:

```
EFNL 2025  "U8|"          503 records across 4 grades
EFNL 2026  "U8|"          493 records across 4 grades
SEJ 2023   "U10|"         374 records across 5 grades
SEJ 2022   "U9|"          372 records across 7 grades
SEJ 2022   "U10|"         358 records across 7 grades
```

**⚠️ The `audit-data.js` empty-`rawGrade` warning is a poor proxy for this and
should not be used to size the work.** SEJ 2025 raises four of those warnings and
has zero collisions; WFNL 2026 raises five and has zero. An empty `rawGrade` only
matters when two grades share it. Section 7 of the audit is the accurate measure.

---

## 2. Why the parser cannot be fixed instead

The obvious alternative is to make `parseGradeName` keep enough of the name to
stay unique — `U8 - Eastern` becoming `rawGrade: "Eastern"`.

It is rejected for one reason: it is the same mistake again. Every pattern in
§1.1 was already unanticipated once. A parser tuned to these four will meet a
fifth, and the failure will be silent, because a collision produces no error —
just a shorter ladder. The API returns the grade's identity and this repository
throws it away, which `working_practice.md` records as a repeated finding rather
than a one-off.

It is also not cheaper. Any change to `rawGrade` changes every match id, so the
migration cost is identical either way.

---

## 3. The proposed key

**Replace `rawGrade` with the PlayHQ grade id in the match id.**

```
before   compName|age|rawGrade|roundToken|teams
         EFNL 2025|U8||1|Bayswater Gold|Boronia Brown

after    compName|age|gradeId|roundToken|teams
         EFNL 2025|U8|23b5e832|1|Bayswater Gold|Boronia Brown
```

Grade ids are season-scoped — EFNL's Premier Senior Men grade is `6f964e7b` in
2026, `1debae74` in 2025 and `25a4f589` in 2024 — which is correct here, because
`compName` already carries the season and the id only has to be unique within it.

`age` is kept. It is redundant once the grade id is present, but it is what makes
a match id legible in a log and several places already slice the id on it.
Removing it is a separate change with no benefit beyond a smaller file.

**`rawGrade` stays on the record as a display value.** Identity comes from
`gradeId`; the short chip label continues to come from the parser. Both are
stored, and nothing downstream has to choose.

### 3.1 What else has to move

| Thing | Current key | After |
|---|---|---|
| `matches[].id` | `compName\|age\|rawGrade\|round\|teams` | `compName\|age\|gradeId\|round\|teams` |
| `gradeMeta` | `compName\|age\|rawGrade` | `compName\|age\|gradeId` |
| `lastRound` | `age\|rawGrade` | see §7 Q2 |
| `roster` | `compName\|team\|age` | unchanged — carries no grade |
| `gotwFlags` | `age\|roundKey` | see §7 Q2 |

**`gotwFlags` — RESOLVED 2026-08-12 by reading `index.html`.** Both documents
were half right, and neither said both. The key is `age|roundKey` and the VALUE
is a match id:

```js
1338:  const flagKey = `${age}|${rKey}`;          // age|roundKey
1339:  const flaggedId = S.gotwFlags[flagKey];
1815:  const isGotw = S.gotwFlags[gotwKey] === m.id;   // the value is an id
```

So this migration must **rewrite `gotwFlags` values**, mapping each stored match
id to its new one. Its keys are untouched here. The key omitting the competition
stays a separate pre-existing defect, recorded in `storage_ingestion_design.md`
§3 and unaffected either way.

`dashboard_context.md` and `team_registry_design.md` §3.3 both need a one-line
correction to say key and value rather than one or the other.

---

## 4. How stored records get a grade id

This is the part that has to be cheap. Three passes, in order, each handling what
the one before could not.

### Pass 1 — deterministic, offline, no API calls

For every stored match, look up `(compName, age, rawGrade)` in `grades.json`. If
exactly one grade in that season reduces to that pair, the grade id is known with
certainty.

This resolves every record outside the 62 colliding keys. `grades.json` already
holds `id`, `name`, `ageName`, `genderName` and `seasonID` for all 1,006 grades,
and `parseGradeName` is the same function that produced the stored value, so the
mapping is exact rather than approximate.

**Expected to cover the large majority.** How large is not yet measured — see
§7 Q1.

### Pass 2 — the registry, one API call per season

For records in a colliding key, Pass 1 cannot choose between the grades. The
season team registry can: `discoverTeams(filter:{seasonID})` returns every team
with its grade id, so if both teams in a match belong to the same grade, that is
the grade the match was played in.

Eighteen API calls for every season stored. Not a fixture re-crawl.

The join from a stored team name to a registry team is by `age` plus the cleaned
name, and it goes through the grade id rather than a parsed grade name: the
registry gives a team its grade id, `grades.json` gives that grade its `ageName`
and `genderName`, and `parseGradeName` reproduces the stored `age` exactly rather
than re-deriving it from the grade's display name.

**Measured 2026-08-12 by `scripts/probe-team-join.js` v3 against EFNL 2025, 678
distinct (age, team) pairs:**

| | |
|---|---|
| matched to exactly one team | 665 (98.1%) |
| ambiguous, several teams | **0 (0.0%)** |
| no registry team at all | 13 (1.9%) |

Zero ambiguity is the result that makes this approach viable, and it holds across
every age group — the per-age table shows no age with a single ambiguous pair.

**The 13 unmatched are not missing from the registry; they are in it with no
grade.** `Ringwood U11`, `East Ringwood U12`, `Fairpark U14 Girls` and
`Kilsyth U16` appear both in the unmatched list and in the registry's 60
ungraded teams. So the residual is one cause, not several.

An earlier v1 run reported 36% unmatched, all of them senior grades. That was a
defect in the probe's own age handling — its regex recognised only `U`-prefixed
ages — and not in the data. Recorded because the corrected figure would otherwise
look like an unexplained improvement.

### Pass 2 resolves per MATCH, not per team

A match needs only **one** of its two teams to carry a grade. If either resolves,
the match's grade is known. Requiring both to agree would discard information for
nothing, and it is what makes the 1.9% residual smaller still at record level: a
match is only unresolvable when *both* its teams are ungraded in the registry.

Where both teams resolve and disagree — which grading rounds produce by design,
since a team plays across grades before placement — the match falls through to
Pass 3 rather than being guessed. The disagreement is itself the signal.

**How many matches that leaves is not yet measured.** 1.9% of team pairs is not
1.9% of records, and the arithmetic between them depends on how ungraded teams
are distributed across fixtures. Pass 3 must be sized from a dry run, not from
this figure.

### Pass 3 — targeted re-fetch, and only for what is left

Whatever Passes 1 and 2 leave unresolved gets re-fetched from
`discoverFixtureByRound`, scoped to the specific grade and round rather than the
season. `discoverGrade` returns the grade id on the round, so the answer is
authoritative.

**This must be a named list, not a season.** The migration reports exactly which
grade and round combinations it needs before fetching any of them, and the run is
sized from that list. If Pass 3 turns out to be large, that is a signal that
Pass 2 is wrong and worth stopping for, not a reason to re-crawl.

### 4.1 Records that stay unresolved

A record no pass can place keeps its current id and its `rawGrade`, and is
counted and listed. It is better to carry a known-unresolved remainder than to
guess, and the count is the honest measure of how complete the migration is.

---

## 5. Verification

A migration that cannot prove it lost nothing is not a migration.

1. **Record count is unchanged.** Per season, per organisation file, before and
   after. `store.save`'s own loss check already throws if a bucket goes missing,
   but that is a floor rather than a proof.
2. **Every old id maps to exactly one new id.** Built as a map and asserted, not
   assumed.
3. **No two old ids map to the same new id.** This is the one that catches a
   catastrophic error. Currently two grades share a key, so after the migration
   the new ids must be strictly more numerous in the affected seasons, never
   fewer.
4. **Every field except the id and the grade keys is byte-identical.** Compare
   the full record, not the id.
5. **The failure path fires.** Run it against a season with a deliberately
   corrupted `grades.json` and confirm it refuses rather than assigning wrong
   ids.
6. **A dry run reports the full plan before writing anything** — how many
   records each pass resolves, how many remain, and which grade and round
   combinations Pass 3 would fetch.

Written as `scripts/verify-grade-migration.js` with a fixture, in the pattern of
`verify-store.js` and `verify-backfill.js`: seed a known defect, confirm it is
caught, confirm a clean tree passes.

---

## 6. Build order

1. **Establish what `gotwFlags` actually keys on**, by reading `index.html` and
   `fetch-results.js`. Nothing else can be designed correctly until this is
   settled. §3.1.
2. **Measure Pass 1 coverage** — how many stored records sit in a colliding key.
   Read-only, offline, an extension to `audit-data.js`. §7 Q1 depends on it.
3. ~~Re-run `probe-team-join.js` v3~~ — **done 2026-08-12: 98.1% matched, 0%
   ambiguous.** §4 Pass 2.
4. ~~Capture `gradeId` on new records~~ — **done 2026-08-12.** Written by
   `results-engine.js` v3 at all three record-construction sites including the
   bye and partial sentinels, and by `fetch-fixtures.js` v2 on scheduled records.
   Inert: written and unread. Records stored before this date do not carry it,
   which is what Passes 1 to 3 exist to fix.
5. **The migration script and its verification**, dry run first.
6. **`index.html` reads `gradeId`** for grouping and for `currentGrade()`.
   The first visible change.
7. **Retire the `rawGrade` fallback** once no unresolved records remain.

Steps 1 to 4 change no behaviour.

---

## 7. Open questions

**Q1 — ANSWERED 2026-08-12. 18.5% of records, 9,888 of 53,545.** See §1.4. Pass
1 covers the other 81.5% with no API call, nothing is unresolvable in principle,
and Pass 2 is eighteen calls whatever the record count. The remaining unknown is
what fraction of the 9,888 Pass 2 leaves for Pass 3, which the registry join
measurement in §4 Pass 2 determines.

**Q2 — Do `lastRound` and `gotwFlags` get re-keyed in the same pass?** Both are
recorded in `storage_ingestion_design.md` §3 as keyed without a competition, so
both collide across competitions independently of this defect. Folding them in
means one migration instead of two; keeping them separate means a smaller change
to prove. They are in `core.json`, not in the organisation files, so they are not
structurally part of this.

**Q3 — Is a season with no collisions migrated anyway?** SEJ 2025, SER 2025 and
SER 2026 need no correction, but leaving them on the old id shape means two id
formats coexist indefinitely and every reader must handle both. Migrating them
costs a rewrite of records that are already correct.

---

## 8. Not in scope

- **Re-keying `roster`.** Its key carries no grade and is unaffected.
- **The team registry itself.** `team_registry_design.md` owns that. This
  document borrows `discoverTeams` for Pass 2 and nothing more; the two can be
  built in either order.
- **Player records.** Phase B has not been built. It should be built after this,
  not before, so that player records are keyed correctly the first time — see
  the note below.
- **Fixing `parseGradeName`.** §2. It stays as the source of the display label.

**⚠️ Sequencing note.** Phase B writes player statistics for thirteen backfilled
seasons. If it runs before this migration, those records are written against
grade keys that are about to change, and Phase B has to be redone or migrated
alongside. This is the same mistake that has already been made once: the Phase A
backfill discarded the team id that `team_registry_design.md` §3.1 had already
identified as needed, so thirteen seasons of records now lack it.
