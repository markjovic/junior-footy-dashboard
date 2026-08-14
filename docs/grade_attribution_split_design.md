# Grade attribution: grading grades, teams that move, and player stats

**Repo:** `markjovic/junior-footy-dashboard`
**Drafted:** 2026-08-13. Revision 6.
**Status:** APPROVED. §8 is build order. No open questions.
**Supersedes** revisions 1–5. §1 records what was wrong in each, because the
pattern in the errors cost four rewrites and is worth not repeating.

---

## 1. How this arrived here

| Rev | Proposed | Killed by |
|---|---|---|
| 1 | A mid-season split in SEJ 2026 U10 | The pattern spans all 18 seasons |
| 2 | Colliding `age\|rawGrade` keys | SER 2026 has **0** colliding keys and drops 11.0%; WFNL 2026 has 1 and drops 1.3% |
| 3 | Attribute by `m.gradeId` when the grade is **defunct** | Only **38.2%** of drops are in defunct grades |
| 4 | One rule for listing and counting | A separate grading grade is its own competition and needs its own ladder |
| 5 | Rules 3.1/3.2 as below, plus grading Scorers | Player records are stored per grade, not per season — §4 |

Each of my three mechanisms was proposed before the thing it claimed to explain had
been measured. The rules in §2 and §4 are Mark's.

---

## 2. Match records — two rules

### 2.1 A GRADING grade is its own competition

Its games do not count towards the regular season, so it gets its own tab and its
own standalone ladder, and its games count towards **that** ladder.

A team therefore appears on two ladders — grading and division. That is not the
promotion defect; they are different competitions. "One team, one ladder" means one
ladder *per grade series*.

### 2.2 Any other grade — list by `m.gradeId`, count only when both sides agree

| Case | Sides resolve to | Ladder |
|---|---|---|
| Neither team moved | same, equal to `m.gradeId` | counts |
| Both moved to the same grade | same, different from `m.gradeId` | **counts** |
| One team moved | different grades | listed only |
| Both moved, to different grades | different grades | listed only |

The ladder a result counts on is the **teams'** grade, never `m.gradeId`. The
reverted Beta 0.135 attempt (`index.html` line 1223) made the ladder follow
`m.gradeId` and split a promoted team across two division ladders. This does not.

### 2.3 Detecting a grading grade — by NAME

`/grading/i` on the grade name. Nothing structural separates a grading grade from a
mid-season split; the defunct test measured 38% before dying. A competition wording
it differently falls through to §2.2 — degraded, not wrong. SEJ 2026 Little Demons
(`a5a8276d`, 42 records) takes the fallback deliberately.

Case-insensitive substring, because `EFNL 2026 — U12 Girls (Grading)` already shows
the format varies.

---

## 3. Measured scale (audit v14 §10)

```
TOTAL   51973 records   48006 shown   3967 dropped   1514 defunct   2453 live   0 no grade
```

7.6% of all stored records never reach the dashboard, in every season, 1.3% to
12.7%. **Zero have no grade information**, so every drop is a real disagreement.

---

## 4. Player stats — one row per person per season

**The rule.** A player appears **once per season**, listed in the grade they ended
the season in (or are in at the current round), with `gp` and `goals` **summed
across every grade they played in that season**.

### 4.1 What is actually stored contradicts that shape

Measured, audit v14 §11:

```
TOTAL   160158 people   18540 multi   1383 w/ grading   max 4 records
```

**18,540 person-seasons — 11.6% — hold more than one player record**, up to four in
one season. Only 1,383 involve a grading grade, so this is overwhelmingly people
playing in two ordinary grades, not a grading artefact. The examples are a group
moving together:

```
WFNL 2026  6d0104cf-…  2 record(s): ee904d09, 7bfb9c19
WFNL 2026  c26bee37-…  2 record(s): ee904d09, 7bfb9c19
```

`fetch-stats.js` stores **per grade**. So the page must aggregate; the stored shape
is not going to change.

### 4.2 Consequences

**Scorers may currently show a person twice** — once per record — with each row
carrying only that grade's goals. Not verified; it follows from the stored shape and
must be checked by execution before anything is built on it.

**A grading grade gets NO Scorers list.** Its player records fold into the person's
row in their ending grade. §5 of revision 5 said a grading Scorers list could be
built; that is now withdrawn — it can be, and under this rule it must not be.

**Section 8's index sizing is wrong.** It counts records, not person-seasons:

| | Reported | Correct |
|---|---|---|
| Rows | 179,620 | **160,158** |
| Seasons per person | 2.54 | **2.27** |

19,462 rows overstated. **D4's 5.67 MB estimate is built on the inflated figure**
and needs recomputing before that decision is taken.

### 4.3 Retraction

I said `playerGrade()` was defective for preferring the roster over `p.gradeID`,
calling it the mirror of the match defect. **That was wrong.** The roster gives the
grade a player ended in, which is exactly what this rule wants. The precedence is
correct and must not be inverted. What is missing is aggregation, not attribution.

---

## 5. What changes in `index.html`

`precomputeMatches` computes two values; it needs three.

- `_valid` — already §2.2's eligibility test. **Unchanged.**
- `_grade` — becomes the LISTING grade: `m.gradeId`, falling back to the roster
  grade then `rawGrade`.
- `_ladder` — new. `m.gradeId` for a grading grade per §2.1; otherwise the teams'
  agreed grade; otherwise none.

**`matchGrade()` splits in two.** Its seventeen call sites do not all mean the same
thing: 1384 wants the ladder grade; 1853, 1878, 2027, 2035 and 3953 want the listing
grade; 2051 and 3069 already branch on validity. A single ambiguous `matchGrade()`
is how the two meanings were conflated, so the rename is the point.

**1629 and 2851** build the set of grades that get a tab. A record now contributes
two, and both must produce one.

**Scorers must aggregate per person per season** before rendering: group by `uuid`,
sum `gp` and `goals`, and take the grade from `playerGrade()` on the record for the
latest round.

---

## 6. Consequences to expect

- Ladders will show uneven games-played counts, correctly. It looks like the SEJ
  symptom that started this, so it must not read as broken.
- New grade tabs appear for grading grades, with a ladder and results but no Scorers.
- A team appears on two ladders where a separate grading grade exists. Intended.
- Nothing is migrated, deleted or re-keyed. Reversible.

---

## 7. Verification

`verify-dashboard-grades.js` runs the real page in a `vm`. Every assertion is a
failure path:

- Neither team moved → counts, listed under `m.gradeId`.
- **Both moved to the same grade → COUNTS.** The case the current code loses.
- One team moved → listed, not counted; the mover is on exactly one division ladder.
- A grade matching `/grading/i` → its own ladder, its games count there.
- A grade not so named whose teams all moved → fallback, no ladder, results listed.
- **A promoted team appears on ONE division ladder** — existing assertion, must still
  pass unchanged. If it fails, this is Beta 0.135 again.
- **A player with two records in one season appears ONCE in Scorers**, with summed
  `gp` and `goals`, in the grade of their latest round.
- `render()` does not throw on a grading tab with no Scorers.
- `precomputeMatches` runs after the roster on all three load paths.

`audit-data.js` §10 is the measure of success: `shown` should rise by most of 3,967.

---

## 8. Build order

1. `verify-dashboard-grades.js` — §7 assertions. Red until step 2.
2. `index.html` — §5. Version badge.
3. `audit-data.js` — correct §8's sizing to count person-seasons, not records.
4. Run **Rebuild grade meta**; confirm grading grades have labels.
5. Run **Audit Data**; compare §10 against §3.

Steps 1 and 2 span `scripts/` and the repo root, so tests commit first.

**Also outstanding, unrelated:** `verify-audit.js` has no assertions for §11 — the
fixture's player records lack a `uuid`, so a first attempt passed vacuously. §11's
figures should be treated as unverified until that is fixed.
