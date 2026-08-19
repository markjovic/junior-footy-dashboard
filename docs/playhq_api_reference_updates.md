<!-- NOT a repo file. Replacement text for docs/playhq_api_reference.md. -->
<!-- Shared with sports-players-stats — apply to both copies or they drift. -->
<!-- Drafted 2026-08-11. Evidence: scripts/probe-search.js, run 2026-08-11 on -->
<!-- GitHub Actions, afl tenant, guest session, 49 probes in a single run.    -->

# Updates to playhq_api_reference.md

Everything below was measured in one run. Where something is inferred rather
than measured it says so.

---

## 1. Add to the change log, at the top

> - **2026-08-11 (RETRACTION — `discoverCompetitions` DOES work from a guest
>   session):** the 2026-08-10 entry saying it fails across every variation, and
>   the instruction that "the multi-season work must not depend on it", were
>   **WRONG**. The cause was the request, not the session tier: `seasons` takes a
>   required `organisationID` argument, and `organisationID` must be the
>   8-character organisation code rather than the UUID.
> - **2026-08-11:** a **third endpoint** exists, `https://search.playhq.com/graphql`,
>   serving the `search` operation. It is not on `api.playhq.com`. It needs no
>   cookie and no tenant header.
> - **2026-08-11:** `discoverOrganisation` works from a guest session on the
>   `afl` tenant and returns a full postal address. The "returns null for guest
>   sessions" limitation is `basketball-victoria` behaviour only.
> - **2026-08-17:** **grading pools are shared between leagues**, and their games
>   are recorded under the HOST competition. A competition's own records therefore
>   contain games played by teams belonging to clubs in other associations. Neither
>   `compName` nor `organisation` is wrong; the two simply cannot be combined to
>   mean "a team that entered this competition".
> - **2026-08-18:** `gameStatistics` returns a player's games across EVERY team
>   they played for, while `fetch-stats.js` stores one record per grade. A person
>   with two teams has one live list and two stored records.

---

## 2. Endpoints table — add a third row

| Endpoint | Purpose |
| --- | --- |
| `https://api.playhq.com/graphql` | Main API — all queries except live scoring and search |
| `https://spectator.playhq.com/graphql` | Live e-scoring + hidden game scores |
| `https://search.playhq.com/graphql` | Organisation directory search. **`search` does not exist on the main API** — asking for it there returns `Cannot query field "search" on type "Query"` |

---

## 3. New section — `search` (search.playhq.com)

### search — organisation directory

Powers `https://www.playhq.com/afl?page=1&types=ASSOCIATION`.

```
query search($filter: SearchFilter!) {
  search(filter: $filter) {
    meta { page totalPages totalRecords }
    results {
      ... on Organisation {
        id routingCode name type
        address { suburb state postcode }
        contacts { email }
      }
    }
  }
}
```

Variables:

```
{ "filter": { "meta": { "page": 1, "limit": 500 },
              "organisation": { "types": ["ASSOCIATION"], "tenantSlug": "afl" } } }
```

**Authentication is not required.** Verified 2026-08-11 across five header
shapes — with the api session cookie, with no cookie at all, with no `tenant`
header, and with `x-phq-tenant` added. All five returned identical results. The
host issues no cookies of its own: a POST returns 200 with no `Set-Cookie`.

**`query` is optional.** Omitting it enumerates. Supplying it filters:
`query: "football"` narrows 1,172 associations to 227.

**`limit: 500` is honoured** — verified by comparing the returned count against
`min(limit, totalRecords)` at 50, 100 and 500. The website uses 8 and 12; neither
is a cap. Whether anything above 500 is honoured was not tested. At limit 500 the
entire AFL association list is three calls.

**⚠️ A wrong `tenantSlug` fails silently.** `tenantSlug: "zzzz"` returns
`totalRecords: 0` with no error, and omitting `tenantSlug` entirely also returns
0. A typo is indistinguishable from a legitimately empty result. Always assert a
non-zero count.

**⚠️ Enumeration is hard-capped at 10,000 results, and BOTH `meta` figures are
clamped to it.** A `CLUB` query reports `totalRecords: 10000` and a `totalPages`
consistent with 10,000 (21 at `limit: 500`), but paging past that boundary fails
with `Organisations could not be found, please try again [ERR-1]`. This is the
Elasticsearch `max_result_window` default.

**The clamped figures do not bound the real count.** Measured 2026-08-11: after
indexing the reachable 10,000 AFL clubs, resolving the member clubs of 713
organisations still required 1,512 individual `discoverOrganisation` lookups for
codes absent from the index — so there are **at least 11,512 AFL clubs, and the
true total is unknown**. An earlier note here inferred about 10,004 from
`totalPages`; that was wrong, because `totalPages` is derived from the clamped
total rather than the real one. Never treat either figure as a population count
for a result set at that magnitude, and always carry a per-item fallback.

Associations are unaffected at 1,175, well inside the window.

**The results union has one member.** `... on Organisation` works;
`Competition`, `Team`, `Grade`, `Venue` and `Association` all return
`Unknown type`. `SearchFilter` likewise rejects `season`, `competition` and
`team` as unknown fields. **Search cannot return seasons** — use
`discoverCompetitions`.

**No geographic filter exists.** `state`, `region`, `location` and `postcode` are
all rejected as unknown fields on the organisation filter. Scoping to a state
must be done client-side from `address.state` on the result.

**Errors return HTTP 422** here, against 400 on the main API, and the messages
are terser — often just `unknown field` with no "did you mean" suggestion. Enum
errors are readable: `ZZZZ is not a valid OrganisationType`, `ZZZZ is not a valid
Sport`. `sports` still exists alongside `tenantSlug`.

**Population as at 2026-08-11**, `tenantSlug: "afl"`, `types: ["ASSOCIATION"]`:
1,175 associations, of which 273 carry `state: "VIC"` and a further 1 carries
`"Victoria"`, and **418 carry no address at all**. The list is global — AFL
Alberta, AFL Beijing, AFL Colombia, AFL Asia Cup and US and Canadian leagues are
included.

**⚠️ The count is not stable.** Two runs the same day returned
`totalRecords: 1172` and then 1,175, with the VIC count moving 272 to 273 and
the unaddressed count 416 to 418. Pin nothing to this figure, and page to
exhaustion rather than trusting a previously recorded total.

**`SearchFilter` accepts only `meta` and `organisation`.** `season`,
`competition`, `team` and `venue` are all rejected as unknown fields, and a
deliberate misspelling of `organisation` is rejected without a suggestion.

**⚠️ State values are not normalised.** Both `VIC` and `Victoria` occur, as do
`QLD`/`Queensland` and `NSW`/`New South Wales`, alongside US state codes and
`British Columbia`, `Ontario` and `Canterbury`. Any state filter must normalise
before comparing, and must decide what to do about the 416 with no address —
several of those are demonstrably Victorian (`AFL Barwon - AFL Nines` has no
address while `AFL Barwon FNL` is `VIC`).

---

## 4. Replace the whole `discoverCompetitions — season history` section

### discoverCompetitions — season history

**Works from a guest session.** The previous entry said it did not; that was a
misdiagnosis, retracted above.

```
query discoverCompetitions($organisationID: ID!) {
  discoverCompetitions(organisationID: $organisationID) {
    id
    name
    seasons(organisationID: $organisationID) {
      id name startDate endDate status { name value }
    }
    organisation { id name }
  }
}
```

1. **`seasons` takes a required `organisationID` argument.** Omitting it returns
   `There was an error. Please try again later.` — the exact error previously
   attributed to an authenticated-tier requirement.
2. **`organisationID` is the 8-character organisation code, not the UUID**,
   despite being declared `ID!`. The UUID returns `Organisation could not be found.`

Controlled comparison, one run, one session, one organisation (EFNL `383836bb`):

| Document | organisationID | Result |
| --- | --- | --- |
| `seasons(organisationID:)` | `383836bb` | 1 competition, 3 seasons |
| `seasons(organisationID:)` | full UUID | `Organisation could not be found.` |
| bare `seasons` | `383836bb` | `There was an error. Please try again later.` |
| bare `seasons` | full UUID | `Organisation could not be found.` |

Rows 1 and 3 differ only in the argument, which is what isolates the cause.

**Ids come back in 8-character form.** EFNL returns competition `23965e53` with
seasons `2dcbf383` (2026, ACTIVE), `75d8a232` (2025, COMPLETED) and `ca9cc98b`
(2024, COMPLETED). `2dcbf383` is the value already carried in
`junior-footy-dashboard/config.json`, so this was checked against a known id
rather than against whether the output looked plausible.

**⚠️ A season's `startDate` precedes the year in its name.** The 2026 season runs
`2025-10-01` to `2026-09-30`. Never derive a season's year from its start date;
use `name`. History on the `afl` tenant currently reaches back to 2024.

**Verified at scale 2026-08-11.** Called for all 1,175 AFL associations at
concurrency 8 from a single GitHub Actions runner: **zero failures**, no rate
limiting, no session expiry over the full sweep. 2,480 seasons returned.

**Status values observed:** `COMPLETED` (2,138), `ACTIVE` (292), `UPCOMING`
(50). `UPCOMING` had not been seen before this run — do not treat the enum as
closed at ACTIVE/COMPLETED.

**An organisation may legitimately return zero competitions.** 462 of 1,175 did
so, with a 200 and an empty array rather than an error. That is distinct from a
failure and must not be bucketed with one.

---

## 5. Corrections to `discoverOrganisation — club identity`

**Works from a guest session on the `afl` tenant** (verified 2026-08-11),
returning `address { line1 suburb postcode state country }`, `contacts`,
`email`, `contactNumber`, `websiteUrl` and `shopVisible`. EFNL returns
`Boronia, VIC 3155`. The Known limitations row reading "`discoverOrganisation`
for BV — returns null for guest sessions" should be relabelled as
`basketball-victoria` behaviour rather than deleted, since it is still true
there.

**⚠️ Two id shapes for one organisation.** `DiscoverOrganisation.id` is the
8-character code (`383836bb`). The `Organisation` type returned by `search` uses
the full UUID for `id` and carries the 8-character form in `routingCode`.
`discoverCompetitions` and `discoverOrganisation(code:)` accept only the short
form; passing the UUID to `discoverOrganisation` returns null rather than an
error.

**`routingCode` is the first eight hex characters of the UUID**, and the same
value the logo URL embeds under `/production/afl/<uuid>/`. The existing
logo-derivation section stays accurate; `search` now supplies the code directly.

---

## 6. Additions to `discoverTeams WITHOUT an organisation — the whole season`

**⚠️ It works for COMPLETED seasons, unlike `discoverFixtureByRound`.** Verified
2026-08-11 against EFNL's three seasons in one run:

| Season | Status | Teams | With a grade | Distinct organisations |
| --- | --- | --- | --- | --- |
| 2026 `2dcbf383` | ACTIVE | 969 | 687 | 60 |
| 2025 `75d8a232` | COMPLETED | 725 | 665 | 58 |
| 2024 `ca9cc98b` | COMPLETED | 641 | 618 | 56 |

The active-seasons-only limitation documented for `discoverFixtureByRound` does
**not** apply here. A per-season team registry can therefore be built for past
years, not only the current one.

**`organisation` on a team is the CLUB, not the league — now verified.** One
EFNL season returns 60 distinct organisations; if the field were the league it
would return one. Names confirm it directly: `Blackburn (Eastern Football
Netball League)`, `East Ringwood (Eastern Football Netball League)`. This closes
the open question recorded against `DiscoverTeam.organisation`, and means the
club can be read at fetch time instead of derived from a logo URL.

**The organisation id here is the 8-character form.** All 969, 725 and 641 team
records returned an 8-character `organisation.id`, so it joins directly to
`discoverOrganisation(code:)` and `discoverCompetitions(organisationID:)` with
no conversion. Note this differs from the `search` result, where `id` is the
UUID and the short form is `routingCode`.

**Grade names come back verbatim**, confirming the earlier probe: `U8 - West`,
`U8 - South` — the strings a name parser currently tries to reconstruct.

**Teams without a grade are far more numerous in the current season** — 282 of
969 in 2026 against 60 of 725 in 2025. Consistent with unassigned and
practice-match entries being cleaned up or not persisted once a season closes,
though that explanation is inferred rather than measured.

---

## 7. New section — `gameStatistics` (the player panel)

Measured 2026-08-16 from `index.html`'s player panel query.

The `game` returned inside `gameStatistics` carries **`id`, `round { name }`,
`date`, `home` and `away` — and no score**. Asking for it fails:

```
game { result { home { score } away { score } } }   # rejected
```

**⚠️ A rejected field fails the WHOLE query, not just that field.** GraphQL
validates the document before executing it, so one unknown field returns an error
and no data at all. Adding the above took the player panel from working to
"No 2026 season stats found" for every player, in every season. A query is not a
place to try a field and see.

**`round { name }` is a STRING, not a number.** It returns `"Round 1"`, so
anything joining a panel row to a stored match record must parse the number out.

---

## 8. Finals round names contain a number

`finalsAbbrev` is the game type — QF, EF, PF, GF. `finalsName` is the ROUND name,
and PlayHQ's finals rounds are named **"Finals Round 1", "Finals Round 2"**.

So a finals round name **contains a digit**. Detecting finals by the absence of a
number is wrong, and it silently sends a finals game down the home-and-away path
to match a completely different game. Test the name for `final` instead — which
also covers "Grand Final", "Preliminary Final" and "Qualifying Final".

This is consistent with the existing note that finals rounds restart numbering at
1: "Finals Round 1" and "Round 1" are different rounds with the same number.

---

## 9. Grade names — "Grading" appears in at least three formats

Measured across the five competitions 2026-08-13:

```
U13 Mixed GRADING          SER
U12 Girls (Grading)        EFNL
U12 Mixed Grading          YJFL, WFNL
Western Bulldogs U12 Mixed Grading    WFNL, with a sponsor prefix
GYG - Regional U14 Girls GRADING      SER, with a sponsor prefix
```

An exact match on a parsed `rawGrade === 'Grading'` catches only some. Use a
case-insensitive substring test on the full grade name.

**⚠️ `discoverFixtureByRound` re-serves completed rounds.** The 2026-08-11 note
saying it returns 0 games for a completed round already fetched was NOT reproduced:
`probe-concurrent-comps.js` fetched every round of seven SEJ 2026 U10 grades on
2026-08-13, 68 calls, and completed rounds returned their full game lists. One of
the two observations is wrong and this is unresolved — do not build a deletion or
reconciliation mechanism on either reading until it is settled.

---

## 10. Grading pools are SHARED BETWEEN LEAGUES

Measured 2026-08-17 against EFNL 2026, and confirmed on the live site after the
fix.

`discoverFixtureByRound` returns grading-round games in which one or both teams
belong to a club registered to a **different association** — YJFL, SER and SEJ
clubs all appear in EFNL's own grading rounds. The pools are run jointly and the
teams are split back into their own leagues once graded.

**Nothing in the response is wrong, which is what makes this expensive.** The
record's `compName` really is the host competition, and `DiscoverTeam.organisation`
really does resolve each team to its own club. Both fields are correct in
isolation; they cannot be combined to mean "a team that entered this competition".

**⚠️ Any per-competition count of entrants must exclude teams whose records in
that competition are confined to grading grades.** A real entrant also plays
home-and-away or finals; a visitor to the pool plays nothing else. Before this
test was added, one club summary listed dozens of clubs from three other leagues
as having entered teams, and every percentage in the table was computed over the
inflated denominator.

**⚠️ The bracketed association in a club's name is NOT a usable discriminator.**
PlayHQ names carry the club's parent association — `Belgrave Football Netball Club
(Outer East Senior Football)`, `Ashburton JFC (Yarra Junior Football League
(YJFL))` — but that is the club's home association, not the competition the team
is playing in. A club may legitimately field juniors in one league and seniors in
another, so filtering on the bracket removes real entrants. The test has to be
structural: did this team play outside the grading pool.

---

## 11. `gameStatistics` spans every team a player turned out for

Measured 2026-08-18.

The live per-player query returns games from EVERY team the player appeared for in
the season, across age groups — a U12 player's list included his two U13 games.
There is no field distinguishing them beyond the grade name, so a consumer that
shows the list without the age group produces rows that look like duplicate rounds
against the wrong opponent with the wrong result.

**This does not match how the stats are STORED.** `fetch-stats.js` writes one
record per grade, so the same person has two stored records — U12 B with 16 games
and 28 goals, U13 B with 2 and 1 — while the live list shows all 18 games and 29
goals as one sequence. Any header summarising a person has to sum the stored
records, or it reports one team's figures above a list covering several.

The grade name is the only place the age reliably appears, and it appears in more
than one shape: `U13 - B`, `U19.5 - Division 3`, `U14 Girls - D`,
`Western Bulldogs - U12 Girls Division 1`. Where the grade name carries no age at
all — `Division 3`, `Division 5`, `Premier` — the TEAM name usually does
(`The Basin Reserves`, `The Basin Senior Women Green`). Parse both, in that order.

---

## Also needs changing outside this file

- `junior-footy-dashboard/docs/team_registry_design.md` §1.5 and §6 both state
  that `discoverCompetitions` is unusable. Both are now false.
- `junior-footy-dashboard/docs/dashboard_context.md` repeats the claim under
  "Next up: multi-season support", and its open lead about
  `DiscoverTeam.organisation` is unaffected by this run.
- Sections 10 and 11 are already reflected in `dashboard_context.md` (§6.3b and
  §6.7) and in the code — Beta 0.181 for the grading-pool filter, 0.190–0.191 for
  the player panel. They are recorded HERE because they are PlayHQ behaviours
  rather than facts about this repo, and this file is the only copy that travels
  to `sports-players-stats`.
