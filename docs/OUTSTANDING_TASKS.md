<!-- docs/OUTSTANDING_TASKS.md -->
# Outstanding Tasks — Local Footy Dashboard

<!-- This repo only. The 869-line OUTSTANDING_TASKS.md in the sports-players-stats -->
<!-- project is a different system and does not belong here. -->
<!-- Revision: 2026-08-10 -->

Ordered by whether the next piece of work depends on it.

---

## 1. Multi-season support — the next major piece

The dashboard is single-season. Everything below is groundwork already
established; none of it is built.

**Season discovery.** `discoverCompetitions(organisationID)` returns every season
an organisation has played, with `id`, `name`, `startDate`, `endDate` and
`ACTIVE`/`COMPLETED` status. One call per organisation replaces the hand-maintained
`seasonID` values in `config.json`. Exactly one season per year per organisation.
A probe on 2026-08-10 returned "There was an error. Please try again later",
most likely rate limiting rather than a wrong query — the same call works from a
browser. **Retry before designing around it.**

**Team identity is the hard problem, and it must be settled once.** Team identity
is currently derived from a cleaned display name. Both fetchers request the PlayHQ
team `id` and discard it. Organisation ids appear stable across seasons; team ids
appear season-scoped — a U8 team in 2025 is not the U9 team in 2026.

*Verify first, do not assume:* query `discoverTeams` for a known club against the
2025 season id (`75d8a232` for EFNL) and check whether any team id matches 2026.

Re-keying match ids would touch every record in `data.json` plus `gotwFlags`,
`roster` and `teamLogos`. It should be decided in a design document, not
incrementally.

**Historic data to absorb.** `2024.html` and `scripts/fetch-u10-2024.js` were
removed in the 2026-08-10 tidy and need restoring from git history. `2024.html` is
45 KB and there is no separate 2024 data file, so it likely embeds that season and
is its only standalone copy. `fetch-u10-2024.js` is a working example of fetching
a past season.

---

## 2. Verify `DiscoverTeam.organisation`

`playhq_api_reference.md` documents `organisation { id name }` on `DiscoverTeam`.
The club index was built on logo-URL derivation because a probe asked for `club`
and got a validation error — the field is named `organisation`.

If `organisation` on a team is the club rather than the league, both fetchers can
capture the club id at fetch time, `build-club-index.js` becomes unnecessary, and
teams with no logo are covered too. One probe settles it.

---

## 3. ~~Minify `data.json`~~ — DONE 2026-08-10

Applied across all four writers (`fetch-results`, `fetch-fixtures`, `fetch-stats`,
`build-club-index`) in the same commit as the `data/` relocation. All four must
agree, or whichever runs next re-inflates the file and every run produces a
whole-file diff.

53 MB to about 41.5 MB — 21.7% measured on representative records. Does not
shrink `.git`; the pretty-printed blobs remain in history.

`grades.json` and `clubs.json` are deliberately left pretty-printed. They are
84 KB and 14 KB and get read by eye.

---

## 4. ~~Retire `migrate-grades.js`~~ — workflow cleared 2026-08-10

The `run_migration` input, both migration steps in `fetch-results.yml`, the admin
panel checkbox and the `run_migration` entry in the dashboard's dispatch payload
were all removed together. They had to go together: the admin panel sent
`run_migration` on **every** dispatch, so removing only the workflow input would
have made every admin-triggered fetch fail with a 422 "Unexpected inputs
provided".

The script itself can now be removed with `repo-tidy.yml`, `groups: migration`.

**Check the Cloudflare Worker first.** `footy-cron` dispatches this workflow on a
schedule. If its payload includes `run_migration`, every scheduled run will now
fail with a 422. The Worker source is not in this repo and was not checked.

---

## 5. Known-broken, low priority

**`lastRound` is dead in the dashboard.** It reads
`S.lastRound["comp|age|grade"]`; `fetch-results.js` writes `"age|grade"` with no
competition prefix. The round label on the ladder grade tabs has never rendered.
Fix by adding the prefix in the writer, or dropping the prefix in the reader —
the writer is the better place, since the key space is otherwise
competition-scoped everywhere.

**`logoKey()` colour stripping does not work.**
`new RegExp('\\s+' + c + '\\s*$')` uses a plain string, so `\\s` collapses to a
literal `s` and the pattern becomes `/s+Purples*$/`. Unnoticed because
`teamLogos` is keyed by full team name and usually hits exactly. Fix is `'\\\\s+'`
or a regex literal.

**A fatal script error does not fail the workflow run.** `fetch-results.yml`
captures the exit code with `set +e` and commits only on `0`, so a crash shows as
a green run with no commit. Applies to all four jobs; fix them together or not at
all.

---

## 6. Documentation

`README.md` is current at 0.124 and matches the post-tidy 28 files. If
`2024.html` and `fetch-u10-2024.js` are restored, the repo structure block needs
them back.

`playhq_api_reference.md` is shared with `sports-players-stats`. Any discovery
about PlayHQ's behaviour, as opposed to this repo's code, belongs there and must
be carried across to that project's knowledge — there is no cross-project sharing
in Claude Projects, so drift between copies is invisible unless it is called out.
