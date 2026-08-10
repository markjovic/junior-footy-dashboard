<!-- docs/working_practice.md -->
# Working Practice

<!-- CANONICAL COPY: markjovic/junior-footy-dashboard/docs/working_practice.md -->
<!-- Revision: 2026-08-10 -->
<!-- Shared across all projects. Contains nothing repo-specific — if a rule -->
<!-- only applies to one codebase it belongs in that project's context file. -->

How the work gets done, independent of which repository. Extracted from
`claude_context.md`, which mixed these with rules that are true only of
`sports-players-stats`.

---

## Behavioural directives

Read this section every session.

1. **Read the whole file before touching or trusting it. No skimming, no
   exceptions.** If a script is uploaded, read it top to bottom before editing it
   or asserting what it does. Do not infer behaviour from filenames, prior
   summaries, docs, or partial greps. This applies especially under time
   pressure — skimming is what causes the bugs, not thoroughness.
2. **"This should match the working version" is a claim to verify, not assert.**
   When comparing against a known-working reference, diff the full relevant
   structure — the entire job graph, every `needs` and `if`, dependency
   topology, permissions, concurrency — not just the piece under suspicion.
   Isolated-piece comparisons repeatedly produce false "this matches"
   conclusions.
3. **When something has failed multiple times, stop and get instrumentation
   before the next theory.** Read-back diagnostics that prove what a value
   actually resolved to are cheap and belong early, not after the eighth guess.
4. **Own mistakes plainly and move on.** Don't re-litigate, don't over-apologise,
   fix and continue.

---

## Delivery

- **Filename comment on line 1 or 2 of every delivered file.**
  JS: `// scripts/x.js`. YAML: `# .github/workflows/x.yml`. This is the primary
  method of stating where a file goes — not the surrounding message.
- **Every script ships with its matching workflow, at the same time, no
  exceptions.**
- **Scripts live in `scripts/`** with `const ROOT = path.join(__dirname, '..')`.
- **`node --check` for JS, YAML parse for workflows, before delivery.** Both
  prove syntax only. Neither proves a branch fires or that a workflow behaves
  once GitHub runs it.
- **Version increment on every HTML delivery** (0.9 → 0.10, never 1.0).
- **`present_files` after every delivery.** A file written but never presented is
  unreachable.
- **No unsolicited refactoring.**

---

## Verification

- **All logic that has not been executed is a theory.** Verify by execution, not
  by reading. Extract the function and run it against fixtures if a full run
  isn't practical.
- **Never infer a rule from N=1.** Sample across competitions, grades, or
  seasons before concluding.
- **A counter without examples is a number that cannot be checked.** Print the
  shapes of what was counted alongside the count.
- **Test expectations are as likely to be wrong as the code.** When a test fails,
  establish which is wrong before changing either. Fixtures that don't express
  what they intend produce confident, useless passes.
- **Keep the earlier suites and re-run them.** A change that breaks a previous
  test has either introduced a regression or superseded a rule; both need saying
  out loud rather than quietly editing the assertion.

---

## Editing

- **Python `str.replace` with `assert s.count(old) == 1` first.** If the count
  isn't 1, the anchor is wrong — find a unique one rather than replacing blindly.
- **No incremental patching of broken logic.** Before writing flag, queue or
  state logic, map every path through the full function and rewrite it cleanly.
  Twenty-two revisions of one script in a session is the failure baseline never
  to repeat.
- **Never guess file contents, and never re-ask for a file already provided this
  session.**
- **Never `new Date()` for date parsing** — split `YYYY-MM-DD`.

---

## PlayHQ API

**Never write a query, header set or result traversal from scratch. Copy it —
but copy from something continuously proven, in this order:**

1. **The live script making the same class of call.** It runs against the real
   API on a schedule, so a wrong query shows up as a failed run.
2. **`playhq_api_reference.md` as a cross-check, never on its own.** It is
   documentation and it drifts.
3. **Never from a retired or unrun script.** Authority comes from being
   exercised, not from being on disk. A file nothing runs cannot be known to be
   right.

**A corollary learned repeatedly:** the API frequently already returns what is
being reconstructed by heuristic. `isFinalsRound`, `abbreviatedName`, the team
`id`, `age.value` and `gender.value` were all being fetched and discarded while
something downstream re-derived them from display strings. Before writing a
regex over a name, check whether the field exists.

---

## Documentation

- **Documentation describes intent; the real file is authoritative when they
  conflict.**
- **A fix recorded in a document is not a fix in a file.** A workflow documented
  as retired can still be on a cron schedule.
- **Date and attribute every shared document.** An undated copy makes drift
  invisible.
- **A deliberate decision not to touch data leaves no trace in the data** — the
  next script cannot see it. Write it down.

---

## Communication

- Plain English, complete sentences. No jargon, coined labels, abbreviations for
  concepts, or telegraphic fragments.
- One question at a time, expecting one clear answer — not a menu of options.
- Design questions get written down and approved before anything is built.
- State what was measured versus what was inferred. "Verified across 249 grades"
  and "this is probably how it works" are different claims and must read
  differently.
