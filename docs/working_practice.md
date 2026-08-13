# Working Practice

**Repo:** `markjovic/junior-footy-dashboard`  
**Last updated:** 2026-08-12  

---

## Constraints

Mark is the sole developer. He has **no local git and no local execution
environment**. Every script runs through GitHub Actions `workflow_dispatch`.
Every file is committed through the GitHub web UI.

**Never ask him to run a shell command.**

When delivering more than one file, lead with a table of file → destination
path. He commits batches without opening files, so a path comment on line 1 is
necessary but not sufficient.

Every delivered file carries its repo path as a comment on line 1 or 2
(`// scripts/x.js`, `# .github/workflows/x.yml`). JSON cannot carry
comments — state the path in the message.

Every script ships with its matching workflow. If the workflow is unchanged,
say so and re-present it.

---

## Delivery standards

- **Lead with what to do.** Reasoning comes after.
- **Every script that produces output read from a log must print a version
  line.** Without it, a stale cached copy and a real failure look identical,
  and that costs a wasted run.
- **Syntax checks before delivery:** `node --check` for JS, YAML parse for
  workflows, HTML parse plus inline script check for HTML.
- **Increment the version badge** on every `index.html` delivery
  (0.160 → 0.161). `org-discovery.html` is versioned separately.
- **Call `present_files` after every delivery.**
- **Commit tests before the file they test** when they span two folders
  (scripts/ and root). The intermediate red run is expected; the second commit
  turns it green. A test committed after the code it tests produces a red run
  for the opposite reason.

---

## Non-negotiable principles

### Read before touching
- **Read a whole file before touching or trusting it.** Never infer behaviour
  from a filename, a summary, or a partial grep.
- **Before removing or renaming any stored field,** run
  `scripts/report-field-usage.js` and read every file it names. Removing
  per-match logo URLs after checking only `index.html` silently broke
  `build-club-index.js`, which derived every club identity from them.

### Verify by execution, not by reading
- **Stub the network and run the real script.** Verify by execution, not by
  reading.
- **Test the failure path too.** A guard that has never fired is untested.
- **Never conclude from a sample.** Multiple incorrect conclusions were traced
  to sampling early rounds or a subset of grades.
- **When a test fails, establish whether the test or the code is wrong first.**
  A comparison that sorts records must sort on a total order.
- **Could these tests have failed?** Always reintroduce the defect in a copy
  and confirm the tests catch it.

### Data integrity
- **Anything derived from a filtered grade list must MERGE per competition,
  never replace.** This defect was fixed four times in four writers.
- **Harvest before you strip.** Read a value into its new home before deleting
  the old copy, in the same pass.
- **Never new Date(string) for parsing.** Split YYYY-MM-DD; use Date.UTC for
  arithmetic.
- **`store.save` with `players: false`** must be passed explicitly, not relied
  on from the non-enumerable marker that a spread operator will silently drop.
  The guard in `store.save` is the backstop; the explicit parameter is the
  intention.

### Design before code
- **Design questions are written down and approved before anything is built.**
- **Probe before building.** Key PlayHQ API behaviours are established by
  targeted probe scripts before any feature is built.
- **If a discovery is about PlayHQ's behaviour** rather than this repo's code,
  say so and draft the paragraph for `docs/playhq_api_reference.md`.

### Scope
- **Scoped writes are structurally isolated.** A VIP-only run scoped to EFNL
  cannot reach YJFL files. `store.save` with a scope enforces this.
- **No unsolicited refactoring.**

---

## What belongs in verification suites

**Yes:** things that fail silently.
- A promoted team appearing on two ladders
- A scorer filtered out because their team is not in the roster
- `render()` throwing and hanging the page
- The page fetching 26 MB instead of 5 MB
- Grade labels missing for archived seasons

**No:** things you can see.
- Whether a row reads well
- Whether a control is in the right place
- Whether a column header is redundant
- Loading state text

A regex over `index.html` cannot judge whether a layout is good. It only
repeats the code back, passes whatever the code says, and has to be rewritten
every time the design changes. About twenty such assertions were removed on
2026-08-12 after they had to be rewritten three times in an hour to permit
changes that were themselves the fix.

---

## What to check after every delivery

The verification workflow now runs automatically on every push to `scripts/**`,
`index.html`, or `org-discovery.html`. There is no need to run it manually
after commits — check the Actions tab for the result.

After a **data-touching run** (fetch, backfill, migration), run Audit Data.
After a **major change to the dashboard**, reload on desktop and on a narrow
mobile portrait to check the layout.

---

## Known pitfalls

### `data/orgs` as a rollback path
`data/orgs` was used on 2026-08-12 to restore 179,624 player records after a
bug. It must not be deleted until scheduled runs have been stable for a full
weekend.

### Stale files in the GitHub web UI
The web UI editor sometimes shows a stale version of a file. Always verify
a committed file's first line matches what was delivered before trusting it.

### The `__hadPlayers` marker
`store.load` marks its return value with a non-enumerable `__hadPlayers`.
Every writer spreads the object (`const merged = { ...existing, ... }`), which
silently drops non-enumerable properties. Always pass `players: false`
explicitly to `store.save` for writers that do not touch player records.

### PlayHQ session cookies
Three cookies in a specific order: `phq_tier`, `phq_session`, `phq_sub`.
`lib/playhq.js` handles this. Never write a local `getSession()`.

### `git add` pathspecs
Root-level `data.json`, `grades.json`, and `clubs.json` moved into `data/`
on 2026-08-11. Any workflow that uses `git add data.json` (without a path)
will fail with exit 128. Use `git add -A data/` instead.

---

## Commit order for cross-folder deliveries

When a change spans `index.html` (root) and `scripts/` (subfolder), the GitHub
web UI cannot commit both in one operation.

**Commit the tests first, then the file they test.** The intermediate state is
"tests expect something not built yet" — red for a clear reason. The second
commit turns it green. Committing the implementation first leaves a window where
code exists that nothing checks.

---

## File naming

Scripts: `scripts/x.js`  
Lib: `scripts/lib/x.js`  
Workflows: `.github/workflows/x.yml`  
Data: `data/x.json` or `data/seasons/<seasonId>-x.json`  
Docs: `docs/x.md`

Match ids: `<compName>|<age>|<gradeId>|<round>|<home>|<away>`  
The `compName` is the short competition name (e.g. "EFNL 2026"). The grade id
is PlayHQ's UUID for the grade. Both are stable; `name` and `rawGrade` are not.
