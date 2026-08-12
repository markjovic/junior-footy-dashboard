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
//   gotwFlags values    remapped, because the VALUE is a match id (the key is
//                       age|roundKey and is untouched) — see §3.1
//
// WHAT IT DELIBERATELY LEAVES ALONE:
//   rawGrade stays on every record as the display value, so index.html's grade
//   chip and its gradeMeta lookup keep working unchanged. gradeMeta and
//   lastRound keep their current keys for the same reason: re-keying them needs
//   index.html and the engine changed in the same step, which is build-order
//   step 6, and folding it in here would make neither change provable.
//
// DEFAULTS TO A DRY RUN. It resolves everything, reports the full plan, and
// writes nothing unless MIGRATE_DRY_RUN=false.
//
// Env:
//   MIGRATE_ORG=<code>     8-character organisation code. Required — migrate one
//                          organisation at a time so a scoped save cannot reach
//                          the others.
//   MIGRATE_DRY_RUN        "false" to write. Anything else, including unset, is
//                          a dry run.
//   MIGRATE_SKIP_PASS2     "true" to resolve offline only, no API calls.
//
// Exit codes: 0 = changed, commit. 2 = no change, skip commit. 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const { parseGradeName, cleanTeam } = require('./lib/results-engine');
const { gqlPost, refreshSession, sleep, logSummary } = require('./lib/playhq');

const VERSION = 'migrate-grade-ids v1 2026-08-12';
const ROOT = path.resolve(__dirname, '..');
const GRADES_PATH = path.join(ROOT, 'data', 'grades.json');

const ORG = (process.env.MIGRATE_ORG || '').trim();
const DRY = process.env.MIGRATE_DRY_RUN !== 'false';
const SKIP_PASS2 = process.env.MIGRATE_SKIP_PASS2 === 'true';

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

async function main() {
  console.log(`=== ${VERSION} ===`);
  console.log(DRY ? 'DRY RUN — nothing will be written.\n' : '*** WRITING ***\n');

  if (!/^[0-9a-f]{8}$/i.test(ORG)) fail(`MIGRATE_ORG must be an 8-character organisation code, got "${ORG}".`);
  if (!fs.existsSync(GRADES_PATH)) fail('data/grades.json not found — pass 1 reads it.');

  let grades;
  try { grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8')); }
  catch (e) { fail(`could not parse grades.json: ${e.message}`); }

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const forOrg = (core.manifest || []).filter(m => m.org === ORG && m.compName);
  if (!forOrg.length) fail(`no manifest entries with a compName for organisation "${ORG}".`);

  const scope = forOrg.map(m => m.compName);
  const seasonOfComp = new Map(forOrg.map(m => [m.compName, m.seasonId]));
  console.log(`organisation ${ORG} — ${forOrg.length} season(s): ${scope.join(', ')}\n`);

  // ── Pass 1 tables, built once ─────────────────────────────────────────────
  // seasonId -> "age|rawGrade" -> [gradeId, ...]
  const keyToGrades = new Map();
  // seasonId -> gradeId -> grade record, for the pass 2 registry join
  const gradeById = new Map();
  for (const g of grades) {
    if (!g.seasonID || !g.id) continue;
    if (!keyToGrades.has(g.seasonID)) { keyToGrades.set(g.seasonID, new Map()); gradeById.set(g.seasonID, new Map()); }
    const { age, rawGrade } = parseGradeName(g.name, g.ageName, g.genderName);
    const k = `${age}|${rawGrade}`;
    const m = keyToGrades.get(g.seasonID);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(g.id);
    gradeById.get(g.seasonID).set(g.id, g);
  }

  const data = store.load(scope);
  console.log(`loaded ${data.matches.length} match record(s) in scope\n`);

  // ── Pass 1 ────────────────────────────────────────────────────────────────
  const resolved = new Map();      // old id -> gradeId
  const pending = [];              // records needing pass 2
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
    else pending.push({ rec, seasonId, candidates: ids });
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
    await refreshSession();

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

  const unresolvedTotal = disagreed.length + unplaceable.length;
  console.log(`\nPLAN`);
  console.log(`  records to rewrite : ${rewritten.length}`);
  console.log(`  left on the old id : ${unresolvedTotal}`);
  console.log(`  already migrated   : ${alreadyDone}`);
  console.log(`  total in scope     : ${data.matches.filter(m => inScope.has(m.compName)).length}`);

  if (unresolvedTotal) {
    console.log(`\n  UNRESOLVED — these keep their current id and rawGrade.`);
    console.log(`  They are pass 3 in grade_identity_migration.md §4, which is not built.`);
    const byKey = new Map();
    for (const { rec } of disagreed) {
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
    console.log(`\nDRY RUN — nothing written. Set MIGRATE_DRY_RUN=false to apply.`);
    logSummary('migrate-grade-ids');
    process.exit(2);
  }
  if (!rewritten.length) {
    console.log(`\nNothing to rewrite.`);
    process.exit(2);
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

  store.report(store.save(data, scope), 'migrate-grade-ids');
  logSummary('migrate-grade-ids');
  console.log(`\n${VERSION}: ${rewritten.length} record(s) rewritten, ${unresolvedTotal} left.`);
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
