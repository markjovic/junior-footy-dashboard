<!-- docs/project_setup.md -->
# Setting Up the Standalone Project

<!-- Revision: 2026-08-10 -->

What to do, in order, so the new project starts fully briefed.

---

## 1. Decide where things live — the short answer

**Both, with a rule.**

| | Where | Why |
|---|---|---|
| Documents a project needs every session | **Project knowledge (uploaded)** | Always in context. Zero tool calls. This is what stops the re-teaching. |
| The master copy of those documents | **The repo, in `docs/`** | Version controlled, diffable, and readable by any project on request. |
| Everything else | The repo | No reason to duplicate. |

OneDrive is not needed. The repo is public and readable, and project knowledge is
what actually delivers the seamlessness — a connector fetch costs a tool call and
only happens if something prompts it, whereas uploaded knowledge is simply there.

**The rule:** the repo is the source of truth; project knowledge is a dated copy.
When a shared document changes, commit it and re-upload it to every project that
holds it, in the same sitting.

### On reading files from the repo

Verified 2026-08-10: the repo is public and
`https://github.com/markjovic/junior-footy-dashboard/blob/main/<path>` returns
file contents. Two constraints:

- `raw.githubusercontent.com` and `github.com/.../raw/...` are blocked by robots.
- A URL cannot be *constructed*; it must already have appeared in the
  conversation. Fetching the repo root first lists every file as a followable
  link, which works but costs a large page.

So repo reads are a **fallback for checking something specific**, not the primary
channel. Put the documents in project knowledge.

---

## 2. Files to upload into the new project

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
