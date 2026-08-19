# Working Practice

**Repo:** `markjovic/junior-footy-dashboard`  
**Last updated:** 2026-08-16  

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
- **Increment the version badge FIRST, as the opening edit of any `index.html`
  delivery** — not at the end. Left until last it gets forgotten, and two
  different files then share a number, which is exactly the confusion the badge
  exists to prevent. This was got wrong three times on 2026-08-16, including
  twice in consecutive deliveries. `org-discovery.html` is versioned separately.
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
- **When two functions filter the same thing, read both and make them join on the
  same key.** `renderResults` filtered on `matchListGrade(m)` — a grade id — and
  `renderFixtures` on `m.rawGrade`, a display string, against the same Set of
  ids. The test could never match, so every fixture was dropped and the section
  hid itself. Two filters over one collection that disagree about the key are a
  silent whole-feature failure, not a cosmetic difference.
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
- **NEVER add a field to a PlayHQ query without establishing it exists.** A
  GraphQL validation error fails the WHOLE query, not just the field: adding
  `result { home { score } }` to the player panel on 2026-08-16 took a working
  panel to "No 2026 season stats found" for every player. If a field is needed
  and unproven, probe for it — a query is not a place to guess.
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

**A test that SKIPS is not a test that passes.** `if (has('someFn')) { ... }`
reports green when the function does not exist, so a whole section can be
inert and invisible. Assert the function exists, then branch. Four guards on
2026-08-16 passed the entire suite while testing nothing.

**Take ALL the matches, not the first.** Three separate assertions this session
passed because a regex found an earlier, innocent match: `body\{` matched inside
`.fv-sum-body{`; `String.match` returned `body{height:100%…}` and never saw
`body{overflow-x:hidden}`; and a detail regex reported section 10's table while
asserting on section 11's. Anchor the pattern to a real boundary and use
`matchAll`, or state explicitly why the first match is the right one.

**Parse tables by COLUMN NAME, not by index.** Adding a leading `#` column to the
club summary broke fifteen assertions at once, every one of them correct and every
one of them counting positions. A shared `summaryTable()` helper now resolves
columns from the header row.

**The harness must be able to express the behaviour under test.** Three stubs were
silently hiding things on 2026-08-17: `window.addEventListener` was missing, so a
top-level listener registration crashed the page load; `style` was a bare `{}`, so
CSS custom properties could not round-trip; and `requestAnimationFrame` was a
noop, so every throttled function was queued and never ran. A stub that swallows
the call makes the feature untestable AND hides a real crash. Upgrading rAF to run
synchronously immediately exposed a genuine ordering bug in the page.

**A fixture must be able to DISTINGUISH the defect.** Reintroducing a defect only
proves something if the fixture contains a case where correct and broken behaviour
give different answers. On 2026-08-16 five defects were reintroduced against the
club summary and THREE passed the entire suite:

- the denominator counted on a key carrying the grade — undetectable, because
  every team in the fixture sat in exactly one grade
- the entered pool skipped the competition filter — undetectable, because every
  record was in the selected competition
- "Date TBC" sorted first — undetectable, because "Date TBC" starts with a letter
  and every real date with a digit, so it lands last either way

Each was fixed by adding one record chosen to separate the two behaviours: a team
appearing in two grades, a record in another competition, and a venue sorting
after "Venue TBC" alphabetically. Each carries a comment saying why it exists, so
it is not deleted later as noise. **Ask of every fixture: if the code were wrong
in the way I am guarding against, would THIS data give a different answer?**

**A test that crashes says less than one that fails.** A missing table row made an
assertion throw on a property of `undefined`, which fails the run but reports a
stack trace instead of the row that was absent. Guard the lookup and assert.

**A shared sandbox is shared state.** `verify-dashboard-grades.js` evaluates
index.html once and every section runs against the same context, so a second
top-level `const M` in a later section throws before a single assertion executes.
Seed records from Node onto the sandbox object rather than declaring them inside
`run()`.

**A fixture must be the shape the code really produces.** Several assertions
passed against shapes that were assumed rather than read: player records with no
`uuid`, match records with no `home`/`away`, ladder rows keyed `team` instead of
`name`, player rows whose round is "Round 1" rather than 1. Each looked green and
measured nothing. Read the producer before writing the fixture.

**Assert on the SLICE, not on the whole log.** Two sections of `audit-data.js`
print tables whose rows both begin `EFNL 2026` followed by numbers. A new
assertion for section 11 matched the right row and then reported section 10's row
in its failure message, because the detail regex ran over the whole output and
found the earlier table first. The assertion was correct and its diagnostic was
lying — which is worse than no diagnostic, because it sends the next reader to the
wrong place. Slice the output to the section under test, then match. Found and
fixed 2026-08-16.

**LAYOUT ASSERTIONS WERE TRIED AGAIN AND REMOVED AGAIN, 2026-08-17.** Section 22a
of `verify-dashboard-grades.js` was a dozen CSS regexes checking that
`position:sticky` was declared and that no ancestor carried an `overflow`. It was
written with a paragraph inside it arguing that it was a mechanical check rather
than an aesthetic judgement, and therefore an exception to this rule. It was not.

- It PASSED while the headings did not stick at all, because it asserted the two
  boxes that had just been edited instead of the whole ancestor chain.
- Making it work took three attempts: an unanchored selector matched inside
  `.fv-sum-body`, `String.match` returned the first of two `body` rules, and the
  regex literals were over-escaped. Two of those failed against correct code.
- **It drove a regression.** The CSS was changed to satisfy it, which removed the
  scrollport the page header was sticking to and broke the header on the live
  site. A test that is confidently wrong does not merely fail to catch a defect —
  it argues for one.

It caught one thing that a single scroll would have shown. **Whenever an exception
to this rule seems justified, that is the moment it is about to cost a release.**
A change that can only fail visibly ships as `index.html` alone: one commit, no
suite edit, no intermediate red run.

The behavioural half was KEPT. Section 22b registers the real listeners, fires a
real scroll event and asserts the offset that results — and it caught a genuine
scheduling bug. The distinction is not "layout versus logic", it is whether the
test drives behaviour or reads the source back.

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

### A spread cannot CLEAR a key the incoming object does not have
`{ ...prev, ...next }` overwrites the keys `next` has and leaves everything else
on `prev` untouched. That is usually what is wanted, and it is why the merge in
`results-engine.js` looked correct for as long as it did. It is wrong whenever
`prev` carries a flag that `next` exists to REMOVE.

A result record has no `scheduled` key. Merging one over a stored fixture
therefore left `scheduled: true` in place, with correct scores inside it, and
`index.html` filters that record out of `S.matches` on exactly that flag. Fixed
2026-08-16 in engine v18 by deleting the flag explicitly.

This is the same shape as the `__hadPlayers` marker below — a spread silently not
carrying something across — and it will recur. **When a merge is meant to change a
record's CLASS rather than its values, delete the old class marker explicitly. The
absence of a key in the incoming object is not an instruction to remove it.**

### A defect that makes a run report "no changes" hides itself twice
The `scheduled` bug above merged the scores in on its first run, so every run
after found them equal, reported `0 new, 0 updated`, and skipped the commit. The
log was byte-comparable to a run with genuinely nothing to do.

**Any repair that corrects a record's classification rather than its values must
count as a change,** or it is computed and thrown away on every run while the log
reports success. Ask of every new merge rule: if this fires and nothing else
differs, does the run still commit?

### The `__hadPlayers` marker
`store.load` marks its return value with a non-enumerable `__hadPlayers`.
Every writer spreads the object (`const merged = { ...existing, ... }`), which
silently drops non-enumerable properties. Always pass `players: false`
explicitly to `store.save` for writers that do not touch player records.

### A removal is only as safe as the suites you can see
`lastRound` came out of five files on 2026-08-16. The sixth, the `'lastRound'`
entry in `store.js`'s `CORE_KEYS`, was deliberately LEFT — `verify-per-season.js`
has 53 assertions over `store.js` and had not been read, and a removal that turns
a suite red for an unreadable reason is not a removal, it is a mess for the next
session. The audit was changed to report the key as RETIRED instead, so the
remnant announces itself every run rather than sitting there silently.

The same limit applied to `report-field-usage.js`, which could not be run. Every
file to hand was grepped; the writers not to hand were not. A stored field's
removal is safe only across the files actually read.

### One person has SEVERAL stored records
`fetch-stats.js` stores one player record per GRADE, so anyone who turns out for
two teams has two records. Any figure that summarises a PERSON must aggregate them
— `S.players.find(uuid)` returns whichever loaded first, which is a single team's
figures wearing the person's name. The player panel read 16 games and 28 goals
above a list of 18 and 29 for exactly this reason, until Beta 0.191.

The same shape applies to `aggregatePlayers` in the Scorers list, which already
groups on `uuid`. **When a new view summarises a person, check which of the two it
is doing.**

Aggregating also has to be SEASON-SCOPED. Picking the primary record by games
played across everything loaded looks right and is not: a previous season usually
has more games than a part-finished current one, so the current-year view silently
shows last year's totals. Scope by the year inside `compName` against `S.selYear`,
never by competition — one person can play two competitions in a season.

### A strip with a fixed column count breaks when you add a cell
`.team-stat-strip` is `repeat(6,1fr)` and `.team-ha-strip` was `1fr 1fr`. Adding a
seventh stat cell and a third breakdown cell on 2026-08-18 wrapped both onto a
second row and the modal looked broken. Neither grid was touched, because neither
was read.

Where a cell is CONDITIONAL — the finals cell only exists if the team played
finals — use `grid-auto-flow:column` with `grid-auto-columns:1fr` rather than
counting. Where the count is fixed, count it again after editing the array that
fills it.

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
