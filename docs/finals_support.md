<!-- docs/finals_support.md -->
# Finals Support — Implementation Notes

**Repo:** `markjovic/junior-footy-dashboard`
**Shipped:** finals ingestion and display landed across Beta 0.116–0.124;
`fetch-results.js` and `fetch-fixtures.js` updated, `build-club-index.js` added.
The finals view gained club aggregates, sorting, filters and a winners mode
through 0.131. These are the versions the work shipped in, not the current
version — read that from `index.html`.
**Written:** 2026-08-10. Supersedes `finals_design.md`, which was the pre-build
specification.

---

## 1. The problem this solved

Finals were not being ingested at all. Every grade's results stopped at the last
home-and-away round, silently, with no error.

**Root cause.** PlayHQ restarts finals round numbering at 1 in every grade.
Verified across all 249 grades on 2026-08-09: 158 have finals, and every one of
them numbers them from 1 while home-and-away rounds end at 14 to 18.

`fetch-results.js` tracked progress with `highestKnown`, the highest consecutive
round from R1. A finals round arrived with `number` 1, 2 or 3, the check
`number < highestKnown` was true, and the round was skipped as "already stored"
before any fixture call was made. The re-check branch only fires on
`number === highestKnown`, which a finals round never reaches.

The one piece of good news was that the ladder had never been contaminated,
because no finals results existed to contaminate it with.

---

## 2. What PlayHQ actually returns

Measured, not assumed. All figures from the 2026-08-09 sweep.

**Round numbering restarts at 1** in all 158 grades with finals, across EFNL,
WFNL, SEJ, SER and YJFL. No grade continues the home-and-away sequence.

**`abbreviatedName` is populated on all 480 finals rounds.** Six distinct values:

| Abbrev | Name(s) returned | Rounds |
|---|---|---|
| `GF` | Grand Final | 158 |
| `FR1` | Finals Round 1 | 154 |
| `PF` | Preliminary Final, Preliminary Finals | 154 |
| `FR2` | Finals Round 2 | 11 |
| `SF` | Semi Finals | 2 |
| `EF` | Elimination Finals | 1 |

**The name is not stable but the abbreviation is.** WFNL returns the plural
"Preliminary Finals" where EFNL returns the singular; both map to `PF`. Key on
the abbreviation, display the name.

**Five series shapes exist:** `FR1→PF→GF` (142 grades), `FR1→FR2→PF→GF` (11),
`GF` only (3, the SEJ Lightning Premiership), `FR1→SF→PF→GF` (1), and
`EF→SF→GF` (1, SER U15 Boys Premier).

**Undetermined finals fixtures arrive as `ProvisionalTeam`**, with a `name` such
as "Winner Game 1" or "Loser Game 3" but no `id`. Both fetchers previously
spread only `... on DiscoverTeam`, so those objects returned empty and the game
was discarded at `if (!homeName || !awayName) continue;`.

**Grades are returned strongest-first within each age.** This is the only sound
source of grade strength, because colour-named grades carry no order in their
names:

```
EFNL  U11 -> A, B, C, D1, D2
SER   U13 -> Premier Division, Blue, Gold, Navy, Orange
SEJ   U11 -> Blue, Red
```

**`DiscoverTeam` has no club field.** Confirmed: `Cannot query field "club" on
type "DiscoverTeam"`. Introspection is disabled on the API.

---

## 3. Data model

### Round identity

A round token replaces the bare round number in every id and sentinel key:

```js
roundToken(number, finalsAbbrev)   // "14"  for home-and-away
                                   // "F:GF" for finals
```

Home-and-away rounds return the bare number, so **all 12,765 pre-existing ids
are byte-identical**. No migration was required and none was performed.

```
home-and-away:  EFNL 2026|U12|B|14|Norwood|Vermont
finals:         EFNL 2026|U12|B|F:GF|Norwood|Vermont
```

Without this, a Grand Final in a grade whose Round 1 featured the same two clubs
would overwrite that Round 1 result with no error anywhere.

### Match record additions

```
isFinals:      true
finalsAbbrev:  "GF"            // key — stable across competitions
finalsName:    "Grand Final"   // display only, never a key
provisional:   true            // a side is a placeholder, not a club
```

`round` keeps PlayHQ's raw number. Ordering is a two-key sort on
`(isFinals, round)`, never a derived sequence — a synthetic `maxHA + n` would
shift every finals record's sort key whenever a late home-and-away round
arrived, silently reordering history.

### data.json maps

| Key | Shape | Written by |
|---|---|---|
| `gradeMeta` | `{"EFNL 2026\|U12\|A": {r:1, lvl:'junior', g:'M'}}` | `fetch-results.js` |
| `clubs` | `{"6d405ccb": {name, type}}` | `build-club-index.js` |
| `teamClub` | `{"EFNL 2026\|Norwood Purple\|U12": "6d405ccb"}` | `build-club-index.js` |

`clubs.json` in the repo root caches resolved clubs so they are not re-fetched.

---

## 4. Club identity

PlayHQ has a first-class club, but it is not on `DiscoverTeam`. It is reachable
because **Cloudinary logo URLs embed the owning organisation's UUID**, whose
first eight hex characters are the public organisation code:

```
/production/afl/6d405ccb-cf15-4fbd-a5c8-bcde4ae5c3e6/.../logo.png
                ^^^^^^^^ = Norwood's organisation code
```

Every match record already stored `hLogo`/`aLogo`, so club identity was already
in `data.json` and needed no re-crawl. `discoverOrganisation(code)` then returns
the official name and confirms `type: "CLUB"`. Across all competitions this
resolved 165 clubs and 2032 teams with **zero teams unattributed**.

**Do not derive clubs from team names.** `Norwood Gold/Heathmont U12` is a
merged team that no stripping rule maps to Norwood, and Templestowe fields two
separate organisations — `225d5de5` Templestowe (EFNL) and `2545b284`
Templestowe Junior Football Club.

**`teamClub` is keyed `compName|teamName|age`**, matching `rebuildRoster`. Age is
load-bearing: `cleanTeam` strips the grade's age from the display name, so the
senior and junior Templestowe teams both arrive as plain "Templestowe", and
"Norwood U12 Purple" and "Norwood U14 Purple" both become "Norwood Purple".
Without age in the key they collapse and a majority vote picks one club for all
of them.

`discoverTeams(filter: {seasonID, organisationID})` is deliberately **not** used.
It returns only teams registered under that season, so a club from another league
fielding a team in an EFNL grade comes back empty.

**Correction, 2026-08-10.** The probe that concluded "DiscoverTeam has no club"
asked for `club { id name }`. The field is named **`organisation`**, and
`playhq_api_reference.md` documented `organisation { id name }` on `DiscoverTeam`
all along; `club` exists only on `publicProfileStatistics`. The logo derivation
works and resolved every team, so nothing here is wrong — but if `organisation`
on a team is the club, the fetchers could capture it directly and this whole
mechanism becomes unnecessary. Unverified; do not build on it without checking.

---

## 5. Pipeline changes

### `fetch-results.js`

- Captures `isFinals` / `finalsAbbrev` / `finalsName`; `abbreviatedName` added to
  `Q_GRADE_ROUNDS`.
- **Two independent tracks.** `knownRounds` is computed over home-and-away
  records only and keeps its consecutive-from-R1 meaning. `knownFinals` holds
  the finals abbreviations already stored *and complete* — a partial is
  deliberately absent so it is re-fetched. The most recently stored finals round
  is always re-checked, mirroring the home-and-away behaviour.
- **Scoped to home-and-away:** the implied-bye backfill (which used
  `roundList[0]`, now `find(r => !r.isFinalsRound)`), `rebuildRoster`,
  `lastRound`, and the output sort.
- **Stalled-partial promotion now orders by position in `roundList`**, not by
  round number. With finals restarting at 1, "R14 partial versus GF complete" is
  not a numeric comparison — it would conclude 14 > 1 and never promote.
- Emits `gradeMeta` (see §6).
- Exits 0 when *either* matches or `gradeMeta` changed. Previously only match
  counts were considered, so grade metadata could be written to `data.json` and
  then never committed.

### `fetch-fixtures.js`

- Same finals capture.
- `Q_FIXTURE` spreads `... on ProvisionalTeam { name }`. A side with a name but
  no `id` is flagged `provisional: true`, its name stored verbatim (placeholders
  must not go through the age-stripping cleaner), and no logo attached.
- The `currentRoundIndex` fallback — used when no round is flagged current —
  now considers home-and-away rounds only. With finals records in `data.json`
  its pool included rounds numbered 1–3 and could match the wrong entry.

### `build-club-index.js` (new)

Scans stored logos, resolves unknown clubs via `discoverOrganisation`, writes
`clubs` and `teamClub`. A team's club is decided by **counting** the club id
across all its records rather than trusting the first, and any team whose logos
disagree is reported with counts rather than silently resolved.

---

## 6. Grade metadata

```
gradeMeta["EFNL 2026|U12|A"] = { r: 1, lvl: 'junior', g: 'M' }
```

- **`r`** — strength rank from PlayHQ's own grade ordering, counted within each
  competition and age. Rank 1 is the top grade. Grading grades are excluded so
  they cannot consume a slot and push every real grade down one.
- **`lvl`** and **`g`** — from the API's `age.value` and `gender.value`, which
  `Q_GRADE_LIST` already selected and nothing had been reading.

**Rank is meaningful only within one competition and one age.** Never compare an
EFNL "A" with an SER "Blue".

**PlayHQ classifies U19.5 as SENIOR.** Any "age starts with U" rule gets this
wrong. PlayHQ also returns `ageName: "U17"` for U17.5 competitions, so the API is
authoritative in both directions.

`gradeMeta` and `grades.json` are both **merged per competition**: every
competition a run covered is rebuilt from scratch, and any competition it did not
touch is left untouched. A blind key merge would leave withdrawn grades behind
forever and inflate the tier count shown on team rows.

---

## 7. Dashboard behaviour

### Exclusions

Finals never count towards the ladder. Applied in `computeLadder`,
`renderLadder`'s `latestRound`, the team drilldown stat strip and home/away
breakdown, both computations in `renderStats`, and the form strip. Finals still
appear in the drilldown results list; they just do not reach the numbers above
it. The ladder header freezes at **each grade's own** maximum non-finals round,
which runs from 14 to 18 depending on competition.

### Game of the Week

`getGOTWMatch` used `Math.max(...round)`. With finals numbered from 1 the maximum
stays on the last home-and-away round, so GOTW would silently freeze there once
finals began. It now uses the two-key ordering. `gotwFlags` keys on
`age|roundKey`; `roundKey` returns the bare number for home-and-away rounds, so
every previously stored flag still matches.

### Results and fixtures

Grouped and sorted on the round key, headed with the round name, finals above
home-and-away. Each finals row carries its abbreviation beside the grade tag.
The round dropdown gains named finals entries.

**`ladderCutoff()` exists because `S.selRound` became a key.** `computeLadder`
does `m.round <= parseInt(maxRound)`, and `parseInt('F:GF')` is `NaN`, against
which every comparison is false — selecting "Grand Final" would have emptied the
ladder with no error. A finals selection yields `''`, which the existing
"no cutoff" branch already handles.

### Finals view

A separate top-level view (`#finals-view`), mutually exclusive with `#dash`. It
is not a card in `.dgrid` because the dashboard is scoped to a single
`S.selectedAge` and the by-club mode is cross-age by definition. Adding an
"All ages" option to `#age-sel` was rejected: `computeLadder`, `getGOTWMatch`,
`getTopScorers` and `renderResults` all assume one age.

**By age group** — one block per age, one row per grade, columns driven by that
grade's own finals rounds so each series shape renders at its own width.

**By club** — one block per club, each team tagged with age, grade and rank
(`TOP` in gold, otherwise `2/4`). Sortable alphabetically (default), by grade
strength, or by teams, remaining, GF appearances or premierships.

**Grade strength** compares tier by tier: two top-grade finalists beat ten
second-grade ones. Deliberately not a weighted score — any formula invites
argument and stops the number being checkable.

**Gender and level filters** apply to both modes and flow through to every
statistic including the headline. Gender is read from `gradeMeta`, falling back
to a regex on age and grade only for grades not yet in the map.

---

## 8. Status rules

For each team in a finals campaign:

- **out** — its last played game was a loss, it has no fixture after it, and a
  later round exists in that grade. The team's own fixture list is the
  authority, so the double chance needs no special handling: losing a qualifying
  final leaves a preliminary final fixture, and that fixture is the proof.
- **inGF** — named in a Grand Final, played or scheduled.
- **wonGF** — won a played Grand Final.
- **remaining** — not out, and has not yet played a Grand Final.

An earlier version also refused to claim elimination while any later round in the
grade held a provisional side. That was wrong: the Grand Final shows
"Winner Game 3" in nearly every grade, so the guard suppressed *every*
elimination and all 17 Blackburn teams read as remaining when 5 were out.

**Known limitation.** This depends on the next round's fixture being published.
If a team loses and `fetch-fixtures` has not run since, it shows as out until it
does.

---

## 9. Traps

- **`FINAL` already means "completed game"** in this codebase
  (`status.value === 'FINAL'`). Never name a finals field `isFinal`.
- **Provisional records must never reach** `rebuildRoster`, `allTeamsForAge`,
  `teamLogos`, the team dropdown, or the ladder. "Winner Game 3" would become a
  team. `S.matches` excludes scheduled records, which is what keeps the team
  dropdown clean.
- **Placeholder text is not always "Winner Game N".** "Loser Game 1" and
  "Loser Game 3" both occur. Detection is structural — a side with a name but no
  `id` — not a string match.
- **`excludeGrades` in `config.json` shifts grade ranks.** Excluded grades are
  filtered before discovery and do not consume a rank slot, so excluding "U12 - A"
  silently makes "U12 - B" the top grade. Empty in every competition at time of
  writing.
- **PlayHQ ordering is a strong observed pattern, not a documented guarantee.**
  If it ever changes, ranks shift silently.

---

## 10. Known issues not fixed

- **`lastRound` is dead code in the dashboard.** It reads
  `S.lastRound["comp|age|grade"]` while `fetch-results.js` writes `"age|grade"`
  with no competition prefix. The round label on the ladder grade tabs has never
  rendered.
- **`logoKey()` colour stripping does not work.** `new RegExp('\s+' + c + '\s*$')`
  uses a plain string, so `\s` collapses to a literal `s` and the pattern becomes
  `/s+Purples*$/`. It goes unnoticed because `teamLogos` is keyed by full team
  name and usually has an exact hit.
- **Team identity is derived from a cleaned display name, not the PlayHQ team
  `id`** — which both fetchers request and discard. This is the root cause of the
  `toClubName` / `normaliseClub` / `CLUB_STRIP` heuristic stack in
  `fetch-stats.js`. Team ids appear to be season-scoped while organisation ids
  are stable across seasons; that needs verifying before anything is built on it.
  Deferred to the multi-season work.

---

## 11. Tooling added

| Script | Purpose | Status |
|---|---|---|
| `probe-finals-rounds.js` | Round structure, numbering scheme, fixture shapes | Kept — re-run each season to detect a numbering change |
| `probe-team-club.js` | Whether `DiscoverTeam` exposes a club | **Removed 2026-08-10.** It asked for `club` when the field is `organisation`, so its recorded conclusion was wrong and re-running it would re-teach the error |
| `probe-club-index.js` | Validated the logo-to-club-id derivation | Removed 2026-08-10 — `build-club-index.js` performs and reports the same derivation on every run |
| `build-club-index.js` | Builds `clubs` and `teamClub` | Live |

All probes are `contents: read` and verify a clean working tree before finishing.
