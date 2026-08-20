#!/usr/bin/env node
// scripts/migrate-grade-ids.js
//
// Rewrites stored match ids to carry PlayHQ's grade id instead of the parsed
// rawGrade. grade_identity_migration.md.
//
//   before   EFNL 2025|U8||1|Bayswater Gold|Boronia Brown
//   after    EFNL 2025|U8|23b5e832|1|Bayswater Gold|Boronia Brown
//
// WHAT IT CHANGES, and nothing else:
//   matches[].id        rawGrade segment replaced by the grade id
//   matches[].gradeId   set
//   gotwFlags values    remapped, because the VALUE is a match id. The KEY is
//                       untouched by this script — see §3.1.
//
// NOTE ON THE gotwFlags KEY (2026-08-13). It was age|roundKey when this script
// was written and is now compName|age|roundKey. That re-keying was done in
// index.html, not here, and this script still only remaps VALUES, so nothing
// below changes. The remap works on either key shape because it never reads the
// key. lastround_gotw_keying_design.md.
//
// WHAT IT DELIBERATELY LEAVES ALONE:
//   rawGrade stays on every record as the display value, so index.html's grade
//   chip and its gradeMeta lookup keep working unchanged. gradeMeta keeps its
//   current keys: re-keying needs index.html and the engine changed in the same
//   step, which is build-order step 6, and folding it in here would make neither
//   change provable. lastRound was in this list until 2026-08-13; it was re-keyed
//   in results-engine.js v14 and needed no migration, because a full results run
//   rebuilds it from scratch.
//
// DEFAULTS TO A DRY RUN. It resolves everything, reports the full plan, and
// writes nothing unless MIGRATE_DRY_RUN=false.
//
// Env:
//   MIGRATE_ORG=<code>     8-character organisation code, or "all". Required.
//                          "all" loops every organisation in the manifest, each
//                          with its own scoped load and save, so one scope still
//                          cannot reach another organisation's files. A failure
//                          part-way leaves the earlier organisations written.
//   MIGRATE_DRY_RUN        "false" to write. Anything else, including unset, is
//                          a dry run.
//   MIGRATE_SKIP_PASS2     "true" to resolve offline only, no API calls.
//   MIGRATE_PASS3          "true" to run pass 3 — re-fetch the specific grades
//                          and rounds still unresolved after pass 2 and read the
//                          grade straight from the fixture. Off by default,
//                          because it is the only part that costs more than
//                          eighteen API calls. A dry run reports the exact call
//                          count before any of them are made.
//
// Exit codes: 0 = changed, commit. 2 = no change, skip commit. 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const { parseGradeName, cleanTeam, roundToken, Q_GRADE_ROUNDS, Q_FIXTURE } =
  require('./lib/results-engine');
const { gqlPost, refreshSession, sleep, logSummary } = require('./lib/playhq');

const VERSION = 'migrate-grade-ids v6 2026-08-19 pass3-dry-run-honesty';
const ROOT = path.resolve(__dirname, '..');
const GRADES_PATH = path.join(ROOT, 'data', 'grades.json');

const ORG = (process.env.MIGRATE_ORG || '').trim();
const DRY = process.env.MIGRATE_DRY_RUN !== 'false';
const SKIP_PASS2 = process.env.MIGRATE_SKIP_PASS2 === 'true';
const PASS3 = process.env.MIGRATE_PASS3 === 'true';

// Copied verbatim from scripts/probe-team-join.js, which ran against these exact
// seasons on 2026-08-12. Never written fresh.
const TEAMS_QUERY =
  'query discoverTeamsBySeason($seasonId: ID!) {\n' +
  '  discoverTeams(filter: {seasonID: $seasonId}) {\n' +
  '    id name\n' +
  '    grade { id name }\n' +
  '    organisation { id name }\n' +
  '  }\n' +
  '}\n';

function fail(msg) { console.error(`FATAL: ${msg}`); process.exit(1); }

// The id is compName|age|rawGrade|roundToken|team|team. Split rather than
// regex: a regex over a string containing team names is how a migration eats a
// record whose name happens to match.
function rewriteId(oldId, gradeId) {
  const parts = String(oldId).split('|');
  if (parts.length < 5) return null;
  parts[2] = gradeId;
  return parts.join('|');
}

async function migrateOrg(ORG, keyToGrades, gradeById, core) {
  const forOrg = (core.manifest || []).filter(m => m.org === ORG && m.compName);
  if (!forOrg.length) fail(`no manifest entries with a compName for organisation "${ORG}".`);

  const scope = forOrg.map(m => m.compName);
  const seasonOfComp = new Map(forOrg.map(m => [m.compName, m.seasonId]));
  console.log(`\n${'='.repeat(66)}\norganisation ${ORG} — ${forOrg.length} season(s): ${scope.join(', ')}\n${'='.repeat(66)}`);

  const data = store.load(scope);
  console.log(`loaded ${data.matches.length} match record(s) in scope\n`);

  // ── Pass 1 ────────────────────────────────────────────────────────────────
  const resolved = new Map();      // old id -> gradeId
  const pending = [];              // records needing pass 2
  const pendingByOldId = new Map();// old id -> { seasonId, candidates }, for pass 3
  const unplaceable = [];          // no grade reduces to this key at all
  let alreadyDone = 0;
  const inScope = new Set(scope);

  for (const rec of data.matches) {
    if (!inScope.has(rec.compName)) continue;
    const parts = String(rec.id).split('|');
    if (parts.length >= 5 && parts[2] && parts[2] === rec.gradeId) { alreadyDone++; continue; }

    const seasonId = seasonOfComp.get(rec.compName);
    const km = keyToGrades.get(seasonId);
    const ids = km && km.get(`${rec.age}|${rec.rawGrade}`);
    if (!ids) unplaceable.push(rec);
    else if (ids.length === 1) resolved.set(rec.id, ids[0]);
    else {
      const p = { rec, seasonId, candidates: ids };
      pending.push(p);
      pendingByOldId.set(rec.id, p);
    }
  }
  console.log(`PASS 1  offline, no API calls`);
  console.log(`  already migrated : ${alreadyDone}`);
  console.log(`  resolved         : ${resolved.size}`);
  console.log(`  need pass 2      : ${pending.length}`);
  console.log(`  no grade matches : ${unplaceable.length}`);

  // ── Pass 2 ────────────────────────────────────────────────────────────────
  const disagreed = [];
  let pass2Resolved = 0;
  if (pending.length && !SKIP_PASS2) {
    const seasons = [...new Set(pending.map(p => p.seasonId))];
    console.log(`\nPASS 2  season team registry — ${seasons.length} API call(s)`);
    await refreshSession();   // idempotent; a no-op if a session is already held

    for (const seasonId of seasons) {
      let teams = [];
      try {
        const r = await gqlPost(TEAMS_QUERY, { seasonId }, 'discoverTeamsBySeason');
        teams = (r && r.data && r.data.discoverTeams) || [];
      } catch (e) {
        fail(`registry fetch failed for season ${seasonId}: ${e.message}. Nothing has been written.`);
      }

      // "age|cleanName" -> Set(gradeId). The age comes from grades.json through
      // parseGradeName, so it reproduces the stored age rather than guessing it.
      const teamKey = new Map();
      let ungraded = 0;
      for (const t of teams) {
        if (!t.grade || !t.grade.id) { ungraded++; continue; }
        const g = (gradeById.get(seasonId) || new Map()).get(t.grade.id);
        if (!g) continue;
        const { age } = parseGradeName(g.name, g.ageName, g.genderName);
        const k = `${age}|${cleanTeam(t.name, age)}`;
        if (!teamKey.has(k)) teamKey.set(k, new Set());
        teamKey.get(k).add(t.grade.id);
      }
      console.log(`  season ${seasonId}: ${teams.length} team(s), ${ungraded} with no grade`);

      for (const p of pending) {
        if (p.seasonId !== seasonId) continue;
        const allowed = new Set(p.candidates);
        // A match needs only ONE of its teams to carry a grade. Requiring both
        // would discard information for nothing.
        const found = new Set();
        for (const side of ['home', 'away']) {
          const ids = teamKey.get(`${p.rec.age}|${p.rec[side]}`);
          if (!ids) continue;
          for (const id of ids) if (allowed.has(id)) found.add(id);
        }
        if (found.size === 1) { resolved.set(p.rec.id, [...found][0]); pass2Resolved++; }
        else disagreed.push({ rec: p.rec, found: [...found] });
      }
      await sleep(500);
    }
    console.log(`  resolved by registry : ${pass2Resolved}`);
    console.log(`  still unresolved     : ${disagreed.length}`);
  } else if (pending.length) {
    console.log(`\nPASS 2 SKIPPED — ${pending.length} record(s) left unresolved`);
    for (const p of pending) disagreed.push({ rec: p.rec, found: [] });
  }

  // ── Pass 3 ────────────────────────────────────────────────────────────────
  // Read the grade straight from the fixture. For every record pass 2 could not
  // place, fetch its candidate grades' rounds and match on round token plus the
  // two team names — the same three components the id is built from.
  //
  // Targeted by construction: only the candidate grades of unresolved records,
  // and within those only the rounds those records actually sit in. A season is
  // never re-crawled.
  let pass3Resolved = 0;
  const stillUnresolved = [];
  // Set only when pass 3 actually issues its API calls — see the summary below.
  let pass3Executed = false;
  if (disagreed.length && PASS3) {
    // seasonId -> gradeId -> Set(roundToken) still needed
    const want = new Map();
    for (const d of disagreed) {
      const p = pendingByOldId.get(d.rec.id);
      if (!p) continue;
      const tok = String(d.rec.id).split('|')[3];
      if (!want.has(p.seasonId)) want.set(p.seasonId, new Map());
      const g = want.get(p.seasonId);
      for (const gid of p.candidates) {
        if (!g.has(gid)) g.set(gid, new Set());
        g.get(gid).add(tok);
      }
    }

    // ⚠️ Whether pass 3 RAN, not whether it was asked for. The summary used to
    // branch on PASS3 alone and print "Pass 3 ran and could not place them" after
    // a dry run that made no calls at all — a negative result asserted with no
    // evidence behind it, four lines below "DRY RUN — no calls made". Found
    // 2026-08-19, and it had been discouraging the one run that would settle the
    // question. working_practice.md: a tool that reports something is absent must
    // show what it found instead.
    let plannedGrades = 0, plannedRounds = 0;
    for (const g of want.values()) for (const toks of g.values()) { plannedGrades++; plannedRounds += toks.size; }
    console.log(`\nPASS 3  re-fetch the unresolved grades and rounds`);
    console.log(`  ${plannedGrades} grade(s) to list, up to ${plannedRounds} round fixture(s) to fetch`);
    console.log(`  worst case ${plannedGrades + plannedRounds} API call(s)`);

    if (DRY) {
      console.log(`  DRY RUN — no calls made.`);
      console.log(`  These ${disagreed.length} record(s) are therefore UNTESTED, not unresolvable.`);
      for (const d of disagreed) stillUnresolved.push(d);
    } else {
      pass3Executed = true;
      await refreshSession();
      // "roundToken|teamA|teamB" -> gradeId, built from live fixtures.
      const fromFixture = new Map();
      // "roundToken" -> Set(gradeId) for rounds that returned NO games. That is
      // exactly what a bye is, and a bye sentinel can never be matched against a
      // fixture because there is no fixture to match. Found 2026-08-12: YJFL
      // left 50 records after pass 3 and the fixture lookup could not have
      // placed any sentinel among them.
      const byeAt = new Map();
      for (const [seasonId, gradeMap] of want) {
        for (const [gid, toks] of gradeMap) {
          const g = (gradeById.get(seasonId) || new Map()).get(gid);
          if (!g) continue;
          const { age } = parseGradeName(g.name, g.ageName, g.genderName);

          let rounds = [];
          try {
            const r = await gqlPost(Q_GRADE_ROUNDS, { gradeID: gid }, 'gradeRounds');
            rounds = (r && r.data && r.data.discoverGrade && r.data.discoverGrade.rounds) || [];
          } catch (e) {
            console.error(`    grade ${gid} round list failed: ${e.message} — skipping it`);
            continue;
          }
          await sleep(300);

          for (const round of rounds) {
            const num = parseInt(round.number, 10) || 0;
            const ab = round.isFinalsRound === true ? (round.abbreviatedName || String(num)) : '';
            const tok = roundToken(num, ab);
            if (!toks.has(tok)) continue;      // this is the targeting
            let games = [];
            try {
              const fr = await gqlPost(Q_FIXTURE, { roundID: round.id }, 'discoverFixtureByRound');
              games = (fr && fr.data && fr.data.discoverFixtureByRound && fr.data.discoverFixtureByRound.games) || [];
            } catch (e) {
              console.error(`    grade ${gid} ${tok} fixture failed: ${e.message}`);
              continue;
            }
            await sleep(300);
            if (!games.length) {
              if (!byeAt.has(tok)) byeAt.set(tok, new Set());
              byeAt.get(tok).add(gid);
            }
            for (const game of games) {
              const h = cleanTeam((game.home && game.home.name) || '', age);
              const a = cleanTeam((game.away && game.away.name) || '', age);
              if (!h || !a) continue;
              fromFixture.set(`${tok}|${[h, a].sort().join('|')}`, gid);
            }
          }
          console.log(`    grade ${gid} (${g.name}): ${toks.size} round(s) checked`);
        }
      }

      let byResolved = 0;
      const why = { bye: 0, partial: 0, notFound: 0 };
      for (const d of disagreed) {
        const parts = String(d.rec.id).split('|');
        const tok = parts[3];
        const k = `${tok}|${parts.slice(4).join('|')}`;
        const gid = fromFixture.get(k);
        if (gid) { resolved.set(d.rec.id, gid); pass3Resolved++; continue; }

        // A bye sentinel is placed by elimination: of its candidate grades,
        // which one had no games in that round. Only when exactly one did —
        // two grades with a bye in the same round are genuinely ambiguous and
        // are left alone rather than guessed.
        if (d.rec.isBye) {
          const p = pendingByOldId.get(d.rec.id);
          const cands = (p ? p.candidates : []).filter(c => (byeAt.get(tok) || new Set()).has(c));
          if (cands.length === 1) { resolved.set(d.rec.id, cands[0]); byResolved++; continue; }
          why.bye++;
        } else if (d.rec.isPartial) {
          why.partial++;
        } else {
          why.notFound++;
        }
        stillUnresolved.push(d);
      }
      console.log(`  resolved by fixture : ${pass3Resolved}`);
      console.log(`  resolved as a bye   : ${byResolved}`);
      console.log(`  still unresolved    : ${stillUnresolved.length}` +
        (stillUnresolved.length
          ? `  (${why.bye} ambiguous bye, ${why.partial} partial sentinel, ${why.notFound} game not in any candidate grade)`
          : ''));
      pass3Resolved += byResolved;
    }
  } else {
    for (const d of disagreed) stillUnresolved.push(d);
    if (disagreed.length) {
      console.log(`\nPASS 3 not run — set MIGRATE_PASS3=true to resolve the remaining ${disagreed.length}`);
    }
  }

  // ── Integrity, before anything is written ─────────────────────────────────
  const newIds = new Map();        // new id -> old id
  const rewritten = [];
  for (const rec of data.matches) {
    const gradeId = resolved.get(rec.id);
    if (!gradeId) continue;
    const nid = rewriteId(rec.id, gradeId);
    if (!nid) fail(`match id "${rec.id}" has fewer than five segments — refusing to rewrite it.`);
    if (newIds.has(nid)) {
      fail(`two records would both become "${nid}" — "${newIds.get(nid)}" and "${rec.id}". ` +
           `A migration that merges records is not a migration. Nothing has been written.`);
    }
    newIds.set(nid, rec.id);
    rewritten.push({ rec, nid, gradeId });
  }

  const unresolvedTotal = stillUnresolved.length + unplaceable.length;
  console.log(`\nPLAN`);
  console.log(`  records to rewrite : ${rewritten.length}`);
  console.log(`  left on the old id : ${unresolvedTotal}`);
  console.log(`  already migrated   : ${alreadyDone}`);
  console.log(`  total in scope     : ${data.matches.filter(m => inScope.has(m.compName)).length}`);

  if (unresolvedTotal) {
    console.log(`\n  UNRESOLVED — these keep their current id and rawGrade.`);
    console.log(
      pass3Executed
        ? `  Pass 3 RAN and could not place them. Re-running will not change that.`
      : PASS3
        ? `  Pass 3 was requested but SKIPPED — this is a dry run, so no fixtures were\n` +
          `  fetched and these are UNTESTED, not unresolvable. Set MIGRATE_DRY_RUN=false\n` +
          `  to actually try. It only rewrites what it can resolve, so a run that places\n` +
          `  none writes nothing.`
        : `  Set MIGRATE_PASS3=true to resolve them from the fixtures.`);
    const byKey = new Map();
    for (const { rec } of stillUnresolved) {
      const k = `${rec.compName}|${rec.age}|${rec.rawGrade}`;
      byKey.set(k, (byKey.get(k) || 0) + 1);
    }
    for (const rec of unplaceable) {
      const k = `${rec.compName}|${rec.age}|${rec.rawGrade} (no grade matches)`;
      byKey.set(k, (byKey.get(k) || 0) + 1);
    }
    for (const [k, n] of [...byKey].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`    ${String(n).padStart(6)}  ${k}`);
    }
    if (byKey.size > 20) console.log(`    ... ${byKey.size - 20} further key(s)`);
  }

  if (DRY) {
    console.log(`\n  DRY RUN — nothing written for ${ORG}.`);
    return { changed: false, rewritten: rewritten.length, unresolved: unresolvedTotal };
  }
  if (!rewritten.length) {
    console.log(`\n  Nothing to rewrite for ${ORG}.`);
    return { changed: false, rewritten: 0, unresolved: unresolvedTotal };
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const before = data.matches.length;
  const idMap = new Map();         // old id -> new id, for gotwFlags
  for (const { rec, nid, gradeId } of rewritten) {
    idMap.set(rec.id, nid);
    rec.id = nid;
    rec.gradeId = gradeId;
  }
  if (data.matches.length !== before) {
    fail(`record count changed from ${before} to ${data.matches.length} during rewrite.`);
  }

  // gotwFlags: the KEY is age|roundKey and stays; the VALUE is a match id.
  let gotwRemapped = 0;
  if (data.gotwFlags) {
    for (const [k, v] of Object.entries(data.gotwFlags)) {
      if (idMap.has(v)) { data.gotwFlags[k] = idMap.get(v); gotwRemapped++; }
    }
  }
  console.log(`\n  gotwFlags values remapped: ${gotwRemapped}`);

  const ids = new Set(data.matches.map(m => m.id));
  if (ids.size !== data.matches.length) {
    fail(`${data.matches.length - ids.size} duplicate id(s) after rewrite. Nothing saved.`);
  }

  store.report(store.save(data, scope), `migrate ${ORG}`);
  console.log(`\n  ${ORG}: ${rewritten.length} record(s) rewritten, ${unresolvedTotal} left.`);
  return { changed: true, rewritten: rewritten.length, unresolved: unresolvedTotal };
}

async function main() {
  console.log(`=== ${VERSION} ===`);
  console.log(DRY ? 'DRY RUN — nothing will be written.' : '*** WRITING ***');

  const ALL = ORG.toLowerCase() === 'all';
  if (!ALL && !/^[0-9a-f]{8}$/i.test(ORG)) {
    fail(`MIGRATE_ORG must be an 8-character organisation code or "all", got "${ORG}".`);
  }
  if (!fs.existsSync(GRADES_PATH)) fail('data/grades.json not found — pass 1 reads it.');

  let grades;
  try { grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8')); }
  catch (e) { fail(`could not parse grades.json: ${e.message}`); }

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));

  // Built once and shared. seasonId -> "age|rawGrade" -> [gradeId, ...], and
  // seasonId -> gradeId -> grade record for the pass 2 registry join.
  const keyToGrades = new Map();
  const gradeById = new Map();
  for (const g of grades) {
    if (!g.seasonID || !g.id) continue;
    if (!keyToGrades.has(g.seasonID)) { keyToGrades.set(g.seasonID, new Map()); gradeById.set(g.seasonID, new Map()); }
    const { age, rawGrade } = parseGradeName(g.name, g.ageName, g.genderName);
    const k = `${age}|${rawGrade}`;
    const mm = keyToGrades.get(g.seasonID);
    if (!mm.has(k)) mm.set(k, []);
    mm.get(k).push(g.id);
    gradeById.get(g.seasonID).set(g.id, g);
  }

  const orgs = ALL
    ? [...new Set((core.manifest || []).filter(m => m.compName).map(m => m.org))].sort()
    : [ORG];
  if (!orgs.length) fail('no organisations in the manifest have a compName.');
  console.log(`${orgs.length} organisation(s): ${orgs.join(', ')}`);

  let anyChanged = false, totRewritten = 0, totUnresolved = 0;
  const done = [];
  for (const o of orgs) {
    // Each organisation gets its own scoped load and save, so a failure
    // part-way leaves the earlier ones written rather than losing the lot.
    const r = await migrateOrg(o, keyToGrades, gradeById, core);
    if (r.changed) { anyChanged = true; done.push(o); }
    totRewritten += r.rewritten;
    totUnresolved += r.unresolved;
  }

  console.log(`\n${'='.repeat(66)}`);
  console.log(`${VERSION}: ${totRewritten} record(s) ${DRY ? 'would be' : ''} rewritten, ` +
    `${totUnresolved} left on the old id.`);
  if (done.length) console.log(`written: ${done.join(', ')}`);
  logSummary('migrate-grade-ids');
  if (DRY) console.log(`\nDRY RUN — nothing written. Set MIGRATE_DRY_RUN=false to apply.`);
  process.exit(anyChanged ? 0 : 2);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
