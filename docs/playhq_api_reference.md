<!-- docs/playhq_api_reference.md -->
# PlayHQ GraphQL API Reference

> **Change log:**
> - **August 2026 (verified live, `afl` tenant):** Finals round numbering restarts at 1 in every grade; `abbreviatedName` is the stable key. Grades are returned strongest-first within an age. `age.value` / `gender.value` classify level and gender — PlayHQ calls U19.5 **SENIOR**. GraphQL introspection is **disabled**. See the new sections below.
> - **July 2026 (verified live):** `gradePlayerStatistics` is **paginated** via `filter.pagination {page, limit}`. `limit=50` is a PER-PAGE cap, NOT a total cap. Verified on grade `c952bf59` — `totalRecords=86`, `totalPages=2`. Prior "hard cap 50, no pagination" text was WRONG; corrected below and in Known limitations.
> - **July 2026:** Documented the two PlayHQ identity namespaces (spectator vs api) as a first-class concept — see "⚠️ Two identity namespaces" below. Feeding a spectator-namespace `profileID` to `api.playhq.com` returns NOT_FOUND for a meaningful fraction of real public players; this is a namespace mismatch, not a private/missing player.
> - **2026-07-29 (RETRACTION — this doc was wrong and it cost 40,034 files):** the June 2026 entry below claiming `seasonStatistics.name` is the player display name is **FALSE**. It is the SEASON label ("Autumn 2021", "Summer 2022/23"). Reading `seasonStatistics[0].name` as a person's name wrote season strings into `player.name` for every player who reached `finishOk` without a prior name — repaired by `repair-season-names.js` (40,034 files; 0 contaminated on the independent re-scan). The real name comes from `publicProfile` on the **`account` tenant** (new section below) or from spectator rosters (`nightly-crawl.js` Phase 3). Corrected at all three sites in this file.
> - ~~June 2026: `publicProfileStatistics` — `seasonStatistics.name` confirmed as player display name.~~ **WRONG — see retraction above.** (Kept, struck through, so anyone who read the old text knows it was retracted rather than assuming they misremembered.)
> - June 2026: `update-venue-lookup.js` — must include UPCOMING + POSTPONED games, not just FINAL.
> - June 2026: Per-reg stat key confirmed as `sid:tid` (not `sid:tid:gid` — `gid` in that context was always undefined).

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `https://api.playhq.com/graphql` | Main API — all queries except live game scoring |
| `https://spectator.playhq.com/graphql` | Live e-scoring + hidden game scores |

---

## ⚠️ Two identity namespaces (spectator vs api) — READ THIS BEFORE ANY PROFILE WORK

PlayHQ runs **two separate identity namespaces for the same human**, and their `profileID`s frequently differ:

| Namespace | Source | Where the id appears |
|-----------|--------|----------------------|
| **spectator** | `spectator.playhq.com` (live scoring / box scores) | Games in `games/bv` reference players by a spectator `profileID` in `p[]` / `hp[]` / `ap[]` |
| **api** | `api.playhq.com` (profiles / statistics) | `publicProfileStatistics(profileID)` and `publicProfileTeams(profileID)` expect an id from THIS namespace |

**The failure mode:** feeding a spectator-namespace id to `publicProfileStatistics` returns `NOT_FOUND` (200 OK, null data) for a meaningful fraction of players. This looked like "private/missing player" historically, but it is a **namespace mismatch** — the player is public, the id is just from the wrong namespace.

**Verified diverged validators (season `81545684`, game `a2e4b6c2`, grade `c952bf59`):**
- William Mallen — spectator `9c8403ae-…` → api `50705b28-…`
- Charlie Raynor — spectator `408c3c6e-…` → api `69e32567-…`
- Jack Delaney — spectator `0000ed35-…` → api `1cf5a2ba-…`

**Recovery (spectator id → api id):** use the box-score `name` + one of `gradePlayerStatistics` / grade-roster-by-name / `profileSearch` to resolve the api id. Implemented in `scripts/lib/namespace-resolve.cjs` (`matchFromGrade`, `matchFromGradeRosterByName`, `matchFromSearch`, `isPlaceholderName`). Measured recovery rate ~93–100% of diverged players.

**Measured population facts (July 2026):**
- **Spectator-multiplicity: 19.8%** of collision api ids have 2+ spectator ids (40,330 mappings; 31,224 distinct api ids; max 13 spectator ids for one person). 43 name-mismatch cases, **all benign** (nicknames + curly/straight-quote + hyphen/spacing variants), 0 mis-reconciliations.
- **api-stability: 0.09% duplicate rate** (368 same-person records, all foldable spectator/api-divergence duplicates) — **no evidence a person has two distinct api profiles.** The api id is treated as the stable per-player key.

**Rule:** the api id is canonical/stable; the spectator id is the axis that duplicates. Never write a player record keyed on the spectator id if the api id is recoverable and already indexed — that creates a duplicate of an existing person (see backfill collision-skip in README / `claude_context.md`).

---

## ⚠️ Critical: Headers

**Main API** (`api.playhq.com`) — tenant full name, cookie in correct order:
```javascript
{
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'basketball-victoria',   // FULL name — never 'bv'
  'content-type': 'application/json',
  'request-id':   crypto.randomUUID(),
  'Cookie':       'phq_tier=cookie-no-jwt; phq_session=<jwt>; phq_sub=<sub>',  // ORDER MATTERS
}
```

**⚠️ Cookie order is critical.** Must be `phq_tier` first, then `phq_session`, then `phq_sub`. Wrong order causes CloudFront 403s.

**Spectator API** (`spectator.playhq.com`) — short tenant + extra header:
```javascript
{
  'accept':       '*/*',
  'origin':       'https://www.playhq.com',
  'user-agent':   'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)',
  'tenant':       'bv',                    // SHORT name
  'x-phq-tenant': 'bv',                   // additional required header
  'content-type': 'application/json',
  'request-id':   crypto.randomUUID(),
  'Cookie':       'phq_tier=cookie-no-jwt; phq_session=<jwt>; phq_sub=<sub>',
}
```

Never split into separate public/mobile header objects. Missing user-agent = immediate 403 from CloudFront WAF.

---

## Authentication

PlayHQ issues a guest `phq_session` cookie on any valid request with the mobile user-agent. **Cookie TTL: ~30-40 minutes** in practice.

**Cookie order when constructing:** `phq_tier=cookie-no-jwt; phq_session=<jwt>; phq_sub=<sub>`
Extract all three from `set-cookie` headers, parse by name, reconstruct in this order.

**Cookie fetch must retry up to 10 times with backoff** — PlayHQ intermittently returns no Set-Cookie, especially when 256 matrix jobs all start simultaneously:

```javascript
async function refreshSession() {
  const cookieQueries = [
    { operationName: 'TenantConfig', variables: {},
      query: 'query TenantConfig { tenantConfiguration { label } }' },
    { operationName: 'ProfileSearch', variables: { fullName: 'a' },
      query: 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) { result { id } } }' },
  ];
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await sleep(attempt * 5000);
    for (const body of cookieQueries) {
      const res = await doFetch(API_URL, { method: 'POST', headers: HEADERS_BASE, body: JSON.stringify(body) });
      const raw = res.headers.get('set-cookie');
      if (!raw) continue;
      const parts = raw.split(',').map(c => c.trim().split(';')[0]);
      const get = name => parts.find(p => p.startsWith(name + '=')) || null;
      const tier = get('phq_tier'), session = get('phq_session'), sub = get('phq_sub');
      if (tier && session && sub) {
        sessionCookie = `${tier}; ${session}; ${sub}`;
        return;
      }
    }
  }
  throw new Error('Failed to obtain session cookie after 10 attempts');
}
```

**Rate limits:**
- `publicProfileStatistics` (`ProfileSeasonStatistics`) only: per-session JWT quota of ~30-35 calls. Refresh session between every batch of 30 requests.
- All other operations: **there IS a limit — a rate-based CloudFront WAF.** (The old claim here,
  "no effective rate limit, tested to 1000 concurrent with zero failures", was wrong and is removed.)
  It hard-blocks with **HTTP 403 + an HTML "Request blocked" body**, which is DISTINCT from an
  application 403 and is NOT a GraphQL 429 — detect it by testing the body for `DOCTYPE` /
  `Request blocked` before deciding what a 403 means (`fetch-profile-stats.js` L374–388).
  - **Per-shard / per-IP, NOT shared-IP aggregate** — parallel matrix jobs do NOT collectively trip
    it. Do not lower `max-parallel` to "help".
  - `discoverGrade` / `discoverFixtureByRound`: ~1,256–1,790 requests per ~80s window at
    concurrency ≈25; recovery is flat ~80s, no escalation.
  - `ProfileSeasonStatistics`: **far stricter** — roughly one 50-call batch per window; the matrix
    trips after ~50 calls/shard, which is why self-trigger-per-batch is the correct shape.
  - `publicProfileTeams`: friendlier — 200 probes returned `blocked: 0`.
  - **Rule:** type every call (`ok` / `empty` / `blocked` / `transient`); never collapse a failure
    into "no data". Canonical implementations: `fetch-profile-stats.js`, `nightly-crawl.js`
    (`gqlMain` → `{kind, data}`).

**Concurrency policy (main API, from REPO_MANIFEST §8)** — the AIMD loop a new fetcher should copy
rather than invent: start **500**, system cap **1000**; on 429 → drop to **60%** and retry the same
request with `attempts × 5s` backoff; **3 consecutive 429s → permanently lower the cap by 5**;
**2 clean batches → +10**; `403` → return null (not accessible, not a session problem); `404` → skip.
`fetch-profile-stats.js` does NOT use this loop — `ProfileSeasonStatistics` is governed by the
per-session JWT quota instead (batches of 30 with a session refresh between batches, 1s inter-batch
sleep, and `keepAlive: false` so every request opens a fresh TCP connection).

**⚠️ `actions/setup-node` must NEVER appear in a JOB that fetches `api.playhq.com`.** It changes the
runner's outbound fingerprint and produces `403 CLOUDFRONT-BLOCK` on EVERY request — including
session acquisition, from request #1, on a fresh IP. The rule is absolute and **per-job** (a
non-fetching job in the same workflow may carry setup-node harmlessly). See REPO_MANIFEST §6.3/§7.2.

**403 handling:**
- For `ProfileSeasonStatistics`: 403 = private/inaccessible profile — return null, do not refresh session.
- For all other operations: 403 = session expired — refresh and retry.
- Spectator 403: attempt ONE refresh then skip — do not loop.

---

## Three-Step Game Classification Probe (⚠️ ASPIRATIONAL — NOT IMPLEMENTED)

> **Corrected 2026-08-01.** This section was headed "(MANDATORY)". No code performs it. Neither writer
> of `games/bv` — `nightly-crawl.js` or `discover-fixtures.js` — calls `discoverGame` to classify, and a
> full grep of `scripts/` found only reads of `legacy`, never a write. The classifier was removed in the
> 2026-07-16 cleanup, and a game that fails everything today simply gets NO flag. `README` data-integrity
> rule 5 was corrected the same day; this file was the last one still asserting it. Kept as the spec that
> WOULD apply if the probe is rebuilt — do not read it as a description of current behaviour.
> See OUTSTANDING_TASKS §2.1.

Any code path that classifies games MUST follow all three steps. **Never classify as `legacy: true` without probing the spectator endpoint first.**

```
Step 1: discoverGame(gameId) on api.playhq.com
  → data returned:
      FORFEIT outcome     → forfeit: true, fo, desc; add to forfeit-games.json; STOP
      CANCELLED status    → cancelled: true; STOP
      ABANDONED status    → abandoned: true; STOP
      BYE status          → bye: true; STOP
      score data          → normal game, hs/as/venue; STOP
  → null (200 OK)         → MUST proceed to Step 2

Step 2: game(id) on spectator.playhq.com
  → data returned         → hidden: true, hs/as, hq/aq, hp/ap; STOP
  → null                  → MUST proceed to Step 3

Step 3: publicProfileStatistics for any player in the game
  → game found in profile → profileOnly: true, h/a/rn from profile; STOP
  → not found             → legacy: true
```

**discoverGame forfeit outcome values** (in `result.outcome.value`):
- `HOME_TEAM_WON_BY_FORFEIT` — home team won by forfeit
- `AWAY_TEAM_WON_BY_FORFEIT` — away team won by forfeit

**noProfile / noVenue retry flags:**
- `noProfile: new Date().toISOString()` — skip for 30 days when Step 3 exhausts all player candidates
- `noVenue: new Date().toISOString()` — skip for 30 days when hidden game has no venue
- These are SEPARATE flags — do not conflate

```graphql
query discoverGame($gameID: ID!) {
  discoverGame(gameID: $gameID) {
    id
    status { name value }
    result {
      outcome { name value }
      winner  { name value }
      home {
        outcome { name value }
        gameOutcomeDescription
        statistics { count type { value } }
      }
      away {
        outcome { name value }
        gameOutcomeDescription
        statistics { count type { value } }
      }
    }
    home { ... on DiscoverTeam { id name } }
    away { ... on DiscoverTeam { id name } }
    round { name number isFinalsRound }
    date
  }
}
```

---

## Key queries

### gradeRounds

```graphql
query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id name type hideScores dates
    rounds {
      id name abbreviatedName
      current
      number
      isFinalsRound
      provisionalDates
    }
    season {
      id
      competition {
        id
        organisation { id name }
      }
    }
    ladder {
      pool { name }
      standings {
        team { id name }
        won lost ties
      }
    }
  }
}
```

**Finals rounds (verified across all 249 grades, 5 competitions, `afl` tenant, 2026-08-09):**

- **Numbering restarts at 1 in every grade.** 158 grades have finals; every one numbers them
  from 1 while home-and-away rounds end at 14–18. A Grand Final and Round 1 both carry
  `number: 1`. Any id, key or comparison built on `number` alone will collide.
- **`abbreviatedName` is the stable identifier; `name` is not.** WFNL returns
  "Preliminary Finals" where EFNL returns "Preliminary Final" — both `PF`. Populated on all
  480 finals rounds observed; zero missing.
- Six values in use: `GF` (158), `FR1` (154), `PF` (154), `FR2` (11), `SF` (2), `EF` (1).
- Five series shapes: `FR1→PF→GF` (142 grades), `FR1→FR2→PF→GF` (11), `GF` alone (3),
  `FR1→SF→PF→GF` (1), `EF→SF→GF` (1).
- **Position in `rounds[]` is the only ordering valid across the home-and-away/finals
  boundary.** Finals appear after home-and-away in the list.

`rounds[].current: true` identifies the active round. `ladder.standings` gives team IDs — `discoverGrade.teams` does not exist. Ladder fields: `won`, `lost`, `ties` — NOT `wins`, `losses`.

---

### discoverFixtureByRound

```graphql
query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    byes { id name season { id name } organisation { id name } }
    games {
      id alias
      pool { id name }
      home {
        ... on DiscoverTeam { id name season { id name competition { id name } } organisation { id name } }
        ... on ProvisionalTeam { name pool { id name } }
      }
      away {
        ... on DiscoverTeam { id name season { id name competition { id name } } organisation { id name } }
        ... on ProvisionalTeam { name pool { id name } }
      }
      result {
        winner { name value }
        outcome { name value }
        home { outcome { name value } statistics { count type { value } } gameOutcomeDescription }
        away { outcome { name value } statistics { count type { value } } }
      }
      status { name value }
      date dates
      allocation {
        time
        dateTimeList { date time }
        court {
          id name abbreviatedName
          venue { id name abbreviatedName latitude longitude address suburb state postcode country }
        }
      }
      isStale
      gameType { name value }
    }
  }
}
```

**`ProvisionalTeam` (verified 2026-08-09):** an undetermined finals fixture returns a side with
a `name` such as `"Winner Game 1"` or `"Loser Game 3"` and **no `id`**. Absence of `id` is the
reliable test — never match on the word "Winner". Omitting the `... on ProvisionalTeam` spread
does not error: the object simply comes back empty, `home.name` is `undefined`, and any
`if (!homeName) continue;` guard silently discards the game. This is how finals fixtures went
missing for a full season.

**`organisation { id name }` on `DiscoverTeam`** is the team's owning organisation. NOTE: a
probe on 2026-08-10 asked for `club { id name }` and got
`Cannot query field "club" on type "DiscoverTeam"` — the field is named `organisation`, not
`club`. `club { id name }` exists only on `publicProfileStatistics`. Whether `organisation`
here returns the club or the league is **not yet verified on the `afl` tenant**; on
`discoverCompetitions` the equivalent field is the league.

Works for active seasons only. Use `discoverTeamFixture` for historical seasons.

---

### discoverTeamFixture

```graphql
query TeamFixture($teamID: ID!) {
  discoverTeam(teamID: $teamID) {
    id grade { id name }
    season { id name competition { id name organisation { id name } } status { value } }
    organisation { id name }
  }
  discoverTeamFixture(teamID: $teamID) {
    id name isFinalsRound
    grade { id name season { id name competition { id name organisation { id name } } } }
    fixture {
      games {
        id dates
        status { value }
        home { ... on DiscoverTeam { id name organisation { id name } } }
        away { ... on DiscoverTeam { id name organisation { id name } } }
        result {
          home { statistics { count type { value } } }
          away { statistics { count type { value } } }
        }
      }
    }
  }
}
```

---

### discoverGame (full — for classification)

```graphql
query DiscoverGame($gameId: ID!) {
  discoverGame(gameID: $gameId) {
    id date
    status { name value }
    round { id name isFinalsRound }
    home { ... on DiscoverTeam { id name } }
    away { ... on DiscoverTeam { id name } }
    result {
      winner { value }
      outcome { name value }
      home { outcome { name value } gameOutcomeDescription statistics { count type { value } } }
      away { outcome { name value } statistics { count type { value } } }
    }
    allocation {
      dateTimeList { date time }
      court { id name abbreviatedName venue { id name abbreviatedName latitude longitude address suburb state postcode country } }
    }
  }
}
```

Returns null (200 OK) for hidden grades and legacy games — not an error.

---

### game(id) — spectator endpoint

**Endpoint: `https://spectator.playhq.com/graphql`**

```graphql
query game($id: ID!, $scope: PeriodScore) {
  game(id: $id) {
    id status updatedAt
    statistics {
      home {
        statisticsV2 { type { value } count }
        players {
          id profileID name playerNumber
          statistics { type { value } count }
          periodStatistics { period { value } statistics { type { value } count } }
        }
      }
      away {
        statisticsV2 { type { value } count }
        players {
          id profileID name playerNumber
          statistics { type { value } count }
          periodStatistics { period { value } statistics { type { value } count } }
        }
      }
    }
    result {
      home {
        statistics { type { value } count }
        periods(scope: $scope) { period { label shortName value } statistics { type { value } count } overtimeSequenceNo }
      }
      away {
        statistics { type { value } count }
        periods(scope: $scope) { period { label shortName value } statistics { type { value } count } overtimeSequenceNo }
      }
    }
  }
}
```

Variables: `{ "id": "<gameId>", "scope": "BY_PERIOD" }`

**Stored hp/ap format (after spectator processing):**
```json
[{"profileID": "uuid", "name": "Sam B", "number": 7, "pts": 12, "pt1": 0, "pt2": 4, "pt3": 1, "fouls": 2}]
```

Note: `name` field in stored `hp`/`ap` was stripped June 2026 along with `p[].n`. Do not re-add.

---

### publicProfileStatistics — player career and per-game history

**⚠️ THIS CALL RETURNS NO PLAYER NAME.** `seasonStatistics[].name` is the **SEASON label**, not the person. The deployed `PROFILE_QUERY` in `fetch-profile-stats.js` still REQUESTS the field (L175) but `parseProfileStats()` hard-sets `playerName = null` (L218–224) — do NOT "restore" a name read here, and do NOT strip `name` from the query below without reading the deployed query first. For a real name use **`publicProfile` (account tenant)** — see the section immediately after this one.

**Per-reg stat key:** `sid:tid` (NOT `sid:tid:gid` — the gid in this context is always undefined on reg objects).

```graphql
query ProfileSeasonStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name                      # SEASON label ("Winter 2026") — NOT the player's name
      player { hasGamePermit }
      statistics {
        season { id name competition { id name organisation { id name } } }
        role
        club { id name }
        totalStatistics { count details { value } gameFormat }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          totalStatistics { count details { value } gameFormat }
          gradeStatistics {
            grade { id name }
            totalStatistics { count details { value } gameFormat }
            gameStatistics {
              game {
                id
                round { name number isFinalsRound abbreviatedName }
                home { ... on DiscoverTeam { id name } }
                away { ... on DiscoverTeam { id name } }
              }
              statistics { count details { value } }
            }
          }
        }
      }
    }
  }
}
```

**Stat type values:** `APPEARANCE`, `TOTAL_FOULS`, `TOTAL_SCORE`, `1_POINT_SCORE`, `2_POINT_SCORE`, `3_POINT_SCORE`

**Field mappings:**
- `gp`: `APPEARANCE`
- `pts`: `TOTAL_SCORE`
- `fg`: `2_POINT_SCORE`
- `ft`: `1_POINT_SCORE`
- `threePt`: `3_POINT_SCORE`
- `fouls`: `TOTAL_FOULS`
- `foulOuts`: count games per season where `TOTAL_FOULS >= 5`
- `name`: **NOT AVAILABLE from this call.** `seasonStatistics[0].name` is the season label — see the warning above. Use `publicProfile` (account tenant).
- `gameTids`: built from `teamStatistics[].gradeStatistics[].gameStatistics[].game.id` → `teamStatistics[].team.id` — written to player file for players with multiple tids in same season

**`seenGameKeys` dedup:** Always deduplicate by `game.id` — same game may appear in multiple `gradeStatistics` entries. **NEVER remove `seenGameKeys` from `fetch-profile-stats.js`.**

**Forfeit filtering:** Skip any `game.id` in `data/forfeit-games.json`.

Path: `seasonStatistics[].statistics[].teamStatistics[].gradeStatistics[].gameStatistics[]`

---

### publicProfile — the ONLY direct id → name lookup (ACCOUNT tenant)

**Added 2026-07-29 — COPIED VERBATIM, NOT RECONSTRUCTED.** The query string below was extracted
from the deployed `scripts/fetch-profile-stats.js` and compared byte-for-byte (string equality, not
eyeballed); the header form and every cited line number were checked against the same file the same
day. **To re-verify without trusting this note:** open `scripts/fetch-profile-stats.js`, find
`PUBLIC_PROFILE_QUERY` (L328) and `fetchPublicProfileName()` (L332–350), and diff. If the script has
moved on, the script wins and this section is what gets updated — never the reverse. This matters
more here than anywhere else in the file: the call this section documents exists because the
*previous* documented answer to "where does a player's name come from" caused the 40,034-file
season-name incident.

Previously undocumented despite being referenced by `claude_context.md`
directive 6 and claimed as present by `REPO_MANIFEST.md` §6.6 — neither was true, so anyone
following the pointer found nothing.

**The tenant is the whole point.** This is the ONLY call that uses `tenant: 'account'` — PlayHQ's
cross-sport identity tenant — instead of `basketball-victoria`. That is why it resolves
**spectator-keyed ids too**, and why `fetch-profile-stats.js` calls it with the STORED uuid rather
than a recovered `apiId` (L737). Everything else in the header set is unchanged.

```javascript
const PUBLIC_PROFILE_QUERY = {
  operationName: 'publicProfile',
  query: 'query publicProfile($profileID: ID!) { publicProfile(profileID: $profileID) { id firstName lastName __typename } }',
};
// headers: { ...HEADERS_BASE, 'tenant': 'account', 'request-id': crypto.randomUUID(), 'Cookie': sessionCookie }
```

**Response path:** `data.publicProfile` → name is `` `${firstName} ${lastName}`.trim() ``, or `null`
if that is empty.

**Failure handling (as deployed):** non-200 → `null`; `json.errors` present → `null`; missing
`data.publicProfile` → `null`; **403 → ONE `refreshSession()` then ONE retry**, then `null`. `null`
means "not found / hidden / transient" — the caller KEEPS the existing name and retries on a later
run. Never overwrite a stored name with an empty result.

**When it is called** (`finishOk`, L734–739) — only when the stored name is unusable, so players
with an established real name cost no extra request:
- no `player.name` at all, OR
- `isPlaceholderName(player.name)` (a `Player #<prefix>` stub), OR
- **contaminated**: the stored name matches one of the player's own season names under `normName()`
  — i.e. wreckage from the season-name bug above.

---

### discoverSeason

```graphql
query DiscoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    id name
    status { value }
    startDate endDate
    competition { id name organisation { id name type } }
    grades { id name }
  }
}
```

Variable type is `String!` not `ID!` for basketball-victoria tenant.

---

### publicProfileTeams

```graphql
query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    teams {
      status { value }
      team {
        id name
        season { id name startDate endDate status { name value } competition { id name } }
        grade { id name }
        organisation { id name }
      }
    }
  }
}
```

Returns `UPCOMING`, `ACTIVE`, `COMPLETED` registrations.

---

### gradePlayerStatistics

**PAGINATED (verified live July 2026 — grade `c952bf59`: `totalRecords=86`, `totalPages=2`).** `filter.pagination.limit=50` is a PER-PAGE cap, not a total cap. Iterate `page` from 1..`totalPages` to get every record. **Never assume 50 is the full set.**

```graphql
query GradePlayerStatistics($gradeID: ID!, $filter: GradePlayerStatisticsFilter) {
  gradePlayerStatistics(gradeID: $gradeID, filter: $filter) {
    meta { totalPages totalRecords page }
    results {
      profile { id firstName lastName }
      team { id name }
      statistics { count details { value } }
    }
  }
}
```

Variables (page through until `meta.page >= meta.totalPages`):
```json
{ "gradeID": "c952bf59-...", "filter": { "pagination": { "page": 1, "limit": 50 } } }
```

- `meta.totalRecords` / `meta.totalPages` drive the loop; `limit` max observed = 50 per page.
- `team { id name }` is present on each result.
- Sort columns available: `APPEARANCE`, `TOTAL_SCORE`, `1_POINT_SCORE`, `2_POINT_SCORE`, `3_POINT_SCORE`, `TOTAL_FOULS`.
- Canonical implementation: `scripts/lib/namespace-resolve.cjs` (`gradePageFilter`, `matchFromGrade`). Copy from there — do NOT hand-write a minimised single-page version.

---

### profileSearch

```graphql
query ProfileSearch($fullName: String!) {
  profileSearch(fullName: $fullName) {
    result {
      id firstName lastName
      lastInteractedOrganisation { id name }
    }
  }
}
```

---

## Organisations, clubs and teams

**Introspection is disabled** — `__schema` / `__type` return
`INTROSPECTION_DISABLED` (Apollo Server). The schema cannot be read; field existence must be
probed by asking for the field and reading the validation error, which usefully names valid
alternatives.

### discoverOrganisation — club identity

```graphql
query discoverOrganisation($organisationCode: String!) {
  discoverOrganisation(code: $organisationCode) { id type name websiteUrl address { suburb state } logo { sizes { url } } contacts { firstName lastName position email } }
}
```

`type` is `CLUB` for a club and distinguishes it from a league. `code` is the 8-character
public organisation id, the same value that appears in a PlayHQ club URL.

**Logo URLs embed the owning organisation's UUID**, whose first eight hex characters are that
public code:

```
/production/afl/6d405ccb-cf15-4fbd-a5c8-bcde4ae5c3e6/.../logo.png
                ^^^^^^^^ Norwood's organisation code
```

Verified 2026-08-10 across five competitions: 165 clubs derived this way, 2032 teams, none
unattributed, and every sampled id resolved as `type: CLUB`. Useful when only stored logo URLs
are available. Prefer `organisation { id name }` on the team if that proves to be the club.

**Never derive a club from a team name.** `"Norwood Gold/Heathmont U12"` is a merged team no
stripping rule maps to Norwood, and Templestowe fields two organisations — `225d5de5`
Templestowe (EFNL) and `2545b284` Templestowe Junior Football Club — whose team names both
reduce to `"Templestowe"`.

### discoverTeams — a club's teams in one season

```graphql
query discoverOrganisationTeams($seasonId: ID!, $organisationId: ID!) {
  discoverTeams(filter: {seasonID: $seasonId, organisationID: $organisationId}) {
    id name gender { value } ageGroup { value } grade { id name }
  }
}
```

**Season-scoped.** A club fielding a team in another league's competition returns empty for
that league's season, which is correct behaviour and makes this unsuitable for identifying
clubs generally.

### discoverTeams WITHOUT an organisation — the whole season

```graphql
query discoverTeamsBySeason($seasonId: ID!) {
  discoverTeams(filter: {seasonID: $seasonId}) {
    id name gender { value } ageGroup { value }
    grade { id name }
    organisation { id name }
  }
}
```

**`organisationID` is optional.** Verified 2026-08-10: one call per season
returns every registered team with its grade and owning organisation — 2,399
teams across five competitions, EFNL alone returning 969 teams and 60
organisations.

This is the authoritative source for three things otherwise derived by guesswork:
whether a team is **registered** in a season at all, its **real grade name**
(`"Deakin Uni - U18 Girls - A/B"`, not a parsed fragment), and its **club**.

Teams with no grade are practice-match and unassigned entries — registered, but
not competing. EFNL 2026: 687 of 969 carry a grade.

**Registration discriminates members from visitors.** A club playing in a
league's grading pool while registered elsewhere returns nothing for that
league's season. In EFNL's U18 Girls grading pool, 27 of 45 clubs are not
registered in EFNL at all.

### discoverCompetitions — season history

⚠️ **Not usable from a guest session.** Verified 2026-08-10: fails with
`There was an error. Please try again later.` across every variation tried —
one cookie, all three cookies, with and without `operationName`, and the exact
document shape playhq.com sends. It works from a signed-in browser. Our tier is
`phq_tier=cookie-no-jwt`, so an authenticated session is the likely requirement.
Do not build season discovery on it; carry season ids in configuration.


```graphql
query discoverCompetitions($organisationID: ID!) {
  discoverCompetitions(organisationID: $organisationID) {
    id name
    seasons { id name startDate endDate status { value } }
    organisation { id name }
  }
}
```

Returns every season an organisation has played, with dates and `ACTIVE`/`COMPLETED` status —
one call replaces hand-maintained season ids. Works from a browser; a probe on 2026-08-10 got
`There was an error. Please try again later.`, most likely rate limiting rather than a wrong
query.

---

## Grade metadata — strength, level, gender

**Grades are returned strongest-first within each age.** This is the only sound source of grade
strength, because colour-named grades carry no order in their names. Verified across five
competitions, 2026-08-09:

```
EFNL  U11 -> A, B, C, D1, D2
SER   U13 -> Premier Division, Blue, Gold, Navy, Orange
SEJ   U11 -> Blue, Red
```

Rank is meaningful **only within one competition and one age**. Never compare an EFNL "A" with
an SER "Blue". Grading grades should be excluded from ranking — they are a pre-season sorting
pool and would consume a rank slot.

**`age { name value }` and `gender { name value }`** on a grade classify it. Age values:
`U7`–`U23`, `JUNIOR`, `INTERMEDIATE`, `SENIOR`, `OPEN`, `MASTER`, `MASTERS_35S`…,
`UNSPECIFIED`. Gender values: `BOYS`, `GIRLS`, `MENS`, `MIXED`, `WOMENS`.

Two traps:

- **PlayHQ classifies U19.5 as `SENIOR`.** Any "age starts with U" rule gets this wrong.
- **U17.5 competitions return `ageName: "U17"`.** The API is authoritative in both directions,
  but neither matches the display name.

---

## Score extraction

```javascript
function parseScore(statistics) {
  return statistics?.find(s => s.type?.value === 'TOTAL_SCORE')?.count ?? null;
}

function statValue(statistics, typeValue) {
  if (!Array.isArray(statistics)) return 0;
  const match = statistics.find(s => s?.details?.value === typeValue);
  return match ? (match.count || 0) : 0;
}
```

---

## Game URL construction

Only the gameId matters:
```
https://www.playhq.com/basketball-victoria/org/a/a/a/game-centre/{gameId}
```

---

## Known limitations

| What | Status |
|------|--------|
| `discoverFixtureByRound` for completed historical seasons | ❌ Returns empty — use `discoverTeamFixture` |
| Hidden grade games via `discoverGame` | ❌ Returns null — use spectator `game(id)` |
| Venue for hidden games | ❌ Not available via any route |
| Legacy orphaned games | ❌ All three classification steps null |
| `discoverGrade.teams` field | ❌ Doesn't exist — use `ladder.standings` |
| Season data pre-2020 | ❌ BV migrated to PlayHQ ~2020 |
| `gradePlayerStatistics` pagination | ✅ Paginated via `filter.pagination {page,limit}` — `limit=50` is PER-PAGE, not a total cap. Loop pages using `meta.totalPages` (verified July 2026). |
| `discoverOrganisation` for BV | ❌ Returns null for guest sessions |
| Team roster before first game | ❌ Not accessible via public API — reconstruct BOTTOM-UP from individual players' UPCOMING publicProfileTeams regs |
| `publicProfileTeams` grade for COMPLETED seasons | ❌ Returns NULL (grade only present for the player's CURRENT rego) — no bottom-up grade recovery for old seasons |
| `discoverSeason` grades for junior-stripped seasons | ❌ Returns null/0 for seasons holding only 1–2 grades (PlayHQ withholds junior grades). 3+ grade seasons resolve fine; some return MORE than the index holds (recoverable) |
| `removed:true` seasons (0 grades, nothing fetchable) | ❌ discoverSeason null + discoverTeamFixture 0 games + nothing on disk — record existence only |
| PlayHQ partner API access | ❌ Applied, rejected — do not raise again |
| Spectator venue/allocation | ❌ Not returned — only scores + players |
