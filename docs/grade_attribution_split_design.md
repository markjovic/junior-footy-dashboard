# Grade attribution across a mid-season split

**Repo:** `markjovic/junior-footy-dashboard`
**Drafted:** 2026-08-13
**Status:** awaiting approval of §6. Nothing is built until that is answered.
**Companion:** engine v16 (`gameId` supersede) fixes the *rename duplicate*. This
document is the other half — where 42 real games are being silently dropped.

---

## 1. What was measured

`probe-concurrent-comps.js` v3, SEJ 2026 U10, 2026-08-13:

```
212 stored record(s) in this age
150 record(s) count towards a ladder, 42 are DROPPED because the two
sides resolve to different grades
```

**20% of the records in one age group never reach the screen**, and nothing
reports it. `precomputeMatches()` sets `_valid = (hg === ag)` and every ladder,
scorer list and grade tab filters on it. A record whose two sides resolve to
different grades is discarded with no error and no count.

### 1.1 The cause

`a5a8276d` (Little Demons U10 Mixed) ran rounds 1–9 as **one 16-team
competition**. At the July restructure it split into `b5f90cc8` (Mixed Blue) and
`c7b922d4` (Mixed Red), eight teams each, which then played rounds 11–14.

`rebuildRoster()` keeps **one grade per team**, taken from its latest round. So
every team now resolves to Blue or Red. Any round 1–9 game between a Blue-bound
side and a Red-bound side therefore has `hg !== ag` and vanishes:

```
R3  stored a5a8276d  Cranbourne JFC Mixed Blue -> b5f90cc8
                   v Clyde JFC Mixed Yellow    -> c7b922d4
```

### 1.2 What the ladders look like now

| Ladder | Teams | Games-played spread |
|---|---|---|
| `b5f90cc8` Mixed Blue | 8 | 9, 10, 11, 12, 13 |
| `c7b922d4` Mixed Red | 8 | 7, 10, 11, 12 |
| `a5a8276d` Mixed | 17 | 0, 1 |
| `cb7b3db3` Girls A | 12 | 4, 12, 15, 16 |

Every one of these is wrong. Blue and Red carry uneven counts because each team
keeps only the round 1–9 games whose opponent happened to end up in the same half.
`a5a8276d` is **pure artefact** — 17 rows on 0 or 1 game, consisting entirely of
the rename duplicates that v16 stops creating.

### 1.3 The Girls A ladder is a different shape and must not be conflated

`cb7b3db3` was not split. Its 12 rows are 6 real sides plus 6 `- LP` sides, which
are the *same clubs* under renamed team ids. That is the rename problem, and v16
plus a one-off cleanup (§5) resolves it without any of the below.

**Only `a5a8276d` → `b5f90cc8`/`c7b922d4` is a split.** The fix must not treat a
rename as a split or vice versa.

---

## 2. The tension

Two rules, each correct in its own case, and they disagree here.

**One team, one ladder.** A promoted team must not appear on two ladders. This is
why `matchGrade()` reads the roster rather than `m.gradeId`, and
`verify-dashboard-grades.js` asserts it. Switching attribution to `m.gradeId`
would reintroduce the defect the rule exists to prevent.

**History belongs to the grade it was played in.** A round-3 game played in
`a5a8276d` was a game in `a5a8276d`. Attributing it to a grade that did not exist
in round 3 is what produces the dropped records.

The difference is what happened to the *old* grade:

| | Promotion | Split |
|---|---|---|
| The team | moves to a new grade | moves to a new grade |
| The old grade | keeps playing, without it | stops playing entirely |
| Correct attribution | current grade, all history | grade at time of play |

**That is a measurable distinction, and it is the crux.** In a promotion the old
grade has later rounds with games. In a split it does not: `a5a8276d`'s last round
with any game is 9, and rounds 11–14 have none.

---

## 3. Options

**Option 1 — attribute by `m.gradeId` when the stored grade is closed.**
A grade is *closed* if it has no games in any round after the record's own round.
Then a round-3 `a5a8276d` game is attributed to `a5a8276d`, both sides agree, and
nothing is dropped. A promoted team's old grade is still open, so the existing
roster behaviour is untouched and one-team-one-ladder holds.

Cost: `a5a8276d` gains a real 9-round ladder for its 16 original teams, and Blue
and Red show 4 rounds each. Three ladders where there is now one and a half. The
age group gains a grade tab.

**Option 2 — attribute by `m.gradeId` always, and enforce one-team-one-ladder at
the tab level rather than the record level.** A team appears on each ladder it
genuinely played in, and the "promoted team on two ladders" rule is re-expressed
as "a team's *current* grade is the one its tab defaults to". Cleaner in principle,
and it invalidates an existing verification assertion, so it needs that assertion
rewritten rather than deleted — which is the kind of change that has previously
been done for the wrong reason.

**Option 3 — leave attribution alone and only stop the silent drop.** Count the
dropped records and surface them in `audit-data.js`, changing no display. Smallest
possible change; the 42 games stay off the screen but stop being invisible.

**Option 4 — merge the split grades.** Treat Blue and Red as continuations of
`a5a8276d` and show one 16-team ladder across all 14 rounds. Rejected: rounds
11–14 were played in two separate competitions, so a combined table would assert
games that were never possible.

---

## 4. Recommendation

**Option 3 first, then Option 1.**

Option 3 is honest and cheap and can ship immediately: the audit reports the drop
count per grade, so this stops being a thing found only by writing a bespoke probe.
It also gives a number to watch — if the count is near zero everywhere but SEJ
U10, Option 1's blast radius is one age group rather than the whole dataset.

Option 1 is the real fix, and it should not be built until that number is known
across all five organisations and all eighteen seasons. The "closed grade" rule is
sound reasoning about SEJ 2026 U10 and **has not been tested against anything
else**. Small-sample inference is exactly what this repo's working practice warns
about, and I have already been wrong twice this session by reasoning ahead of
measurement.

---

## 5. Prerequisite: clean up the existing rename duplicates

Engine v16 stops new ones. The ones already stored have no `gameId`, so v16
cannot match them and they persist.

A safe one-off rule exists: **within a (gradeId, round) where at least one record
carries a `gameId`, any record without one is superseded.** A round that has been
re-fetched under v16 has a `gameId` on every real game, so anything lacking one is
a pre-v16 leftover. Needs its own script and verification; the rule is recorded
here so it is not reinvented.

**Do not use "the API round response is authoritative" as the cleanup rule.**
`dashboard_context.md` §8 states `discoverFixtureByRound` returns 0 games for
completed rounds fetched in a prior run. The probe run of 2026-08-13 **contradicts
that** — all 68 calls re-served full game lists for completed rounds, including
rounds 1–9 of `a5a8276d`. One of those is wrong, and a deletion mechanism must not
be built on a contested premise. Resolving that contradiction is its own task.

---

## 6. Open question

**Do you want Option 3 now — the audit reporting dropped records — and Option 1
deferred until the count is known across all organisations and seasons?**

If yes, the next delivery is `audit-data.js` v13 plus `verify-audit.js`, reporting
per grade: records stored, records that count, records dropped, and the grades each
dropped record's two sides resolve to. Read-only, no display change, no migration.

If you would rather go straight to Option 1, say so and I will write the build
design — but I would want the drop count measured first even then, because it
decides whether this is one age group or a systemic problem.
