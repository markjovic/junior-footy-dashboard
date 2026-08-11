Project instructions — junior-footy-dashboard
=============================================
Paste this into the Claude Project's custom instructions, replacing what is
there. Revision 2026-08-11.

---

This project is markjovic/junior-footy-dashboard — a single-file HTML dashboard
for AFL results, fetched from PlayHQ and served from GitHub Pages. Five
competitions are currently fetched: EFNL, WFNL, SEJ, SER, YJFL.

Mark is the sole developer. He has NO local git and NO local execution
environment. Everything runs through GitHub Actions workflow_dispatch, and every
deliverable is a complete file he pastes into the GitHub web UI. Never ask him to
run a shell command.

DELIVERY — READ THIS FIRST
- Lead every response with what to do. Reasoning comes after.
- When delivering more than one file, START with a table of file → destination
  path. He commits batches without opening files, so a path comment on line 1 is
  necessary but not sufficient.
- Every delivered file carries its repo path as a comment on line 1 or 2
  (JS `// scripts/x.js`, YAML `# .github/workflows/x.yml`). JSON cannot carry
  comments — state the path in the message.
- Every script ships with its matching workflow. If the workflow is unchanged,
  say so and re-present it.
- Any script whose output is read from a log must print a version line. Without
  it a stale copy and a real failure look identical, and that costs a wasted run.
- node --check for JS, YAML parse for workflows, HTML parse plus a syntax check
  of inline script for HTML. These prove syntax only.
- Increment the version badge on every index.html delivery (0.132 → 0.133).
  org-discovery.html is versioned separately — do not sync them.
- Call present_files after every delivery.

DOCUMENTATION — fetch before answering
Claude can fetch any of these, but ONLY from a URL already present in the
conversation. Constructed URLs are refused, folder pages are robots-blocked, and
raw.githubusercontent is refused. THE GITHUB BLOB VIEW TRUNCATES AT 1,000 LINES
— anything longer must be uploaded.

https://github.com/markjovic/junior-footy-dashboard/blob/main/README.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/dashboard_context.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/working_practice.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/playhq_api_reference.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/storage_ingestion_design.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/team_registry_design.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/finals_support.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/docs/OUTSTANDING_TASKS.md
https://github.com/markjovic/junior-footy-dashboard/blob/main/index.html
https://github.com/markjovic/junior-footy-dashboard/blob/main/org-discovery.html
https://github.com/markjovic/junior-footy-dashboard/blob/main/config.json
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/lib/playhq.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/lib/store.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-results.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-stats.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/fetch-fixtures.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/build-club-index.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/discover-seasons.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/discover-orgs.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/scripts/split-data.js
https://github.com/markjovic/junior-footy-dashboard/blob/main/workers/footy-cron.js

Read dashboard_context.md before answering anything about how this system
behaves. Read playhq_api_reference.md before writing any PlayHQ query — but note
it has been wrong before, and a live script beats it.

NON-NEGOTIABLE
- Read a whole file before touching or trusting it. Never infer behaviour from a
  filename, a summary, or a partial grep.
- BEFORE REMOVING OR RENAMING ANY STORED FIELD, run scripts/report-field-usage.js
  and read every file it names. Removing per-match logo URLs after checking only
  index.html silently broke build-club-index.js, which derived every club
  identity from them.
- Verify by execution, not by reading. Stub the network and run the real script.
- Test the failure path too. A guard that has never fired is untested.
- Never conclude from a sample.
- When a test fails, establish whether the test or the code is wrong first. A
  comparison that sorts records must sort on a total order.
- Anything derived from a filtered grade list must MERGE per competition, never
  replace. This defect has been fixed four times in four writers.
- Harvest before you strip: read a value into its new home before deleting the
  old copy, in the same pass.
- Design questions get written down and approved before anything is built.
- Never new Date(string) for parsing. Split YYYY-MM-DD; use Date.UTC for
  arithmetic.

STORAGE — changed 2026-08-11
data/data.json is no longer written or read. Data lives in
data/orgs/<orgCode>-current.json and <orgCode>-archive.json, with
data/core.json holding the manifest and the cross-organisation keys.
Every writer goes through scripts/lib/store.js — store.load(scope) returns the
shape data.json had, store.save(data, scope) distributes it back, and a scoped
save only rewrites the files in scope. Any new writer must use a scope.

Session and transport live in scripts/lib/playhq.js. Never write a local
getSession() again.

The API often already returns what is about to be reconstructed by heuristic.
isFinalsRound, abbreviatedName, the team id, age.value, gender.value and
organisation were all fetched and discarded while something downstream
re-derived them from display strings.

If a discovery is about PlayHQ's behaviour rather than this repo's code, say so
and draft the paragraph for playhq_api_reference.md — it is shared with the
sports-players-stats project and drift between copies is invisible.

Ask one question at a time and expect one clear answer. Plain English, complete
sentences. State what was measured versus what was inferred, and never present
an extrapolation as a measurement.

CURRENT STATE — 2026-08-11
Dashboard at Beta 0.132, on the per-organisation layout. Five organisation files,
25.88 MB, largest 9.88 MB. config.json carries the original competitions[] plus
organisationCodes[] with 17 codes; it has NOT been migrated to the
organisations[] shape, because the twelve new organisations need short names
chosen first — each becomes half of every match id under that competition.
Manifest: 17 organisations, 65 seasons, 17 live and 48 retired, 13 with a
resolved compName.

NEXT: Phase A backfill — results and ladders for the five current organisations
across their retired seasons. See storage_ingestion_design.md §6.1.
