<!-- docs/project_setup.md -->
# Setting Up the Standalone Project

<!-- Revision: 2026-08-10 -->

What to do, in order, so the new project starts fully briefed.

---

## 1. Reading the repo directly — paste this first

Claude can fetch any file in this repository, but **only from a URL that already
appears in the conversation**. A URL it constructs itself is refused before any
request is made, and GitHub blocks automated access to folder pages, so it cannot
browse `docs/` to discover what is there.

Pasting the block below satisfies that condition for every file at once. Do it in
the project's **custom instructions** and it is present from the first message of
every conversation, with nothing to remember.

```
https://github.com/markjovic/junior-footy-dashboard/blob/main/README.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/dashboard_context.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/working_practice.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/playhq_api_reference.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/finals_support.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/OUTSTANDING_TASKS.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/project_setup.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/index.html
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-results.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-stats.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-fixtures.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/build-club-index.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/workers/footy-cron.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/config.json
```

**If that works, upload nothing.** The repository is the single source of truth,
every read is current, and no copy can drift. Test it once: ask Claude to read
`docs/playhq_api_reference.md` and see whether it fetches or refuses.

**If it does not work**, paste the block manually at the start of a conversation —
it unlocks every file for that session — or fall back to §2.

### Why not just upload everything

Project knowledge is a copy taken at upload time. It is always in context with no
tool call, which is genuinely faster, but it drifts the moment the repository
moves on and nothing surfaces the drift. That failure has already happened here:
this session opened with three documents claiming versions 0.92, 0.106 and 0.115
while the deployed code was 0.115, and only reading the file settled it.

---

## 2. Fallback — files to upload if repo reading does not work

```
README.md                 user-facing behaviour, current at 0.124
dashboard_context.md      repo-specific rules, traps, current state
finals_support.md         implementation notes for the finals work
working_practice.md       portable conventions (shared with other projects)
playhq_api_reference.md   PlayHQ behaviour (shared with sports-players-stats)
OUTSTANDING_TASKS.md      dashboard items only — see §4
```

**Do not upload** `claude_context.md`, `REPO_MANIFEST.md`,
`stattrack_html_design.md`, `stattrack-README.md`, `fixture_card_README.md`,
`config.json` or `colours.json`. The first two are the basketball system's; the
next two are StatTrack's; the last three are the fixture generator's.

`claude_context.md` in particular would actively mislead — its "Shared
conventions (NON-NEGOTIABLE)" section bans `git add -A`, mandates a 60-attempt
push retry, forbids rebase, requires minified data files and forbids
`setup-node`. **Every one of those is wrong for this repo.**

---

## 3. Project instructions

Paste this into the new project's custom instructions.

> This project is `markjovic/junior-footy-dashboard` — a single-file HTML
> dashboard for AFL results, fetched from PlayHQ into a committed `data.json` and
> served from GitHub Pages. Mark is the sole developer and runs everything through
> GitHub Actions `workflow_dispatch`; he has no local git or local execution
> environment.
>
> Before answering anything about how this system behaves, read
> `dashboard_context.md`. It lists conventions that are the opposite of the
> sports-players-stats repo's, and the standing traps that have already caused
> damage. Read `working_practice.md` for delivery and verification rules, and
> `playhq_api_reference.md` before writing any PlayHQ query.
>
> Non-negotiables: read a whole file before touching or trusting it; verify by
> execution rather than by reading; every script ships with its matching workflow;
> the repo path goes as a comment on line 1 or 2 of every delivered file;
> `node --check` or a YAML parse before delivery; increment the version on every
> `index.html` delivery; call `present_files` after every delivery.
>
> If a discovery is about PlayHQ's behaviour rather than this repo's code, say so
> explicitly and draft the paragraph for `playhq_api_reference.md` so it can be
> carried into the other projects. That file is shared and drift between copies is
> invisible unless it is called out.
>
> Ask one question at a time and expect one clear answer. Write design questions
> down and get them approved before building. Plain English, complete sentences.

---

## 4. Before you split — three things to fix

**`OUTSTANDING_TASKS.md` is 869 lines and is almost entirely the basketball
system's queue.** Extract the dashboard items into a new file, or start a fresh
one. Uploading it as-is puts 800 lines of irrelevant work in front of every
conversation.

**`playhq_api_reference.md` needs updating before it becomes canonical.** The
`gradePlayerStatistics` pagination note is wrong — the 50-record limit is a
per-page default, not a system-wide cap, verified on grade `c952bf59` with 86
records across 2 pages. It also predates everything learned during the finals
work: finals round numbering, `abbreviatedName` stability, `ProvisionalTeam`,
`DiscoverTeam` having no club, logo URLs embedding the organisation id,
`discoverOrganisation` / `discoverTeams` / `discoverCompetitions`, grade
ordering, and U19.5 being classified SENIOR.

**Create `docs/` in the repo** and commit `working_practice.md`,
`dashboard_context.md`, `finals_support.md` and `playhq_api_reference.md` into it,
so the master copies are version controlled rather than living only in project
knowledge.

---

## 5. Repo audit — findings

Run `repo-audit.yml` for the current picture. As at 2026-08-10 it reported
**163 files, 65.0 MB**, and the following.

### Correction to an earlier claim

An earlier draft of this document stated as a "confirmed problem" that
`fetch-fixtures.js` existed in both the repo root and `scripts/`. **That was
wrong.** It came from misreading a scraped GitHub file listing. The audit, which
runs inside the repo, reports `scripts outside scripts/: None`. There is no
duplicate. Every one of the 11 scripts is invoked by exactly one workflow, no
workflow references a missing file, and no script is orphaned.

### Safe to remove — 137 files, ~24 MB

Run `repo-tidy.yml` with `groups: oneoffs,placeholders,legacy,assets` and
`apply` ticked.

| Group | Files | What |
|---|---|---|
| `oneoffs` | 4 | `extract-finals-data.js` + workflow (one-off analysis, hardcoded to EFNL U12 B, superseded by the finals view); `fetch-u10-2024.js` + workflow (one-off historical import) |
| `placeholders` | 2 | Two 1-byte `a.txt` files used to create empty directories in git |
| `legacy` | 2 | `2024.html`, `SETUP.txt` — neither referenced by anything |
| `assets` | 129 | `assets/clubs/**`, ~24 MB |

**On `assets/clubs`:** confirmed dead 2026-08-10. `index.html` references only
`assets/icons`. `markjovic/fixture-generator` is self-contained — its README
states "All assets sit alongside `index.html`" and its repo carries its own
`assets/clubs` tree — so nothing outside this repo depends on them either. They
are leftovers from when the two projects shared a repository.

`repo-tidy.js` scans every text file for references before deleting anything,
and distinguishes code references (which block a removal) from documentation
references (which only warn). Run it without `apply` first.

### Requires a workflow edit — not automated

`scripts/migrate-grades.js` is a completed one-off, but `fetch-results.yml` still
invokes it behind the `run_migration` input. `repo-tidy.js` correctly refuses to
delete it. Removing it means deleting the input and its two steps from the
workflow first.

### Not addressed by tidying

**`data.json` is 53 MB — 81% of the repository.** It is checked out by every
workflow run and downloaded by every visitor. It is written with
`JSON.stringify(merged, null, 2)`; minifying reduces it to about 41.5 MB
(measured 21.7%), at the cost of one enormous first diff.

**Deleting files does not shrink history.** Those blobs remain in the 563 commits
behind them, so `.git` will not get smaller without a history rewrite — which is
not worth doing on a repository that is the only copy.
