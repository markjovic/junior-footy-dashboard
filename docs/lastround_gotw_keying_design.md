# `lastRound` and `gotwFlags` keying

**Repo:** `markjovic/junior-footy-dashboard`
**Status:** BUILT 2026-08-13, Beta 0.165 / engine v14. Revision 3.
**Revisions 1 and 2** proposed a migration script, a workflow and a verification
suite for `gotwFlags`. All three were cancelled once the data was measured. This
revision records what was built and why, not what was proposed.

---

## 1. What was recorded, and what was true

`OUTSTANDING_TASKS.md` D2 described one defect: both keys `age|rawGrade`,
colliding when two competitions share an age and grade name, fixable only with a
data migration.

Three claims, all wrong. There were **two unrelated defects**, they had
**different shapes**, and **neither needed a migration**.

The description had been carried forward unchecked. `store.js`'s own `CORE_KEYS`
comments had the shapes right — `gotwFlags` as `age|round`, `lastRound` as
`age|rawGrade` — and had been right all along. Nobody had read them against the
documents.

---

## 2. `lastRound` — never colliding, never read

**Writer**, `results-engine.js:1340`, the only one:

```js
const key = `${m.age}|${m.rawGrade}`;
```

**Reader**, `index.html:1765`, the only one that uses the value:

```js
const key = `${S.selComp||''}|${age}|${g}`;
```

`g` resolves through `gradesForAge()` → `matchGrade()` → `currentGrade()` →
`rosterGrade()` to `entry.gradeId || entry.grade || rawGrade` — a PlayHQ UUID
with grade identity migration at 99.91%.

Two segments against three, a parsed grade name against a UUID. Never a match.
**The round number on each ladder grade tab rendered as an empty string from
Beta 0.133 until 0.165.** Not a collision: a feature that produced nothing for
months while every test stayed green, because nothing tested it and an absent tag
looks like a grade that has not played yet.

`migrate-grade-ids.js:19` records the re-keying as deferred to build-order step 6
because it needed the engine and the page changed together. Step 6 was marked
done. Only the page half had been done.

**No migration.** `results-engine.js:1326` is `const lastRound = {}` — the map is
rebuilt from scratch and assigned wholesale on every full run, so the old keys
were not data to convert. They are dropped by segment count on the first run.

---

## 3. `gotwFlags` — a real collision, with nothing in it

Key was `age|roundKey`: `U12|3`, `U12|F:GF`. No competition, no season, no grade.
So EFNL 2026 U12 R3, SEJ 2026 U12 R3 and EFNL 2025 U12 R3 were one entry.

The symptom would not have been a wrong game on screen. `getGOTWMatch()` checks
the flagged id is among the current round's matches and falls through to the
automatic closest-margin pick when it is not, so a collision reads as **an
administrator's pick quietly disappearing**.

**No migration**, because there was nothing to migrate. Measured 2026-08-13:
`core.json` held `gotwFlags: {}`, and `localStorage` held no key containing
`gotw`. No pick had ever been made.

`core.json` was empty because **nothing writes it** — no script does, and the page
writes to browser storage only. It would have been empty with a perfect key.
That is a separate open question, not addressed here: picks do not survive a
browser change, and `core.json` overwrites them on load when non-empty.

---

## 4. The keys

| Key | Was | Is |
|---|---|---|
| `lastRound` | writer `age\|rawGrade`, reader `compName\|age\|gradeId` | `compName\|age\|gradeId` |
| `gotwFlags` | `age\|roundKey` | `compName\|age\|roundKey` |

`compName` is `"EFNL 2026"`, so it carries the season as well as the competition.

**A grade suits one and not the other.** For `lastRound` a last home-and-away
round is a property of a grade. For `gotwFlags` a grade would change what the
feature means: Game of the Week is chosen across all grades in an age, with one
nominee per *other* grade.

**The `lastRound` token is the roster's grade, not `m.gradeId`.** The reader's
token is the grade a team counts towards *now*. For a promoted team that differs
from the grade on its old fixtures. `lastRoundKey(m, side, roster)` uses the same
expression the page does.

**Both sides of a match are keyed.** Keying only the home team would leave a grade
whose teams were away in the final round reporting an earlier number.

**Still in `CORE_KEYS`.** Both are in `core.json` *because* they had no
competition. They now have one, so both could move to `PREFIX_KEYS` and live in
their season's file. That is a second migration and has not been decided —
recorded here so the option is not lost.

---

## 5. The scoped-run problem, removed

`writeLastRound` existed because a key with no competition could only be computed
by a run that saw every competition: replacing on a scoped run deleted the others
(measured 2026-08-12: a VIP-only run took `{"U12|A":14,"U14|B":16}` to
`{"U12|A":14}`), and merging made it a ratchet.

With the competition in the key, the treatment is the one `gradeMeta` already
used three lines below: rebuild every competition this run covered, keep every
other exactly as stored. `covered` comes from the grades that came back, not the
competitions requested, so a failed discovery preserves rather than blanks.

The flag is gone from the engine and both callers.

---

## 6. What was built

| File | Change |
|---|---|
| `scripts/lib/results-engine.js` v14 | key, per-competition merge, legacy drop, `lastRoundKey()` exported, `writeLastRound` removed |
| `scripts/fetch-results.js` v3 | stopped passing `writeLastRound` |
| `scripts/backfill.js` v3 | stopped passing `writeLastRound: false` |
| `index.html` Beta 0.165 | `gotwKeyFor()`, five call sites routed through it, `\|\|''` fallback removed |
| `scripts/audit-data.js` v11 | section 9: key shapes and unknown competitions |
| `scripts/lib/store.js` v6 | `CORE_KEYS` comments |
| `scripts/migrate-grade-ids.js` | header comments; no code change — it remaps values, never keys |
| `scripts/verify-backfill.js` v2 | 75 → 94 |
| `scripts/verify-dashboard-grades.js` v2 | 77 → 88 |
| `scripts/verify-audit.js` v2 | 43 → 52 |

No new scripts, no new workflows, no migration.

`OUTSTANDING_TASKS.md` A5 named `fetch-results.js`, which references neither key
and did not change, and omitted `migrate-grade-ids.js`, which does reference
`gotwFlags`. That list was assumed; the one above came from running
`report-field-usage.js`.

---

## 7. What the verification covers, and how it was checked

Every guard below was confirmed by reintroducing the defect and watching the
suite fail.

| Defect reintroduced | Failures |
|---|---|
| Replace instead of merge per competition | 5 |
| Keep legacy two-segment keys | 5 |
| Key `lastRound` on `m.gradeId` instead of the roster | 2 |
| Revert `getGOTWMatch` to the two-segment key | 2 |
| Section 9 reporting no wrong shapes | 2 |

**The third one is the lesson.** The first version of that guard was an inline
closure, and substituting `m.gradeId` for the roster lookup left the entire suite
passing. The network stub serves one grade per season, so no `run()` test can
produce a promoted team. The function was extracted and exported purely so the
case could be reached directly. **A guard that has never fired is untested**, and
this one had to be made testable before it counted.

`verify-dashboard-grades.js` runs the real page script in a `vm` context, so the
GOTW assertions are end to end: no flag → closest margin; old key → ignored; new
key → honoured; another competition's flag → does not leak.

---

## 8. What no suite covers

Whether the round number on a ladder grade tab looks right. It is on screen in a
second, and a regex over `index.html` cannot judge it.
