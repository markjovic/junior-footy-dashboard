#!/usr/bin/env node
// scripts/probe-team-join.js
//
// Measures whether stored match records can be joined to a PlayHQ season team
// registry BY NAME. team_registry_design.md §3 keys everything on the team id,
// but no stored record has one — both fetchers select it and discard it — so
// attaching ids to 41.81 MB of existing records needs a one-time bridge, and the
// only thing stored records carry is the team name.
//
// This measures whether that bridge works before anything is built on it. If the
// match rate is poor the plan needs a different answer, and the cost of finding
// out is one API call per season.
//
// READ ONLY. It fetches from PlayHQ and reads data/, and writes nothing.
//
// Env:
//   PROBE_SEASONS   comma-separated season ids. Default: EFNL 2025 and 2024.
//   PROBE_EXAMPLES  how many examples of each category to print. Default 8.
//
// Run: node scripts/probe-team-join.js

'use strict';

const fs = require('fs');
const path = require('path');
const { gqlPost, refreshSession, sleep, logSummary } = require('./lib/playhq');
// The engine's OWN parseGradeName and cleanTeam. Reproducing them here is how v1
// went wrong: its age regex only recognised U-ages, so every senior grade keyed
// as an empty string and 36% of teams looked unmatched when they were not.
const { parseGradeName, cleanTeam } = require('./lib/results-engine');

const VERSION = 'probe-team-join v3 2026-08-12 per-age';
const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'data', 'core.json');
const ORGS = path.join(ROOT, 'data', 'orgs');
const EXAMPLES = parseInt(process.env.PROBE_EXAMPLES || '8', 10);

// ── Copied verbatim from scripts/probe-search.js, which ran on 2026-08-11 ─────
// against all three EFNL seasons. Not written fresh: the working practice is
// explicit that queries are copied from something that has actually run, and the
// discoverCompetitions mistake came from doing otherwise.
const TEAMS_QUERY =
  'query discoverTeamsBySeason($seasonId: ID!) {\n' +
  '  discoverTeams(filter: {seasonID: $seasonId}) {\n' +
  '    id name\n' +
  '    grade { id name }\n' +
  '    organisation { id name }\n' +
  '  }\n' +
  '}\n';

// The same query with age and gender added. team_registry_design.md §3.2 assumes
// both are available on a team, and neither has been requested from this
// document. Asked separately so a failure here cannot break the measurement
// above — that is the whole point of probing rather than assuming.
const TEAMS_QUERY_EXTRA =
  'query discoverTeamsBySeason($seasonId: ID!) {\n' +
  '  discoverTeams(filter: {seasonID: $seasonId}) {\n' +
  '    id name\n' +
  '    grade { id name }\n' +
  '    organisation { id name }\n' +
  '    age { name value }\n' +
  '    gender { name value }\n' +
  '  }\n' +
  '}\n';

const log = (m) => console.log(m);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

async function main() {
  log(`=== ${VERSION} ===`);

  const core = readJson(CORE_PATH);
  if (!core || !Array.isArray(core.manifest)) {
    console.error('FATAL: data/core.json has no manifest.');
    process.exit(1);
  }

  const gradesJson = readJson(path.join(ROOT, 'data', 'grades.json')) || [];
  if (!gradesJson.length) {
    console.error('FATAL: data/grades.json is empty — the join goes through it.');
    process.exit(1);
  }
  log(`grades.json: ${gradesJson.length} grade(s) across all seasons`);

  const wanted = (process.env.PROBE_SEASONS || '75d8a232,ca9cc98b')
    .split(',').map(s => s.trim()).filter(Boolean);

  await refreshSession();

  for (const seasonId of wanted) {
    const entry = core.manifest.find(m => m.seasonId === seasonId);
    if (!entry) { console.error(`  season ${seasonId} is not in the manifest — skipping`); continue; }
    log(`\n${'='.repeat(70)}\n${entry.compName} (${seasonId}), ${entry.status}\n${'='.repeat(70)}`);

    // ── 1. The registry, from PlayHQ ─────────────────────────────────────────
    let teams = [];
    try {
      const r = await gqlPost(TEAMS_QUERY, { seasonId }, 'discoverTeamsBySeason');
      teams = (r && r.data && r.data.discoverTeams) || [];
      if (r && r.errors) for (const e of r.errors) log(`  API error: ${e.message}`);
    } catch (e) {
      console.error(`  FATAL fetching the registry: ${e.message}`);
      continue;
    }
    log(`registry: ${teams.length} team(s), ${teams.filter(t => t.grade && t.grade.id).length} with a grade`);

    // ANSWERED 2026-08-12: age and gender are NOT fields on DiscoverTeam.
    //   Cannot query field "age" on type "DiscoverTeam". Did you mean "name"?
    // Kept only behind an env flag, because asking again costs four retries —
    // playhq.js classifies a 400 validation error as transient and retries it.
    if (process.env.PROBE_ASK_AGE === 'true') try {
      const r2 = await gqlPost(TEAMS_QUERY_EXTRA, { seasonId }, 'discoverTeamsBySeason');
      const t2 = (r2 && r2.data && r2.data.discoverTeams) || [];
      if (r2 && r2.errors && r2.errors.length) {
        log(`age/gender on a team: REJECTED — ${r2.errors[0].message}`);
      } else if (t2.length) {
        const s = t2.find(t => t.age || t.gender) || t2[0];
        log(`age/gender on a team: ACCEPTED — e.g. age=${JSON.stringify(s.age)} gender=${JSON.stringify(s.gender)}`);
      }
    } catch (e) {
      log(`age/gender on a team: REJECTED — ${e.message}`);
    }
    await sleep(500);

    // ── 2. What is stored ────────────────────────────────────────────────────
    // Distinct (age, cleaned team name) pairs appearing in stored matches. The
    // age is part of the key because cleanTeam strips it: "Norwood U12 Purple"
    // and "Norwood U14 Purple" both store as "Norwood Purple", so the name alone
    // is not unique and never was.
    const storedPairs = new Map();   // "age|name" -> count
    for (const f of fs.existsSync(ORGS) ? fs.readdirSync(ORGS) : []) {
      if (!/^[0-9a-f]{8}-(current|archive)\.json$/.test(f)) continue;
      const payload = readJson(path.join(ORGS, f));
      for (const m of (payload && payload.matches) || []) {
        if (m.compName !== entry.compName) continue;
        for (const side of ['home', 'away']) {
          if (!m[side]) continue;
          const k = `${m.age}|${m[side]}`;
          storedPairs.set(k, (storedPairs.get(k) || 0) + 1);
        }
      }
    }
    log(`stored:   ${storedPairs.size} distinct (age, team) pair(s) across the season's matches`);

    if (!storedPairs.size) { log('  nothing stored for this season — skipping the join'); continue; }

    // ── 3. The join ──────────────────────────────────────────────────────────
    // Registry names go through the same cleanTeam the fetchers applied, using
    // the grade name as the age source, so both sides are in the same shape.
    // The join goes through the GRADE ID, not through a parsed name.
    // grades.json already holds, per grade id, the ageName and genderName the
    // API returned, which are exactly what parseGradeName consumed when the
    // record was stored. So the stored age is reproduced rather than guessed.
    const gradeById = new Map();
    for (const g of gradesJson) {
      if (g.seasonID === seasonId && g.id) gradeById.set(g.id, g);
    }
    log(`grades.json: ${gradeById.size} grade(s) for this season`);

    const registryKey = new Map();   // "age|cleanName" -> [team, ...]
    const noGrade = [];
    const gradeNotInJson = [];
    for (const t of teams) {
      if (!t.grade || !t.grade.id) { noGrade.push(t.name); continue; }
      const g = gradeById.get(t.grade.id);
      if (!g) {
        if (gradeNotInJson.length < EXAMPLES) {
          gradeNotInJson.push(`${t.grade.id} "${t.grade.name}" (team "${t.name}")`);
        }
        continue;
      }
      const { age } = parseGradeName(g.name, g.ageName, g.genderName);
      const clean = cleanTeam(t.name, age);
      const k = `${age}|${clean}`;
      if (!registryKey.has(k)) registryKey.set(k, []);
      registryKey.get(k).push(t);
    }
    if (gradeNotInJson.length) {
      log(`\n  registry grades absent from grades.json, examples:`);
      for (const e of gradeNotInJson) log(`    ${e}`);
    }

    let matched = 0, ambiguous = 0, unmatched = 0;
    const exMatched = [], exAmbiguous = [], exUnmatched = [];
    // Counted per age as well as in total. A whole age group failing is the
    // failure mode this probe has already hit once — v1's regex broke every
    // senior grade, and that was only visible because the examples happened to
    // be senior teams. A category should be obvious from the counts, not
    // inferred from eight sampled lines.
    const perAge = new Map();   // age -> { matched, ambiguous, unmatched }
    const cell = (age) => {
      if (!perAge.has(age)) perAge.set(age, { matched: 0, ambiguous: 0, unmatched: 0 });
      return perAge.get(age);
    };
    for (const [k, n] of storedPairs) {
      const age = k.slice(0, k.indexOf('|'));
      const hit = registryKey.get(k);
      if (!hit) {
        unmatched++; cell(age).unmatched++;
        if (exUnmatched.length < EXAMPLES) exUnmatched.push(`${k}  (${n} appearances)`);
      } else if (hit.length > 1) {
        ambiguous++; cell(age).ambiguous++;
        if (exAmbiguous.length < EXAMPLES) {
          exAmbiguous.push(`${k} -> ${hit.length} teams: ${hit.map(t => `${t.id} "${t.name}" [${t.grade.name}]`).join(' | ')}`);
        }
      } else {
        matched++; cell(age).matched++;
        if (exMatched.length < EXAMPLES) exMatched.push(`${k} -> ${hit[0].id} "${hit[0].name}" [${hit[0].grade.name}]`);
      }
    }

    const total = storedPairs.size;
    const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
    log(`\nJOIN RESULT for ${entry.compName}`);
    log(`  matched to exactly one team : ${matched} (${pct(matched)})`);
    log(`  ambiguous, several teams    : ${ambiguous} (${pct(ambiguous)})`);
    log(`  no registry team at all     : ${unmatched} (${pct(unmatched)})`);
    log(`  registry teams with no grade: ${noGrade.length} (excluded from the join)`);

    // Per age, worst first, so anything systematically broken is the first
    // thing on the screen.
    const ageNum = (s) => { const m = String(s).match(/(\d+)/); return m ? +m[1] : 9999; };
    const ageRows = [...perAge.entries()]
      .sort((a, b) => (b[1].unmatched + b[1].ambiguous) - (a[1].unmatched + a[1].ambiguous)
                   || ageNum(a[0]) - ageNum(b[0]));
    const aw = Math.max(12, ...ageRows.map(([a]) => a.length)) + 2;
    log(`\n  per age (worst first)`);
    log('    ' + 'age'.padEnd(aw) + 'matched'.padStart(9) + 'ambiguous'.padStart(11) + 'unmatched'.padStart(11));
    for (const [age, c] of ageRows) {
      const flag = (c.unmatched || c.ambiguous) ? '  <--' : '';
      log('    ' + String(age || '(empty)').padEnd(aw) +
        String(c.matched).padStart(9) + String(c.ambiguous).padStart(11) +
        String(c.unmatched).padStart(11) + flag);
    }

    log(`\n  matched, examples:`);
    for (const e of exMatched) log(`    ${e}`);
    if (exAmbiguous.length) { log(`\n  AMBIGUOUS, examples — these cannot be resolved by name:`); for (const e of exAmbiguous) log(`    ${e}`); }
    if (exUnmatched.length) {
      // One example per age before a second from any age, so a sample of eight
      // cannot be eight rows of the same problem.
      const byAgeEx = new Map();
      for (const [k, n] of storedPairs) {
        if (registryKey.get(k)) continue;
        const age = k.slice(0, k.indexOf('|'));
        if (!byAgeEx.has(age)) byAgeEx.set(age, []);
        byAgeEx.get(age).push(`${k}  (${n} appearances)`);
      }
      log(`\n  UNMATCHED, one example per age:`);
      let shown = 0;
      for (const [age, list] of byAgeEx) {
        log(`    ${list[0]}${list.length > 1 ? `   [+${list.length - 1} more in ${age}]` : ''}`);
        if (++shown >= EXAMPLES * 2) { log(`    ... ${byAgeEx.size - shown} further age group(s)`); break; }
      }
    }
    if (noGrade.length) log(`\n  registry teams with no grade, examples: ${noGrade.slice(0, 5).join(', ')}`);

    await sleep(1000);
  }

  logSummary('probe-team-join');
  log(`\n${VERSION}: done. Nothing was written.`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
