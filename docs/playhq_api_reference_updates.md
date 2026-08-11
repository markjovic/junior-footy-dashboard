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

## Also needs changing outside this file

- `junior-footy-dashboard/docs/team_registry_design.md` §1.5 and §6 both state
  that `discoverCompetitions` is unusable. Both are now false.
- `junior-footy-dashboard/docs/dashboard_context.md` repeats the claim under
  "Next up: multi-season support", and its open lead about
  `DiscoverTeam.organisation` is unaffected by this run.
