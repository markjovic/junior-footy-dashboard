<!-- docs/storage_ingestion_design.md -->
# Storage and Ingestion — Design Document

**Repo:** `markjovic/junior-footy-dashboard`
**Status:** APPROVED. Steps 1–5 of §10 are BUILT and deployed 2026-08-11.
Remaining: step 6 (Phase A backfill), step 7 (restrict scheduled runs to live
seasons), step 8 (Phase B backfill).
**Date:** 2026-08-11 (revised same day after implementation)

**What shipped.** `scripts/lib/store.js` hides the layout from the writers;
all four writers and `index.html` (Beta 0.132) cut over on 2026-08-11.
`split-data.js` performed the one-time migration and verified it by reassembly.
Result: five organisation files, 25.88 MB, largest 9.88 MB. `data.json` is no
longer written or read.

**Not yet exercised against real data:** the rollover of a retired season from
`-current` to `-archive`, and `index.html`'s archive fallback for an organisation
with no live season. Both are tested against fixtures only. Force a dry run
before November.
**Evidence:** `scripts/report-data-size.js` run 2026-08-11 against the live
`data/data.json`; `scripts/discover-orgs.js` and `scripts/probe-search.js` runs
the same day. Every figure in §1 is measured. Anything inferred says so.

**Companion:** `team_registry_design.md` covers team identity and is independent
of this. Neither blocks the other.

**`index.html` read 2026-08-11** — head, full body markup, and the script's
storage, state, parse, merge, roster and init sections, plus the specific regions
answering §7. The bulk of the rendering code between those regions was not read
line by line; nothing below rests on it.

---

## 1. What was measured

`data/data.json` is 36.57 MB, minified.

| Key | Bytes | Share | Entries |
| --- | --- | --- | --- |
| `players` | 27.24 MB | 74.5% | 44,889 |
| `matches` | 8.78 MB | 24.0% | 13,178 |
| `teamLogos` | 251.3 KB | 0.7% | 1,483 |
| `roster` | 185.3 KB | 0.5% | 2,032 |
| `teamClub` | 100.0 KB | 0.3% | 2,032 |
| `gradeMeta` | 11.1 KB | 0.0% | 211 |
| `clubs` | 10.6 KB | 0.0% | 165 |
| `lastRound` | 3.4 KB | 0.0% | 209 |
| `compLogos` | 832 B | 0.0% | 5 |
| `gotwFlags` | 15 B | 0.0% | **0** |

**Players are three quarters of the file.** Every earlier estimate in this
project divided the total by five and treated the result as per-competition
match data. That was wrong by roughly a factor of four and is the reason the
expansion looked infeasible.

**Match and roster data per competition** — the unit a split produces:

| Competition | Matches | Match bytes | Roster | gradeMeta | Total |
| --- | --- | --- | --- | --- | --- |
| EFNL 2026 | 5,420 | 3.63 MB | 78.4 KB | 4.2 KB | 3.71 MB |
| YJFL 2026 | 2,909 | 1.88 MB | 35.3 KB | 2.4 KB | 1.91 MB |
| WFNL 2026 | 2,098 | 1.42 MB | 31.2 KB | 2.2 KB | 1.46 MB |
| SER 2026 | 1,969 | 1.32 MB | 25.9 KB | 1.7 KB | 1.35 MB |
| SEJ 2026 | 782 | 540.1 KB | 14.6 KB | 602 B | 555.2 KB |

Players are not attributed per competition in the report. Distributing them in
proportion to match volume puts EFNL near 11 MB of player data, so an EFNL
competition-season file lands around **15 MB** — an inference from the
proportions, not a measurement.

**Match records are 13,178, of which 12,464 are real.** 511 are bye sentinels
and 203 are scheduled fixtures; no partials were present.

### 1.1 Redundancy — 43% of the file is recomputable or duplicated

| What | Bytes | Note |
| --- | --- | --- |
| `hLogo` + `aLogo` on matches | 3.82 MB | 167 distinct URLs; `teamLogos` already holds them in 251 KB |
| Derivable player fields | 11.04 MB | 6.06 MB top level, 4.98 MB inside `appearances[]` |
| `id` on matches | 914 KB | every component is a sibling field on the same record |
| `venue` + `vSuburb` + `venueUrl` | 1.58 MB | not derivable, but normalises to a venue map |

`fetch-results.js` line 1102 builds `teamLogos` **from** `m.hLogo` and `m.aLogo`,
so every per-match copy is a second storage of a value already held once.

Derivable player fields are `name` (from `firstName` + `lastName`), `team` (from
`toClubName(teamRaw)`), and `gradeName`, `rawGrade`, `age` and `compName` (all
resolvable from `gradeID` through `grades.json`) — with `team`, `gradeName` and
`rawGrade` repeated again in every one of the 65,024 `appearances[]` rows.

Removing logos, derivable player fields and `id` takes 36.57 MB to **20.82 MB**.
Normalising venues would take it near 19.4 MB.

---

## 2. The problem

- **One file, loaded whole.** A visitor viewing one competition downloads all
  36.57 MB, most of it player records for competitions they are not looking at.
- **It does not extend.** Sixteen competitions at the current season is roughly
  117 MB. GitHub refuses any file over 100 MB, so the single-file shape fails
  before history is added.
- **Every run rewrites everything.** Four writers merge into one file, so a
  change to one competition produces a whole-file diff.
- **Completed seasons are re-walked.** `fetchGrade` skips grades whose latest
  month has passed, so history is never fetched at all — but the grade list is
  still discovered and iterated on every run.

---

## 3. Proposed file layout

```
data/
  core.json                     clubs, teamClub, compLogos, venues, manifest
  orgs/
    383836bb-current.json       EFNL — live season(s) only, rewritten every run
    383836bb-archive.json       EFNL — every retired season, rewritten yearly
    ...
  grades.json                   unchanged
  org-discovery.json            unchanged
```

**Two files per organisation, not one per season** (decided 2026-08-11). Sixteen
organisations means 32 files plus `core.json`, rather than the hundred-plus a
per-season split would produce.

**Filenames are `<organisationCode>-current.json` and
`<organisationCode>-archive.json`.** The organisation code is the 8-character id
from the API and is stable across seasons. Not `compName`: that is a display
string containing spaces and a year, and it changes between seasons.

A file is per **organisation**, not per competition. `discoverCompetitions`
returns an array, so an organisation running more than one competition puts all
of them in its file. EFNL returns exactly one, but that is not guaranteed
generally.

### 3.1 Why the split is current versus retired

This is the property the layout is built on: **the archive is effectively
immutable.** It changes when a season retires — once a year per organisation —
so it is written once, cached indefinitely by a browser or CDN, and stored once
by git. Only `current` is rewritten by the roughly sixteen scheduled runs a
weekend, and its size stays flat as history accumulates instead of growing every
year.

A visitor looking at this season downloads only `current`. The archive is
fetched when someone asks for a past season, and then never again.

### 3.2 Retirement rule and the rollover

A season moves from `current` to `archive` when **its status is COMPLETED and
its `endDate` is more than 30 days in the past.** Both conditions, deliberately:
a season whose status has flipped but whose results are still being amended stays
live, and PlayHQ is not always prompt about flipping status.

`endDate` arrives as `YYYY-MM-DD`. Adding 30 days needs arithmetic, so build the
comparison with `Date.UTC(y, m - 1, d)` from split components — never
`new Date(string)`, per `working_practice.md`.

**⚠️ CORRECTION 2026-08-11 — the implemented order is the reverse of this.**
`discover-seasons.js` sets `retired` and `file` and rebuilds the manifest; the
records move later, on the next `store.save()`. So the manifest points at
`-archive.json` files before they exist — 48 entries do so today. The writers
survive it because `filesForScope()` opens both files for an organisation
regardless, and `index.html` derives its paths from the organisation code rather
than reading `manifest.file`, so nothing currently follows a dangling pointer.

That is luck, not design. Either the ordering below must be implemented, or
`manifest.file` must be documented as a prediction rather than a location.

The intended order was: append the season to `archive`, rewrite `current`
without it, then update the manifest, so a failure part-way leaves the manifest
pointing at data that is still there.

**Known cost, accepted.** Appending to the archive rewrites it, so year N stores
a blob holding N seasons. Over a handful of years that is bounded and small —
AFL history on PlayHQ currently reaches back only to 2024. Over a decade it
becomes the weak point of this layout, and is worth revisiting then rather than
designing around now.

**`core.json`** holds only what is genuinely cross-competition:

- `clubs` and `teamClub` — a club plays in more than one competition
- `compLogos`, `venues`
- `manifest` — one entry per competition-season: organisation code, season id,
  display name, status, start and end dates, file path, and byte size

The manifest is what makes on-demand loading possible: the dashboard reads
`core.json` first and then fetches only the competition-seasons it needs.
`core.json` should stay under a few hundred KB.

**Each organisation file** holds `matches`, `roster`, `gradeMeta`, `lastRound`,
`players`, `teamLogos` and **its own grade list per season** for its seasons.
The grade list is required because grade ids are season-scoped and `grades.json`
holds only the current ones — see §6.1. Records carry a season id so the two
files have the same shape and the archive is just the same structure with more
seasons in it.

**⚠️ CORRECTION 2026-08-11 — this was NOT built as described.** The paragraph
below claimed `lastRound`, `gotwFlags` and `teamLogos` would be fixed by
construction by living in the per-organisation file. They are in `CORE_KEYS` in
`store.js` and therefore in `core.json`, so all three still carry their original
missing-competition keys:

- **`lastRound` is keyed `age|rawGrade`** — no competition and no season. **The
  Phase A backfill will corrupt it**: writing EFNL 2025 overwrites the live 2026
  value for every age and grade they share. The backfill must either not write
  `lastRound` at all, or the key must be fixed first.
- **`gotwFlags` is keyed `age|roundKey`** — same defect, and it is read by
  `index.html` in three places.
- **`teamLogos` is keyed by bare team name** — same exposure, though the
  colliding value is usually the same URL, so the damage is cosmetic.

Moving them into the per-organisation file remains the right fix and is not
done. Until it is, treat all three as cross-competition state.

**`gotwFlags` is empty** (0 entries). It is preserved on merge by three writers.
Whether it is still used should be settled before it is carried into the new
layout.

---

## 4. What the dashboard does

**The dashboard already views one competition at a time.** `init()` sets
`S.selComp` to the first available competition and never leaves it null while any
exist (line 1491). Both the match filter (line 1404) and the player filter
(line 1382) are `x.compName === S.selComp`, and `selectComp()` resets age, grade,
round and team on every change. So the per-organisation split maps onto the
existing model rather than fighting it — far less work than assumed.

Load `core.json`, then the selected organisation's `current` file. A page view
becomes roughly 1.8 MB average against 36.57 MB today, improving further once §5
is applied. The `archive` file is fetched only when a past season is chosen.

**Loading is a single `fetch('data/data.json')` in `init()` (line 3541)**, gated
on `location.protocol !== 'file:'`, with everything unpacked into `S` from lines
3545 to 3564. There is no deferral of any kind today, so on-demand loading is new
behaviour rather than an adjustment to existing behaviour.

The finals view's by-club mode is the one place worth checking for a
cross-competition assumption before step 5; line 2463 carries an "All comps"
label, which suggests a state the competition filter does not otherwise produce.

---

## 4a. ⚠️ Before removing or renaming ANY stored field

**Run `scripts/report-field-usage.js` first. This is not advisory.**

On 2026-08-11 `hLogo` and `aLogo` were removed from match records after
confirming `index.html` rendered crests from `teamLogos` instead. That check was
correct and the conclusion was still wrong: `build-club-index.js` derived every
club identity by scanning `hLogo`/`aLogo` on match records, so the next full run
would have resolved zero clubs and — because a full run *replaces* `teamClub`
rather than merging — committed an empty index over 2,032 entries.

The dependency was documented in this file, in `team_registry_design.md`, and in
that script's own header. It was still missed, because §7 of this document asked
"what does `index.html` read?" and nothing asked "what does anything else read?"

**The producer/consumer map is generated, not maintained by hand.** A prose list
goes stale silently, which is the same failure in slower motion.

**Fields touched by more than one writer**, from the 2026-08-11 scan. Changing
any of these by editing one script breaks the others:

| Field | Writers referencing it |
| --- | --- |
| `matches` | fetch-results, fetch-fixtures, fetch-stats, build-club-index |
| `roster` | fetch-results, fetch-fixtures, fetch-stats |
| `gotwFlags` | fetch-results, fetch-fixtures, fetch-stats |
| `teamOrg` | fetch-results, build-club-index |
| `clubs` | fetch-stats, build-club-index, discover-seasons, discover-orgs |
| `hLogo` / `aLogo` | fetch-results, fetch-fixtures, build-club-index |
| `home` / `away` | fetch-results, fetch-fixtures, build-club-index |
| `age` / `compName` | fetch-results, fetch-fixtures, fetch-stats, build-club-index |
| `isBye` / `isPartial` / `provisional` | fetch-results, fetch-fixtures, build-club-index |
| `venue` / `vSuburb` / `venueUrl` | fetch-results, fetch-fixtures |
| `seasonID` | fetch-results, fetch-stats, build-club-index, discover-seasons |

The tool reports a **reference**, not a read or a write — it cannot distinguish
them, and pretending otherwise would produce confident wrong answers. A non-zero
cell means go and read that file, not that the field is safe or unsafe.

Its own blind spot is the `SOURCES` and `FIELDS` lists at the top of the script:
a file or field missing from those is invisible to it. Both must be updated when
either changes, and that is the one part still maintained by hand.

---

## 5. Redundancy removal

Do this **before** backfilling. Backfilling first writes several times more data
than necessary and every later change rewrites all of it.

1. **Drop `hLogo` and `aLogo` from match records** — done 2026-08-11, but see
   §4a: the first attempt broke `build-club-index.js`. `fetch-results.js` now
   captures the club code at fetch time into `teamOrg`, keyed `comp|team|age`,
   and `build-club-index.js` reads that instead of scanning match logos.
   Verified safe for the dashboard: Crests
   render through `crestHTML()` → `getCrestImg()` → `S.teamLogos`, never from the
   match record. The only reads of `m.hLogo`/`m.aLogo` are in `isProvSide()`
   (line 2024) and the fixture row (lines 1715–1727), and both are guarded by
   `m.provisional`, which is present on **69 of 13,178 records**. Keep them on
   provisional records, drop them everywhere else. −3.82 MB with no functional
   change.
2. **Drop the player fields `index.html` never reads.** −6.62 MB, no dashboard
   change. Done 2026-08-11.

   The earlier version of this section claimed 11.04 MB and had the analysis
   backwards. Counted against `index.html`: `p.name` is read 7 times and
   `firstName`/`lastName` **zero**, so `name` is load-bearing and the two
   components were write-only. And most of what was listed as derivable is read
   directly — `p.team` 23 times, `p.teamRaw` 10, `p.age` 8, `p.rawGrade` 7,
   `p.compName` 6, `app.team` 6.

   | Dropped | Bytes | Reads in `index.html` |
   | --- | --- | --- |
   | `firstName` + `lastName` | 1.81 MB | 0 |
   | `gradeName` (top level) | 1.53 MB | 0 |
   | `appearances[].gradeName` | 2.21 MB | 0 |
   | `appearances[].rawGrade` | 1.07 MB | 0 |

   `gradeID` is **kept** at both levels as the join key to `grades.json`, which
   is what a season-scoped archive needs to resolve a grade.

2a. **The remaining ~4.4 MB is a coupled change, not an inert one.** Dropping
   `team`, `compName`, `rawGrade`, `age` or `app.team` requires `index.html` to
   derive them, so script and dashboard must ship together. Deferred until after
   the split, when `index.html` is being changed anyway.
3. **Normalise venues** into `core.json` keyed by venue id, with latitude and
   longitude stored properly. `venueUrl` is currently the only place the
   coordinates survive — `fetch-results.js` builds the URL and discards them.
   −1.45 MB approximately.
4. **`id` on match records is derivable** but is left alone for now: the dedup
   map in `fetch-results.js` is keyed on it throughout, and 914 KB does not
   justify reworking that. Recorded so it is a decision rather than an oversight.

---

## 6. Ingestion

### 6.1 Backfill — two phases, one script

**⚠️ FIXED 2026-08-11 — `store.save()` could not create a file under a scope.**
`filesForScope()` filtered to existing paths and `save()` built its permission
set from that, so a scoped run whose records belonged in a file that did not yet
exist — exactly a Phase A run writing the first `-archive.json` — dropped those
records and reported success. `save()` now takes the files a scope *covers*
rather than the files that exist, and refuses to complete if the number of
records bucketed does not match the number loaded.

Walks the configured organisations, reads their seasons from
`discoverCompetitions`, and writes one file per competition-season.

**Phase A — results and ladders.** Matches, roster, `gradeMeta`, `lastRound`,
`teamLogos`. Run first, across every season.

**Phase B — player statistics.** Run later, competition-season by
competition-season, over the offseason. Decided 2026-08-11: history gets both
eventually, but results first so the dashboard is useful sooner.

The two phases must be independently runnable and idempotent, so the workflow
takes the phase, an organisation and a season as inputs and Phase B can be run
in small batches without rewriting Phase A's output.

**Volume, from the §1 measurements after §5 redundancy removal.** Phase A is
roughly 0.7 MB per competition-season on average and about 1.5 MB for EFNL, so
sixteen competitions across their seasons is on the order of 40 MB. Phase B is
the bulk — around 3.2 MB per competition-season, or roughly 180 MB for the same
set. Both are extrapolations from the current season's proportions.

**It must bypass the season-ended guard.** `fetchGrade` returns early when a
grade's latest month is in the past, which is correct for scheduled runs and
fatal for a backfill.

**Phase B is possible — both dependencies verified 2026-08-11** by
`probe-search.js` against EFNL's three seasons:

| Season | Status | Grades from `discoverSeason` | `gradePlayerStatistics` on a grade |
| --- | --- | --- | --- |
| 2026 `2dcbf383` | ACTIVE | 86 | 402 records over 9 pages |
| 2025 `75d8a232` | COMPLETED | 84 | 387 records over 8 pages |
| 2024 `ca9cc98b` | COMPLETED | 83 | 398 records over 8 pages |

Both calls behave identically on completed seasons, returning real named players.
The worry was well founded but wrong: the reference records `publicProfileTeams`
returning a null grade for completed seasons, so PlayHQ does withhold some things
once a season closes — these two are not among them.

**Phase B's API cost is modest.** `gradePlayerStatistics` is paginated at 50 per
page, so an organisation-season is roughly one call per grade plus one per 50
players — a few hundred calls. Sixteen organisations across their seasons is on
the order of 17,000 calls, which at the concurrency already proven on this tenant
is well inside a single run. An extrapolation, not a measurement.

**Skip Phase 2 profile lookups for completed seasons.** `fetch-stats.js` calls
the quota-limited `publicProfileStatistics` to decide which club a multi-club
player *currently* belongs to. For a season that finished two years ago "current
club" is not the right question — the club they played the most games for is —
and that is exactly what the existing fallback heuristic computes. Skipping the
lookup for completed seasons removes the one genuinely rate-limited call from the
entire backfill, and produces a more appropriate answer rather than a worse one.

**⚠️ Grade ids are season-scoped.** EFNL's Premier Senior Men grade is `6f964e7b`
in 2026, `1debae74` in 2025 and `25a4f589` in 2024. The redundancy removal in §5
derives player fields from `gradeID` through `grades.json`, which holds only the
configured current seasons — so **each organisation file must carry its own grade
list per season**, or the archive cannot be read without it. At roughly 85 grades
per season this is about 9 KB per organisation-season, which is negligible
against the saving it enables.

**⚠️ File completeness is NOT implemented, at either end (2026-08-11).**

`store.save()` writes `phases: { results, players }` **per file**, inferred from
record counts. An archive holding 2025 results-only and 2024 results-and-players
reports one flag pair for both, which answers the wrong question.

`discover-seasons.js` writes `phases: { results: false, players: false }` per
manifest entry, commented "filled in by the writers". Nothing fills it in —
`store.save()` copies only `CORE_KEYS` and `TIMESTAMP_KEYS` into core and never
touches `manifest` — and `discover-seasons.js` rebuilds the manifest from scratch
each run, so anything written there would be reset.

**This has to be built as part of Phase A**, because Phase A is what creates the
first season with results and no players.

**Two further gaps for Phase A to resolve:**

- **The per-season grade list has no key to live in.** §6.1 requires one and
  names no shape. `store.js` handles `matches`, `players`, `roster` and
  `gradeMeta` only; anything set on `data.grades` is dropped silently by both
  `load()` and `save()`.
- **The scope unit is a competition name, not a season.** `filesForScope()` adds
  both `-current` and `-archive` for an organisation unconditionally, so a run
  scoped to one retired season still rewrites the live file. Records round-trip,
  so it is not destructive, but it is not season-scoped either.

### 6.2 Scheduled runs — active seasons only

A COMPLETED season is immutable. Once backfilled it is never fetched again.
Scheduled runs touch only seasons whose status is ACTIVE or UPCOMING, which the
manifest already records. This is the single largest efficiency available: the
current run iterates every grade of every competition regardless of whether its
season is over.

### 6.3 Rate and session handling

Drawn from `playhq_api_reference.md` and from this project's own runs.

- **Concurrency.** Both fetchers are sequential with a 200 ms sleep — about five
  requests a second. `discover-orgs.js` sustained concurrency 8 on the `afl`
  tenant across roughly 1,900 calls with zero failures, so 8 is proven here. The
  reference records 25 for basketball; approach it in steps rather than assuming
  it transfers.
- **Session.** `getSession()` in both fetchers captures only `phq_session`. The
  reference is explicit that all three cookies are required in the order
  `phq_tier; phq_session; phq_sub`, and that the wrong order causes CloudFront
  403s. It also runs once at startup, while the cookie lives 30 to 40 minutes —
  so any run longer than that loses its session partway.
- **Typed failures.** A non-200 is currently a generic error, retried twice then
  skipped. That cannot distinguish a WAF block from an expired session from an
  application error. Type every call and test the body for `DOCTYPE` before
  deciding what a 403 means.
- **Phase 2 profile lookups.** `fetch-stats.js` calls `publicProfileStatistics`
  for multi-club players. The reference records a per-session JWT quota around
  30 to 35 for that call and a far stricter rate limit than anything else, and
  recommends a session refresh between every batch of 30. At five competitions
  this has evidently not bitten; at sixteen it will, and the failure is silent —
  a failed lookup falls back to the most-games heuristic and attributes a
  transferred player to the wrong club.

### 6.4 `config.json` and the manifest

`config.json` stops carrying `seasonID` and carries the 8-character organisation
code instead. Seasons come from the manifest, which `discover-seasons.js` writes
into `core.json` from `discoverCompetitions`.

```json
{
  "organisations": [
    { "code": "383836bb", "name": "EFNL", "vip": true,  "excludeGrades": [] },
    { "code": "2e137b81", "name": "AFL Barwon", "vip": false, "excludeGrades": [] }
  ]
}
```

**⚠️ `compName` must keep producing byte-identical strings.** It is embedded in
every match id (`compName|age|rawGrade|roundToken|teams`), in every `roster` key,
in every `gradeMeta` key, and match ids are what `gotwFlags` points at. Change
how it is composed and every stored record is orphaned in a single run.

So `compName` is derived as `` `${config.name} ${season.name}` ``. The probe run
confirms `discoverCompetitions` returns season names `2026`, `2025` and `2024`,
so `"EFNL"` plus `"2026"` reproduces `"EFNL 2026"` exactly, and the same holds
for the other four. **The `name` field in `config.json` is therefore not cosmetic
— it is half of a stored key**, and that needs saying where someone editing the
file will see it.

**Ordering.** The manifest must exist before a fetcher can find a season, so
`discover-seasons.js` runs first. Rather than relying on workflow ordering alone,
a fetcher that finds no ACTIVE or UPCOMING season for an organisation refreshes
that organisation's manifest entry itself, which makes a fresh clone and a
stale manifest self-healing.

`vip` and `excludeGrades` stay per organisation and behave as they do now.

### 6.5 Player scope

Transfers are confined to a single competition (decided 2026-08-11). The bucket
key `uuid|age|compName` stays as it is, players partition cleanly per
competition, and no cross-competition player index is needed.

**Stated limitation:** a player moving between competitions appears as two
unrelated records. This is accepted, not overlooked.

---

## 7. Confirmed against `index.html`

| Question | Answer |
| --- | --- |
| How is `data.json` loaded? | One `fetch('data/data.json')` in `init()`, line 3541. Whole file, no deferral, unpacked into `S` at 3545–3564. localStorage is loaded first and `data.json` overrides it. |
| What reads `player.appearances`? | The team drilldown, lines 2660–2688. It sums `gp`, `goals` and `bestPlayer` per `teamRaw` to attribute a multi-grade player's totals to the team being viewed. **Load-bearing — cannot be dropped.** |
| Does any view span competitions? | No. `S.selComp` is one competition and is never null while any exist. Both match and player filters compare `compName` to it. The finals by-club mode is worth a second look — see §4. |
| Is `gotwFlags` read? | Yes — see Q2. And its key omits the competition. |
| Are `hLogo`/`aLogo` read? | Only when `m.provisional` is true, 69 of 13,178 records. Crests come from `teamLogos`. See §5.1. |

**Also observed, unrelated to this design but worth recording:** `logoKey()` at
line 1005 builds `new RegExp('\s+' + c + '\s*$', 'i')` from a plain string, so
`\s` collapses to a literal `s` and the colour-stripping fallback has never
worked. `dashboard_context.md` already lists this under "Known broken, not
fixed"; it is still present.

---

## 8. Answered questions

**Q1 — Do completed seasons need player statistics?** *Answered 2026-08-11.*
Both, but phased: results and ladders across all seasons first, player data
backfilled competition-season by competition-season over the offseason. See
§6.1. This is contingent on the two unverified assumptions recorded there.

---

## 9. Open questions

**Q4 — Does `config.json` list organisation codes and let the manifest supply
seasons?** *Answered 2026-08-11 — yes*, matching `team_registry_design.md` §3.3.
See §6.5 for the shape and the constraint it carries.

**Q3 — How should files be divided?** *Answered 2026-08-11.* Two per
organisation: `current` for live seasons, `archive` for retired ones, with a
30-day quarantine before a season moves. Keeps the file count at roughly 32,
keeps the archive immutable and cacheable, and keeps the per-run rewrite flat.
See §3.1 and §3.2.

**Q2 — Is `gotwFlags` still used?** *Answered 2026-08-11 — yes.* Read at lines
1339, 1815 and 2611 to mark the admin-nominated Game of the Week. It is empty in
`data.json` because the admin tab writes it to localStorage (line 3466) and it
only reaches the committed file through the manual export at line 3486. It must
be carried into the new layout.

**⚠️ And it carries the same defect as `lastRound`.** The key is
`` `${age}|${rKey}` `` (line 1338) with **no competition**, so two competitions
with a U12 Round 3 flag collide. Today that is masked; across sixteen
organisations it is a live bug. Putting it in the per-organisation file fixes it
by construction, exactly as it does for `lastRound`.

*(none — all questions answered.)*

---

## 10. Build order

1. **Session and rate handling** in both fetchers — independent, benefits
   everything, and required before any large run.
2. **`report-data-size.js` re-run** after each redundancy step, to confirm the
   saving rather than assume it.
3. **Redundancy removal** — logos, then player fields, then venues.
4. **Split writers** to per-competition-season files plus `core.json`, with the
   manifest. All four writers change together or they will fight.
5. **Dashboard reads the manifest** and loads on demand.
6. ~~Verify the two Phase B assumptions in §6.1.~~ **Done 2026-08-11 — both
   confirmed.** See §6.1.
7. **Backfill Phase A** — results and ladders, all configured organisations,
   all seasons.
8. **Scheduled runs restricted** to ACTIVE and UPCOMING seasons.
9. **Backfill Phase B** — player statistics, in batches, over the offseason.

Steps 1 to 3 change no file layout. **Only the parts of step 3 verified as
unread by `index.html` are inert** — see §5.2 and §5.2a; the rest is coupled to
the dashboard and waits for step 5. Step 4 is the breaking change.

---

## 11. Not in scope

- **Moving storage off GitHub.** Cloudflare R2 was considered when the estimate
  was 5 GB. At a measured 117 MB for sixteen competitions at the current season,
  and roughly 233 MB with history after redundancy removal, GitHub Pages is
  comfortable and R2 adds a dependency for no gain.
- **Cross-competition player identity.** Decided against in §6.4.
- **Team identity and the season registry.** `team_registry_design.md`.
- **Enumerating beyond the configured organisations.** `org-discovery.json`
  lists 1,175 associations; which are included stays a configuration decision.
