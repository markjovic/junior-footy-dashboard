<!-- docs/team_registry_design.md -->
# Team Registry and Identity — Design Document

**Repo:** `markjovic/junior-footy-dashboard`
**Status:** DRAFT FOR APPROVAL. Nothing is built until this is approved.
**Revision:** 2026-08-11. Supersedes the 2026-08-10 draft, which was wrong about
`discoverCompetitions` and consequently ruled out work that is achievable.
**Evidence:** `scripts/probe-search.js` and `scripts/discover-orgs.js`, run on
GitHub Actions 2026-08-11, `afl` tenant, guest session. Every figure below is
from a run, not an estimate, unless it says otherwise.

---

## 1. What changed since the previous draft

**1.1 The `discoverCompetitions` retraction.** The previous §1.5 stated that it
fails from a guest session and that "the multi-season work must not depend on
it." That was a misdiagnosis. It works. The cause of the earlier failure was the
request: `seasons` takes a required `organisationID` argument, and
`organisationID` must be the 8-character organisation code rather than the UUID.

A controlled comparison, one run, one session, one organisation (EFNL
`383836bb`), varying only the document and the id form:

| Document | organisationID | Result |
| --- | --- | --- |
| `seasons(organisationID:)` | `383836bb` | 1 competition, 3 seasons |
| `seasons(organisationID:)` | full UUID | `Organisation could not be found.` |
| bare `seasons` | `383836bb` | `There was an error. Please try again later.` |
| bare `seasons` | full UUID | `Organisation could not be found.` |

Rows 1 and 3 differ only in the argument. The error in row 3 is the exact error
previously attributed to the session tier.

**1.2 `discoverTeams` works for COMPLETED seasons.** This is the fact that makes
multi-season work possible at all, and it was assumed false. EFNL's three
seasons in one run:

| Season | Status | Teams | With a grade | Distinct organisations |
| --- | --- | --- | --- | --- |
| 2026 `2dcbf383` | ACTIVE | 969 | 687 | 60 |
| 2025 `75d8a232` | COMPLETED | 725 | 665 | 58 |
| 2024 `ca9cc98b` | COMPLETED | 641 | 618 | 56 |

The active-seasons-only restriction documented for `discoverFixtureByRound` does
not apply here.

**1.3 `organisation` on a team is the CLUB, not the league — now verified.** One
EFNL season returns 60 distinct organisations; the league would be one. The names
confirm it outright: `Blackburn (Eastern Football Netball League)`. This closes
the open lead carried in `dashboard_context.md`.

**1.4 The team's `organisation.id` is the 8-character form** on all 2,335 team
records across the three seasons, so it joins directly to
`discoverOrganisation(code:)` and `discoverCompetitions(organisationID:)` with no
conversion. Note it differs from the `search` result, where `id` is the UUID and
the short form is `routingCode`.

**1.5 Season status has three values, not two.** `COMPLETED` (2,138), `ACTIVE`
(292) and `UPCOMING` (50) across 713 organisations. `UPCOMING` had not been seen
before this run.

**1.6 A season's `startDate` precedes the year in its name.** EFNL's 2026 season
runs `2025-10-01` to `2026-09-30`. Never derive a season's year from its dates.

**1.7 Everything the previous draft established still holds** — grade names come
back verbatim, teams without a grade are practice and unassigned entries, no team
is registered to a Grading grade, and 27 of the 45 clubs in EFNL's U18 Girls
grading pool are not registered in EFNL at all.

---

## 2. The problems this solves

Three defects share one root cause: **team identity is derived from a display
name instead of read from the API.**

- **`parseGradeName` collapses 17 grades into 5 keys** (`OUTSTANDING_TASKS` item
  6), so four U8 grades share one match-id namespace.
- **27 non-member clubs sit in `data.json` as EFNL**, appearing in the team
  dropdown, roster, `teamClub` and the finals view's club list.
- **Club identity is derived from Cloudinary logo URLs**, a workaround for a
  field that is now proven to exist.

A fourth is now solvable and was previously thought not to be:

- **`config.json` carries hand-maintained `seasonID` values.** Every one can be
  read from `discoverCompetitions`, along with every prior season.

---

## 3. Proposed design

### 3.1 Capture the team id on every match record

```
hTeamId: "6e7cd43f"
aTeamId: "8e30b227"
```

Both fetchers already select `id` inside the `DiscoverTeam` spread and discard
it. This is a capture change, not a query change.

**Match ids do not change.** They keep their current
`compName|age|rawGrade|round|teams` form, so no stored record is orphaned and no
migration is needed. The team id is an additional field used for joining, not for
keying. Re-keying match ids remains out of scope — see §8.

Provisional sides have no id, so the field is simply absent, consistent with how
`provisional` already works.

### 3.2 A season team registry

New script `fetch-teams.js`, one `discoverTeams` call per season, writing:

```
teams: {
  "6e7cd43f": {
    name:     "Norwood U8 Purple",
    comp:     "EFNL 2026",
    seasonId: "2dcbf383",
    grade:    "U8 - West",
    gradeId:  "f403b995",
    org:      "6d405ccb",
    orgName:  "Norwood (Eastern Football Netball League)",
    age:      "U8",
    gender:   "BOYS"
  }
}
```

Keyed by team id. Roughly 2,400 entries for the five current competitions; a few
hundred KB against a 36.6 MB `data.json`.

Merged **per competition**, as `gradeMeta` and `grades.json` already are, so a
VIP-only run cannot delete the other four.

**`org` is the club**, read from the API rather than derived, per §1.3.

### 3.3 Season discovery

New script `discover-seasons.js`, one `discoverCompetitions` call per
organisation, writing the competitions and seasons for the organisations named in
`config.json`.

`config.json` stops carrying `seasonID` and carries the 8-character organisation
code instead. The current season is the one whose status is `ACTIVE`, with
`UPCOMING` taking over at the turn of the year. Past seasons become available as
a by-product, which is what the multi-season work needs.

This is the smallest possible use of §1.1. It deliberately does not enumerate
every organisation — see §8.

### 3.4 What the dashboard does with it

**Registration.** A team is a member of a competition if its id is in `teams`.
Anything else is a visitor. Visitors are excluded from the ladder, team dropdown,
roster and club list, but **their results are still shown**, so a grading game
against a visiting club appears in Results with the opponent named. This is the
answer given to Q1 on 2026-08-11.

**Grade.** `teams[id].grade` is authoritative where present. `parseGradeName`
remains the fallback for records with no team id, which is every record written
before this change.

**Club.** `teams[id].org` supersedes the logo derivation.
`build-club-index.js` is retired once coverage is confirmed, not before.

### 3.5 Effect on the Grading ladder

Once teams are graded, the Grading grade contains only teams whose current grade
never moved, which the probe shows are the visitors. Excluding non-registered
teams leaves nothing eligible, so **the Grading chip disappears after grading
concludes**. During April and May it behaves as it does now: every team's current
grade genuinely is Grading, and the ladder is complete and correct.

**Grading results that count keep counting.** A grading game between two teams
that both end up in A/B is already counted in the A/B ladder — verified by
execution. Nothing here changes that.

### 3.6 Session handling

Adopt the documented pattern in every script that calls the API: all three
cookies in the order `phq_tier; phq_session; phq_sub`, ten attempts with backoff,
two alternating query shapes. `probe-search.js` and `discover-orgs.js` already
use it and acquired a session on the first attempt on every run. Independent of
everything above and worth taking on its own.

---

## 4. Answered questions

**Q1 — What is a visitor allowed to appear in?** *Answered 2026-08-11.* Results
still show, with the opponent named. Visitors are excluded from the ladder, team
dropdown, roster and club list. The finals by-club case resolves itself: a club
registered in a competition we crawl is a member there, so the exclusion only
ever hides it from a competition it never belonged to.

---

## 5. Open questions

**Q2 — Should the registry drive grade names in the UI?** PlayHQ's
`"Deakin Uni - U18 Girls - A/B"` is more accurate but far longer than the current
`"A/B"` chip. Keep the parsed short form for display and use the registry only
for identity and grouping, or show the real name somewhere?

**Q3 — What about records with no team id?** Everything currently stored. They
fall back to `parseGradeName` and name-based club lookup, so two mechanisms run
side by side indefinitely unless there is a backfill. §1.2 changes the cost of
this: because `discoverTeams` works on completed seasons, a backfill no longer
needs fixtures re-crawled round by round — the 2024 and 2025 registries can be
fetched in one call each and joined to stored records by name. Accept the split,
or schedule a backfill?

**Q4 — Does this retire `gradeMeta`?** Grade *rank* still comes from the order
grades are returned in, which the registry does not provide. Level and gender do
come from it. Keep `gradeMeta` for rank, or keep it whole for simplicity?

**Q5 — How many competitions is this for?** New, and it governs Q2 to Q4.
`data/org-discovery.json` now lists 1,175 AFL associations, of which 77 are
Victorian and active. The dashboard covers five. This document assumes the
five stay, with season ids discovered rather than typed. Expanding the set is a
separate decision with a hard constraint attached — see §8.

---

## 6. Build order

1. **Session handling** — independent, low risk, benefits every call.
2. **`discover-seasons.js` + workflow** — writes competitions and seasons for the
   configured organisations. Changes no existing behaviour.
3. **`fetch-teams.js` + workflow** — writes `teams`. Verifiable on its own.
4. **Capture `hTeamId`/`aTeamId`** in both fetchers. Still changes no behaviour;
   the field is written and unused.
5. **Dashboard reads the registry** — registration filtering first, since it is
   the visible fix, then grade, then club.
6. **Retire `build-club-index.js`** once club coverage from the registry is
   confirmed at least as good as the logo derivation.

Steps 1 to 4 are inert. The first visible change is step 5, by which point the
data has been in place long enough to inspect.

---

## 7. Ownership

`dashboard_context.md`'s ownership table needs three rows added. Never
cross-write.

| Writer | Owns |
| --- | --- |
| `discover-orgs.js` | `data/org-discovery.json` |
| `discover-seasons.js` | `seasons`, `competitions` |
| `fetch-teams.js` | `teams` |

---

## 8. What is explicitly not in scope

- **Re-keying match ids.** That is the multi-season identity question and needs
  its own document.
- **Backfilling team ids into existing records.** Q3 above.
- **Enumerating every organisation into the dashboard.** This is the important
  one, and it has a hard limit rather than a preference behind it.

  `data.json` is 36.6 MB for five competitions, roughly 7 MB each. **GitHub
  refuses any file over 100 MB**, which puts a ceiling near thirteen competitions
  on the current single-file shape. Seventy-seven Victorian active associations
  would be somewhere around 500 MB. That figure is an extrapolation from the
  per-competition average, not a measurement, but the ceiling is not — no amount
  of tuning gets a single committed `data.json` past 100 MB.

  Covering more competitions therefore requires splitting storage per competition
  or per season and loading on demand. That is a storage redesign, it is
  independent of team identity, and folding it in here would make neither
  decision reviewable. It needs its own document.

- **Non-junior competitions.** Of the 77 Victorian active associations, many are
  Masters, representative or inclusion competitions. Any expansion needs a
  definition of what belongs in a junior footy dashboard before it needs code.
