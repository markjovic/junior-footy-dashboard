<!-- NOT a repo file. Replacement text for docs/dashboard_context.md. -->
<!-- Repo-specific — do NOT copy any of this into sports-players-stats. -->
<!-- Drafted 2026-08-11. Evidence: probe-search.js and discover-orgs.js runs,   -->
<!-- 2026-08-11. PlayHQ behaviours are deliberately NOT duplicated here; they   -->
<!-- belong in playhq_api_reference.md, which has its own pending updates.      -->

# Updates to dashboard_context.md

Targeted replacements rather than a whole-file rewrite, so that anything edited
since revision 2026-08-10 is preserved. Six corrections, two additions, and one
contradiction I cannot resolve without reading the writers.

---

## 1. Bump the revision line

```
<!-- Revision: 2026-08-11 -->
```

---

## 2. "Reading the repo" — the paste block is missing files

Add these lines. `team_registry_design.md` was already absent before this work,
so the block has been incomplete for a while.

```
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/team_registry_design.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/discover-orgs.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/org-discovery.html
```

`scripts/probe-search.js` is deliberately omitted — it is a throwaway diagnostic
and should be deleted rather than maintained.

---

## 3. Ownership table — add one row

| Writer | Owns |
| --- | --- |
| `discover-orgs.js` | `data/org-discovery.json` |

`discover-seasons.js` and `fetch-teams.js` are proposed in
`team_registry_design.md` but do not exist. Add their rows when they are built,
not before — a table that lists files which are not there is the same failure as
a document recording a fix that was never applied.

---

## 4. Standing traps — CORRECT the club/organisation entry

Replace the existing entry, whose last two sentences are now false:

> **The club field on a team is `organisation`, not `club`.** A probe asked for
> `club { id name }` on `DiscoverTeam`, got a validation error, and the club
> index was built on logo-URL derivation instead. `club` exists only on
> `publicProfileStatistics`.
>
> **`organisation` on a team IS the club — verified 2026-08-11.** One EFNL season
> returns 60 distinct organisations, which the league could not be, and the names
> confirm it: `Blackburn (Eastern Football Netball League)`. The id comes back in
> 8-character form, so it joins straight to `discoverOrganisation(code:)`. This
> means `build-club-index.js` and the logo-URL derivation can be retired — see
> `team_registry_design.md` §3.4, and do not retire it until club coverage is
> confirmed at least as good.

---

## 5. Current state — DELETE the "open lead" paragraph

The paragraph beginning **"Open lead worth an hour: does
`DiscoverTeam.organisation` return the club?"** is answered. Delete it; item 4
above carries the answer.

---

## 6. Current state — CORRECT the multi-season groundwork

The bullet beginning **"`discoverCompetitions(organisationID)` returns every
season an organisation has played…"** ends by attributing its failure to rate
limiting. That is wrong. Replace the bullet with:

> - `discoverCompetitions(organisationID)` **works**, and the earlier failure was
>   the request rather than the session. `seasons` takes a required
>   `organisationID` argument, and `organisationID` must be the 8-character
>   organisation code, not the UUID. Verified 2026-08-11 by controlled
>   comparison; full detail in `playhq_api_reference.md`. It removes the need to
>   hand-maintain `seasonID` in `config.json`, and it returns past seasons as a
>   by-product. One call per organisation.

Also replace the **"Organisation ids appear stable across seasons; team ids
appear season-scoped"** bullet with what is actually measured:

> - **Organisation ids look stable across seasons** — the same clubs appear in
>   EFNL's 2024, 2025 and 2026 team lists. The ids were not compared directly,
>   only the names, so treat this as strong evidence rather than a verified fact.
>   **Team ids across seasons remain unverified.** `discoverTeams` works on
>   COMPLETED seasons, so this is now one call per season to settle: fetch EFNL
>   2025 and 2026 and intersect the team ids.

---

## 7. Current state — ADD the discovery tooling

New paragraph:

> **Organisation discovery.** `scripts/discover-orgs.js` sweeps every AFL
> association on PlayHQ and writes `data/org-discovery.json`; `org-discovery.html`
> at the repo root views it. As at 2026-08-11: 1,175 associations, 277 active,
> 77 Victorian and active, and 386 with no location that could be established, of
> which only 36 are active. The viewer is versioned **separately** from the
> dashboard — it was Beta 0.3 when written, and has nothing to do with the badge
> in `index.html`.
>
> The sweep is `workflow_dispatch` only and is not on the Cloudflare Worker
> schedule. It does not need to be: organisations change slowly, and the run
> takes several minutes.

---

## 8. Repo state — needs recounting, not editing

The **"30 files, 37.8 MB as at 2026-08-10"** figures are stale. Added since:
`scripts/discover-orgs.js`, `org-discovery.html`, `data/org-discovery.json`
(2.13 MB), and two workflows. I have not counted the repo, so rather than write a
number I would be guessing at, recount it and update the sentence — an invented
figure in a context file is worse than an obviously old one.

---

## 9. "Known broken" — one to add, already fixed

Add to the **Known broken, not fixed** list, marked as resolved:

> - ~~**A VIP-only stats run deleted every other competition's players.**~~
>   **Fixed 2026-08-11.** `fetch-stats.js` ended with `data.players = players`,
>   where `players` was built only from the grades that run covered. EFNL is the
>   only `vip: true` competition, so every VIP-only stats run replaced the whole
>   player list with EFNL's alone, and the next all-competition run put the
>   others back. It now merges per competition — the same fix `fetch-results.js`
>   already carries for `grades.json` and `gradeMeta`.
>
>   This is the third instance of one defect, which is worth stating as a rule in
>   its own right: **anything derived from a filtered grade list must merge per
>   competition rather than replace.**

---

## 10. `data.json` is MINIFIED — the file is wrong in two places

Resolved 2026-08-11 by reading `fetch-results.js` line 1154:

```js
fs.writeFileSync(DATA_PATH, JSON.stringify(merged), 'utf8');
```

No indent argument. The code's own comment above it is explicit: "data.json is
written MINIFIED. At 53MB pretty-printed it was 98% of the repository." Both
statements in `dashboard_context.md` are therefore wrong and should be replaced:

- Under **Conventions**, replace "`data.json` is pretty-printed with
  `JSON.stringify(x, null, 2)`" with:

  > **`data.json` is written MINIFIED** — `JSON.stringify(merged)`, no indent
  > argument. Pretty-printing it produced a 53 MB file that was 98% of the
  > repository; minifying took it to 36.6 MB. All four writers must agree, or
  > whichever runs next re-inflates it and every run produces a whole-file diff.
  > **`grades.json` is separately pretty-printed** with `null, 2` — the two files
  > deliberately differ.

- Under **Current state**, the sentence beginning "`data.json` is written with
  `JSON.stringify(merged, null, 2)`" is wrong in the same way; the rest of that
  paragraph, about the 31% reduction applied across all four writers, is correct.

This was worth chasing rather than tidying past: the entry says all writers must
agree, so a writer following the documented `null, 2` would have silently
re-inflated the file on its next run.
