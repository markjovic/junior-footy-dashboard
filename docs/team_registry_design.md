<!-- docs/team_registry_design.md -->
# Team Registry and Identity — Design Document

**Repo:** `markjovic/junior-footy-dashboard`
**Status:** DRAFT FOR APPROVAL. Nothing is built until this is approved.
**Date:** 2026-08-10
**Evidence:** `probe-team-grades.js` and `probe-api-session.js`, both run 2026-08-10.

---

## 1. What the probes established

Measurements, not inferences.

**1.1 `discoverTeams(filter: {seasonID})` works without an organisation.** One
call per season returns every registered team with its grade and owning
organisation. Across the five competitions: **2,399 teams in five calls.**

| Competition | Teams | With a grade | Organisations |
|---|---|---|---|
| EFNL 2026 | 969 | 687 | 60 |
| WFNL 2026 | 558 | 326 | 36 |
| YJFL 2026 | 447 | 442 | 29 |
| SER 2026 | 286 | 284 | 41 |
| SEJ 2026 | 139 | 130 | 15 |

Teams without a grade are practice-match and unassigned entries
(`"East Ringwood Senior Men Practice Match Team"`). They are registered but not
competing.

**1.2 Grade names come back verbatim.** `"U8 - West"`,
`"Deakin Uni - U18 Girls - A/B"`, `"U13 Mixed Premier Division"` — the same
strings `parseGradeName` currently tries to reconstruct from a match record.

**1.3 Registration is the discriminator we were missing.** Of the 45 clubs
appearing in EFNL's U18 Girls grading pool, **27 are not registered in EFNL's
season at all** — Fitzroy (YJFL), Narre North (AFL South East), Mornington,
Mt Eliza, Sorrento, Pearcedale Baxter, Frankston, Berwick, Officer, Heidelberg,
Macleod, North Brunswick, Kew Rovers, Warrandyte, Surrey Park, Camberwell and
others. They play grading fixtures hosted by EFNL while being registered
elsewhere.

**1.4 No team is registered to a Grading grade.** Every one of the 18 EFNL clubs
has its U18 Girls team registered to `Deakin Uni - U18 Girls - A/B` or `- C`.
Grading is a fixture-only seeding pool, not a competition anyone belongs to.

**1.5 `discoverCompetitions` is not usable from our scripts.** It failed
identically across five variations — one cookie, three cookies, with and without
`operationName`, and the full document the website sends. The cause is not the
session. Most likely it requires an authenticated tier; ours is
`phq_tier=cookie-no-jwt`. **The multi-season work must not depend on it.**

**1.6 Our session handling is unreliable.** A single attempt returned **zero**
cookies; the reference's method obtained all three on attempt 4. Our scripts try
five times, accept `phq_session` alone, and otherwise proceed with no session.

---

## 2. The problem this solves

Three defects share one root cause: **team identity is derived from a display
name instead of read from the API.**

- **`parseGradeName` collapses 17 grades into 5 keys** (`OUTSTANDING_TASKS` item
  6). `"U8 - Eastern/North/South/West"` all yield an empty grade, so four grades
  share one match-id namespace.
- **27 non-member clubs sit in `data.json` as EFNL**, appearing in the team
  dropdown, the roster, `teamClub` and the finals view's club list.
- **Club identity is derived from Cloudinary logo URLs**, which works but is a
  workaround for a field we now know exists.

The PlayHQ team `id` is requested on `DiscoverTeam` by both fetchers and
discarded by both — the same pattern as `isFinalsRound`, `abbreviatedName` and
`organisation` before it.

---

## 3. Proposed design

### 3.1 Capture the team id on every match record

```
hTeamId: "6e7cd43f"
aTeamId: "8e30b227"
```

Both fetchers already select `id` inside the `DiscoverTeam` spread. This is a
capture change, not a query change.

**Match ids do not change.** They keep their current `compName|age|rawGrade|round|teams`
form, so no existing record is orphaned and no migration is needed. The team id
is an additional field used for joining, not for keying. Re-keying match ids is a
separate, larger decision and is explicitly **out of scope here**.

Provisional sides have no id, so the field is simply absent — consistent with
how `provisional` already works.

### 3.2 A season team registry

New script `fetch-teams.js`, one `discoverTeams` call per competition, writing:

```
teams: {
  "6e7cd43f": {
    name:  "Norwood U8 Purple",
    comp:  "EFNL 2026",
    grade: "U8 - West",
    gradeId: "f403b995",
    org:   "6d405ccb",
    orgName: "Norwood (Eastern Football Netball League)",
    age:    "U8",
    gender: "BOYS"
  }
}
```

Keyed by team id. Roughly 2,400 entries; at the sizes observed that is a few
hundred KB against a 36.6 MB `data.json`.

Merged **per competition**, as `gradeMeta` and `grades.json` already are, so a
VIP-only run cannot delete the other four competitions.

### 3.3 What the dashboard does with it

**Registration.** A team is a member of a competition if its id is in `teams`.
Anything else is a visitor. Visitors are excluded from the ladder, the team
dropdown, the roster and the club list — but **their results are still shown**,
so a grading game against a visiting club appears in Results with the opponent
named.

**Grade.** `teams[id].grade` is authoritative where present. `parseGradeName`
remains as the fallback for records without a team id, which is every record
written before this change.

**Club.** `teams[id].org` supersedes the logo derivation. `build-club-index.js`
is retired once coverage is confirmed, not before.

### 3.4 Effect on the Grading ladder

Once teams are graded, the Grading grade contains only teams whose current grade
never moved — which the probe shows are the visitors. Excluding non-registered
teams leaves nothing eligible, so **the Grading chip disappears after grading
concludes**.

During April and May it behaves exactly as it does now: every team's current
grade genuinely is Grading, the ladder is complete and correct, and it is the
live competition.

**Grading results that count keep counting.** A grading game between two teams
that both end up in A/B is already counted in the A/B ladder — verified by
execution, not assumed. Nothing in this design changes that.

### 3.5 Session handling

Adopt the documented pattern in every script that calls the API: all three
cookies in the order `phq_tier; phq_session; phq_sub`, ten attempts with
backoff, and two alternating query shapes because PlayHQ intermittently returns
no `Set-Cookie`. Independent of everything above and worth taking on its own.

---

## 4. Open questions

**Q1 — What is a visitor allowed to appear in?** Excluded from ladder, dropdown,
roster and club list is proposed. Should a visiting club appear in the finals
view's by-club mode if it reaches finals in a competition we do crawl elsewhere?

**Q2 — Should the registry drive grade names in the UI?** PlayHQ's
`"Deakin Uni - U18 Girls - A/B"` is more accurate but far longer than the current
`"A/B"` chip. Keep the parsed short form for display and use the registry only
for identity and grouping, or show the real name somewhere?

**Q3 — What about records with no team id?** Everything currently stored. They
fall back to `parseGradeName` and name-based club lookup, so two mechanisms run
side by side indefinitely unless there is a backfill. Backfilling means
re-crawling fixtures for every stored round. Accept the split, or schedule a
backfill?

**Q4 — Does this retire `gradeMeta`?** Grade *rank* still comes from the order
grades are returned in, which the registry does not provide. Level and gender do
come from it. Keep `gradeMeta` for rank, or keep it whole for simplicity?

---

## 5. Build order

1. **Session handling** — independent, low risk, benefits every call.
2. **`fetch-teams.js` + workflow** — writes `teams`, changes no existing
   behaviour. Verifiable on its own.
3. **Capture `hTeamId`/`aTeamId`** in both fetchers. Still changes no behaviour;
   the field is written and unused.
4. **Dashboard reads the registry** — registration filtering first, since it is
   the visible fix, then grade and club.
5. **Retire `build-club-index.js`** once club coverage from the registry is
   confirmed at least as good as the logo derivation.

Steps 1 to 3 are inert. The first visible change is step 4, by which point the
data has been in place long enough to inspect.

---

## 6. What is explicitly not in scope

- **Re-keying match ids.** That is the multi-season identity question and needs
  its own document.
- **`discoverCompetitions`.** Not usable; season ids stay in `config.json`.
- **Backfilling team ids into existing records.** Q3 above.
