<!-- docs/working_practice.md -->
# Working Practice

<!-- CANONICAL COPY: markjovic/junior-footy-dashboard/docs/working_practice.md -->
<!-- Revision: 2026-08-11 -->
<!-- Shared across all projects. Contains nothing repo-specific — if a rule -->
<!-- only applies to one codebase it belongs in that project's context file. -->

How the work gets done, independent of which repository.

---

## Behavioural directives

Read this section every session.

1. **Read the whole file before touching or trusting it. No skimming, no
   exceptions.** Do not infer behaviour from filenames, prior summaries, docs, or
   partial greps. This applies especially under time pressure — skimming is what
   causes the bugs, not thoroughness. **The GitHub blob view truncates at 1,000
   lines**, so a longer file has to be uploaded; "I read it on GitHub" is not the
   same as having read it.
2. **"This should match the working version" is a claim to verify, not assert.**
   Diff the full relevant structure, not just the piece under suspicion.
3. **When something has failed multiple times, stop and get instrumentation
   before the next theory.** Read-back diagnostics that prove what a value
   actually resolved to are cheap and belong early, not after the eighth guess.
4. **Own mistakes plainly and move on.** Don't re-litigate, don't over-apologise,
   fix and continue. A paragraph of contrition is worse than a one-line
   correction and a fix.

---

## Delivery

- **State the destination path of every delivered file in the message, not only
  in the file.** A filename comment on line 1 is required, but a person
  committing a batch will not open each file to discover where it goes. For more
  than one file, lead with a table of file → path.
- **Filename comment on line 1 or 2 of every delivered file.**
  JS: `// scripts/x.js`. YAML: `# .github/workflows/x.yml`.
  JSON cannot carry comments — say the path in the message.
- **Every script ships with its matching workflow, at the same time.** If the
  workflow is unchanged, say so and re-present it anyway.
- **A version or marker line in any script whose output will be read from a
  log.** Without it there is no way to tell a stale copy from a real failure, and
  the two look identical. This costs a wasted run every time it is missing.
- **`node --check` for JS, YAML parse for workflows, HTML parse plus a syntax
  check of inline script.** All of these prove syntax only.
- **Version increment on every HTML delivery** (0.9 → 0.10, never 1.0).
  Separately-versioned pages are separate — do not sync them.
- **`present_files` after every delivery.** A file written but never presented is
  unreachable.
- **No unsolicited refactoring.**

---

## Verification

- **All logic that has not been executed is a theory.** Verify by execution, not
  by reading. Stub the network and run the real script end to end rather than
  testing a reimplementation of it.
- **Test the failure path, not just the success path.** A guard that has never
  fired is a guard that has never been tested. Deliberately break the input and
  confirm it refuses.
- **A test that passes for the wrong reason is worse than no test.** If a
  verification reports success, check that it *could* have failed — a stub that
  never routes data through the path under test proves nothing.
- **Never infer a rule from N=1.** Sample across competitions, grades, or
  seasons before concluding.
- **A counter without examples is a number that cannot be checked.** Print the
  shapes of what was counted alongside the count.
- **Test expectations are as likely to be wrong as the code.** When a test fails,
  establish which is wrong before changing either. A verification comparing
  sorted records must sort on a **total order** — sorting on a key with
  duplicates leaves ties, and stable sort then reports a mismatch between two
  identical sets.
- **Keep the earlier suites and re-run them.**

---

## Changing stored data

- **Before removing or renaming any stored field, find every consumer
  mechanically.** Not from memory, not from documentation, not by checking the
  obvious consumer. Scan every producer and every reader and report which files
  reference the field. A hand-maintained list of consumers goes stale silently.
- **A field documented as unused is not evidence.** The dependency that breaks
  will be the one written down in three places and still missed, because the
  check was aimed at one consumer instead of all of them.
- **Harvest before you strip.** When moving a value from one place to another,
  read it into its new home first and delete the old copy second, in that order,
  in the same pass.
- **A writer that replaces rather than merges will eventually delete something.**
  Anything derived from a filtered input must merge per key rather than assign
  wholesale. Make it structural if possible; a rule that has to be remembered
  will be forgotten.
- **A migration that cannot prove it lost nothing is not a migration.**
  Reassemble the output and compare it against the source before anything is
  pointed at it.

---

## Editing

- **`str.replace` with `assert s.count(old) == 1` first.** If the count isn't 1,
  the anchor is wrong — find a unique one rather than replacing blindly.
- **A shorter-indent anchor can match inside a longer-indent line.** When
  replacing several near-identical lines, match whole lines.
- **When replacing a block, pin both boundaries exactly.** Cutting into a string
  literal or dropping one closing brace produces a syntax error at best and a
  silent behaviour change at worst. Re-read the block immediately before editing.
- **No incremental patching of broken logic.** Map every path through the full
  function and rewrite it cleanly.
- **Never guess file contents, and never re-ask for a file already provided this
  session.**
- **Never `new Date(string)` for date parsing** — split `YYYY-MM-DD`. For
  arithmetic use `Date.UTC` on split components.

---

## PlayHQ API

**Never write a query, header set or result traversal from scratch. Copy it —
but copy from something continuously proven, in this order:**

1. **The live script making the same class of call.**
2. **`playhq_api_reference.md` as a cross-check, never on its own.** It is
   documentation and it drifts. It has been wrong: it recorded
   `discoverCompetitions` as unusable from a guest session when the real cause
   was a missing required argument.
3. **Never from a retired or unrun script.** Authority comes from being
   exercised.

**A corollary learned repeatedly:** the API frequently already returns what is
being reconstructed by heuristic. Before writing a regex over a name, check
whether the field exists.

**Type every failure.** A CloudFront WAF block, an expired session, a private
record and an application error are four different things that all arrive as a
non-200. Collapsing them into "error, retry twice" produces silent degradation.
Test the response body before deciding what a 403 means.

---

## Documentation

- **Documentation describes intent; the real file is authoritative when they
  conflict.**
- **A fix recorded in a document is not a fix in a file.**
- **Date and attribute every shared document.** An undated copy makes drift
  invisible.
- **A deliberate decision not to touch data leaves no trace in the data** — the
  next script cannot see it. Write it down.
- **Record what was wrong, not just what is right.** A retraction that explains
  the earlier error prevents someone re-deriving it. Deleting the wrong claim
  loses that.

---

## Communication

- Plain English, complete sentences. No jargon, coined labels, or telegraphic
  fragments.
- **Lead with the action.** What to do goes first; the reasoning goes after. A
  reader looking for "what do I run" should not have to read three paragraphs.
- One question at a time, expecting one clear answer — not a menu of options.
- Design questions get written down and approved before anything is built.
- State what was measured versus what was inferred. "Verified across 249 grades"
  and "this is probably how it works" are different claims and must read
  differently.
- **An extrapolation labelled as a measurement will be built on.** Dividing a
  total by five and calling the result a per-item cost was wrong by a factor of
  four and nearly caused an entire architecture to be discarded.
