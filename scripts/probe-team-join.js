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

const VERSION = 'probe-team-join v1 2026-08-12';
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

// ── cleanTeam, copied from scripts/lib/results-engine.js ─────────────────────
// Stored names have already been through this, so registry names must go through
// exactly the same transformation or nothing will match. Copied rather than
// imported because importing the engine pulls in its store and config loading.
function cleanTeam(name, gradeAge) {
  if (gradeAge) {
    const ageNum = gradeAge.match(/^(U\d+(?:\.\d+)?)/i)?.[1];
    if (ageNum) {
      return name.replace(new RegExp('\\s+' + ageNum.replace('.', '\\.') + '\\b\\s*', 'gi'), ' ')
        .replace(/\s+$/, '').trim();
    }
  }
  return name.replace(/\s+U\d+(?:\.\d+)?\s*/gi, ' ').replace(/\s+$/, '').trim();
}

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

    // Does the richer query work? Asked once per season, reported, never relied on.
    try {
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
    const registryKey = new Map();   // "age|cleanName" -> [team, ...]
    const noGrade = [];
    for (const t of teams) {
      if (!t.grade || !t.grade.name) { noGrade.push(t.name); continue; }
      // Grade names come back verbatim, e.g. "U8 - West", so the age is the
      // leading token.
      const age = (t.grade.name.match(/^(U\d+(?:\.\d+)?(?:\s+Girls)?)/i) || [])[1] || '';
      const clean = cleanTeam(t.name, age);
      const k = `${age}|${clean}`;
      if (!registryKey.has(k)) registryKey.set(k, []);
      registryKey.get(k).push(t);
    }

    let matched = 0, ambiguous = 0, unmatched = 0;
    const exMatched = [], exAmbiguous = [], exUnmatched = [];
    for (const [k, n] of storedPairs) {
      const hit = registryKey.get(k);
      if (!hit) {
        unmatched++;
        if (exUnmatched.length < EXAMPLES) exUnmatched.push(`${k}  (${n} appearances)`);
      } else if (hit.length > 1) {
        ambiguous++;
        if (exAmbiguous.length < EXAMPLES) {
          exAmbiguous.push(`${k} -> ${hit.length} teams: ${hit.map(t => `${t.id} "${t.name}" [${t.grade.name}]`).join(' | ')}`);
        }
      } else {
        matched++;
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

    log(`\n  matched, examples:`);
    for (const e of exMatched) log(`    ${e}`);
    if (exAmbiguous.length) { log(`\n  AMBIGUOUS, examples — these cannot be resolved by name:`); for (const e of exAmbiguous) log(`    ${e}`); }
    if (exUnmatched.length) { log(`\n  UNMATCHED, examples:`); for (const e of exUnmatched) log(`    ${e}`); }
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
