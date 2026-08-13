# The unplayed-round blocker

**Repo:** `markjovic/junior-footy-dashboard`
**Drafted:** 2026-08-13. Revision 2 — §7 answered, the guard is the game date.
**Status:** APPROVED. Build order in §4.
**Scope:** the data-loss half of D1 only. The display questions are excluded and
recorded in §6.

---

## 1. The defect

`fetchGrade()` walks a grade's rounds in list order and stops at line 683:

```js
if (finalGames.length === 0) {
  // Games scheduled but none final — not played yet, stop
  console.log(`scheduled, not yet played — stopping`);
  break;
}
```

The assumption is that a round with games and no results is the leading edge of
the season, so nothing after it can have been played. That holds for a normal
round and fails for a **placeholder** — a fixture occupying a date that will never
be played.

SEJ 2026 U10 has one. Round 10 of `cb7b3db3` (Little Demons U10 Girls A) holds a
single game, `Dummy U10 Girls 1 v Dummy U10 Girls 2`, PENDING, venue TBC, dated
2026-07-12 — the week the Lightning Premiership round robin replaced the normal
fixture. The walk breaks there on every run.

**Measured 2026-08-13** by `probe-concurrent-comps.js` v2:

| Grade | PlayHQ has FINAL in | Stored | Missing |
|---|---|---|---|
| `cb7b3db3` Little Demons U10 Girls A | 1–9, 11, 12, 13, 14 | 1–9 | **11, 12, 13, 14** |
| `a5a8276d` Little Demons U10 Mixed | 1–9 | 1–9 | none *(yet)* |

Eight real games across four rounds, played 19 and 26 July and 2 and 9 August, are
in PlayHQ and not in storage. They will never arrive: the placeholder will not
become FINAL, so the break fires again every run.

`a5a8276d` is blocked identically and has lost nothing only because it has no
round after 10. Same defect, waiting on a fixture.

**Two rounds are blocked today.** This is the first case seen, so how common the
pattern is across the other four organisations is unknown. The fix does not depend
on knowing.

**Visible symptom:** the ladder grade tab reads `A R9`. That is `lastRound`
reporting accurately on incomplete data, not a second defect.

---

## 2. Why the existing guards do not catch it

**The current-round marker**, line 606, stops the walk past the round PlayHQ flags
`current`. In `cb7b3db3` that is round **14**, so R11–R14 are all inside the
cutoff. Not the obstacle.

**The season-ended guard** permits it too: `dates` runs to 2026-08.

**The stalled-partial promotion**, lines 776–800, is the right idea in the wrong
place. It already reasons about a round that will never complete, detected by a
later round having complete results:

```js
const maxCompleteIdx = completeIdx.length ? Math.max(...completeIdx) : -1;
```

But it runs **after** the round loop, on what the loop collected. The break means
the loop never reaches a later round, so `maxCompleteIdx` never rises above the
placeholder and the promotion has nothing to fire on.

---

## 3. The change

**A round with games, none final, whose latest game date is in the past is a
placeholder or an abandonment. Record nothing for it and continue the walk. Dated
today or later, it is genuinely unplayed and the walk stops as it does now.**

```
games exist, zero final:
    latest game date < todayAEST()   -> log and CONTINUE
    otherwise, or no date present    -> log and BREAK (unchanged)
```

**Game dates, not round dates.** Line 597 already records that round-level
`provisionalDates` is untrustworthy — *"it contains data entry errors in PlayHQ
(e.g. Premier Reserve Men R1 shows 2026-11-04 instead of 2026-04-11)"* — so a
guard built on it would be built on a field this repo has already decided not to
trust. Game dates measured clean across all 68 calls of the probe run, present on
non-final games too:

```
PENDING  2026-07-12  Dummy U10 Girls 1 v Dummy U10 Girls 2
FINAL    2026-07-19  Officer JFC U10 Girls v Clyde JFC U10 Girls
```

**No new API calls.** The date is already in the response just read. This is what
makes the date guard better than the three options revision 1 offered: scanning
ahead cost a call per round, a fixed look-ahead needed a constant I would have
invented, and keying on `current` did nothing during a backfill of a retired
season, where no round is flagged current at all. The date works in every case
and costs nothing.

**No new date arithmetic.** `todayAEST()` exists in the engine, and a
`YYYY-MM-DD` string comparison is what the season-ended guard already does at
`latestDate < today`. No `new Date(string)` parsing.

**Late results are deliberately still picked up, and this is by design.** A Sunday
game whose scores are entered on Monday is dated in the past with no final result,
so the rule continues past it. The next round has no results either and the walk
stops there — one extra call, no data loss. The round is re-fetched next run
regardless, because the consecutive scan stops at the gap. **No grace period is
added**: that behaviour is the mechanism that collects late results and must be
preserved rather than tuned away.

**A bye sentinel is not written.** A bye asserts the grade had no game that week.
It did play, in another grade. Writing one would hide the gap from the audit at
the cost of storing something false. The gap is real and stays visible.

**Partial rounds are untouched.** Some-final-some-not keeps its current handling:
re-fetched every run, resolved by the existing stalled-partial promotion. Only the
zero-final case changes.

**One permanent cost, named rather than buried.** Once R11–R14 are stored, the
consecutive-round scan still stops at 9 because R10 is genuinely absent. So this
branch runs on every subsequent run — one extra fixture call per blocked grade,
forever. That is the price of not losing four rounds, and the audit will report a
round gap that never closes.

---

## 4. Files and build order

| # | File | Change |
|---|---|---|
| 1 | `scripts/verify-backfill.js` | §5 assertions. The stub gains a multi-round sequence with a placeholder. |
| 2 | `scripts/lib/results-engine.js` | v15. The date guard at the `finalGames.length === 0` break. |

Tests first; commit 1 alone goes red. Both under `scripts/`, so no root/subfolder
split. No new scripts, no new workflows, no migration, no dashboard change.
`store.js`, `fetch-results.js` and `backfill.js` are untouched — both callers go
through `engine.run()` and neither knows about round walking.

**After committing:** one full non-VIP `fetch-results`, then Audit Data. Expect
R11–R14 of `cb7b3db3` to arrive and the `A` tab to read R14. The LP grades will
NOT be fixed — they are blocked by the season-ended guard, which is §6.

---

## 5. Verification

`verify-backfill.js` executes the real engine against a stubbed network, so the
walk is exercised rather than argued about. The stub currently serves one round
per grade and must serve a sequence.

Every assertion below is a failure path:

- A past-dated placeholder followed by rounds with results: **the later rounds are
  fetched and stored.**
- The placeholder stores **nothing** — no result, no bye, no partial sentinel.
- A **future-dated** round with games and no results still **stops** the walk.
  Without this the fix could pass by never stopping at all.
- A **past-dated** round with games and no results, with **no later round having
  results**, continues and then stops naturally — the late-results case, which
  must keep working.
- A round whose games carry **no date** falls back to the break.
- A **partial** round is still re-fetched and still promoted by existing logic.
- **Idempotency:** a second run adds no duplicate, and the consecutive scan still
  reports 9 rather than 14.

**Could it have failed?** The defect is reintroduced in a copy and the suite must
go red. If it does not, the assertion measures the wrong thing — which has
happened twice already this session, with `lastRoundKey` and with the live-gap
ordering, both caught only by reintroducing the defect.

---

## 6. What this does not fix

Recorded so the fix is not mistaken for resolving D1.

- **LP results merged into the A ladder.** Six teams on 3 games shown alongside
  twelve-game sides on one tab.
- **The Grand Final counting towards a ladder.** PlayHQ shows P=3 for LP teams;
  the dashboard shows P=4.
- **LP grades skipped by the season-ended guard.** Every LP grade's `dates` is
  `2026-07` alone, so from 1 August they are skipped every run. `82eddc54` and
  `a28ae833` have no stored games at all and cannot now acquire any. This is the
  next piece of data loss to design.
- **The mid-season restructure.** Rounds 1–9 of `cb7b3db3` were played by the
  teams now suffixed `- LP`; rounds 11–14 by different team ids with unsuffixed
  names.
- **A ladder P column I cannot reconcile.** Storage holds 9 rounds of `cb7b3db3`
  and 3 games of LP R1 — 9 and 3. The screenshot shows 12 and 4. Not explained,
  and not guessed at.
