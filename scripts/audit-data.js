#!/usr/bin/env node
// scripts/audit-data.js
//
// Reads data/core.json and data/orgs/*.json and reports whether what is on disk
// agrees with the manifest. READ ONLY — it opens nothing for writing and there is
// no commit step in its workflow.
//
// It exists because Phase A wrote thirteen seasons that nothing reads yet. A
// season with results and no players looks identical to one whose run failed
// halfway, and the completeness signal built for that has never been read back
// from real data.
//
// Severities:
//   ERROR   the data contradicts the manifest, or a record cannot be reached.
//           Exits 1.
//   WARNING a known defect, or something that needs a human decision. Exits 0.
//   INFO    a season not yet backfilled, and the size table.
//
// Env:
//   AUDIT_STRICT=true   treat warnings as errors too.
//   AUDIT_ROOT=<path>   audit a different tree. Used by scripts/verify-audit.js;
//                       leave unset to audit this repository.
//
// Run: node scripts/audit-data.js

'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 'audit-data v1 2026-08-12';
const ROOT = process.env.AUDIT_ROOT || path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const ORGS = path.join(DATA, 'orgs');
const CORE_PATH = path.join(DATA, 'core.json');
const GRADES_PATH = path.join(DATA, 'grades.json');
const STRICT = process.env.AUDIT_STRICT === 'true';

const errors = [];
const warnings = [];
const infos = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const info = (m) => infos.push(m);

const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { err(`could not parse ${path.relative(ROOT, p)}: ${e.message}`); return null; }
}

console.log(`=== ${VERSION} ===`);
console.log(`root: ${ROOT}${STRICT ? '   (STRICT — warnings count as errors)' : ''}\n`);

// ── Load ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(CORE_PATH)) {
  console.error(`FATAL: ${CORE_PATH} not found.`);
  process.exit(1);
}
const core = readJson(CORE_PATH);
if (!core || !Array.isArray(core.manifest)) {
  console.error('FATAL: core.json has no manifest.');
  process.exit(1);
}

const onDisk = fs.existsSync(ORGS)
  ? fs.readdirSync(ORGS).filter(f => /^[0-9a-f]{8}-(current|archive)\.json$/.test(f)).sort()
  : [];

// ── 1. Files against the orgFiles index ──────────────────────────────────────
console.log('1  Files');
const indexed = new Set((core.orgFiles || []).map(f => f.file));
for (const f of onDisk) {
  if (!indexed.has(`data/orgs/${f}`)) {
    err(`data/orgs/${f} exists but is missing from core.orgFiles — the dashboard will never fetch it`);
  }
}
for (const rel of indexed) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    err(`core.orgFiles lists ${rel} but the file does not exist — every visitor gets a 404`);
  }
}

const files = {};   // relative name -> parsed payload
let totalBytes = 0;
for (const f of onDisk) {
  const full = path.join(ORGS, f);
  const bytes = fs.statSync(full).size;
  totalBytes += bytes;
  const [org, kindExt] = f.split('-');
  const kind = kindExt.replace('.json', '');
  const p = readJson(full);
  if (!p) continue;
  files[f] = { org, kind, bytes, payload: p };

  if (p.meta && p.meta.org && p.meta.org !== org) {
    err(`${f}: meta.org is ${p.meta.org} but the filename says ${org}`);
  }
  if (p.meta && p.meta.kind && p.meta.kind !== kind) {
    err(`${f}: meta.kind is ${p.meta.kind} but the filename says ${kind}`);
  }
  // GitHub refuses a push over 100 MB per file. data.json was 36 MB before the
  // split, so this is worth a number rather than an assumption.
  if (bytes > 90 * 1024 * 1024) err(`${f} is ${mb(bytes)} — over GitHub's 100 MB limit is a hard push failure`);
  else if (bytes > 50 * 1024 * 1024) warn(`${f} is ${mb(bytes)} — over half of GitHub's 100 MB per-file limit`);

  console.log(`  ${f.padEnd(28)} ${mb(bytes).padStart(9)}  ` +
    `${(p.matches || []).length} matches, ${(p.players || []).length} players, ` +
    `${Object.keys(p.roster || {}).length} roster, ${Object.keys(p.gradeMeta || {}).length} gradeMeta`);
}
console.log(`  ${'TOTAL'.padEnd(28)} ${mb(totalBytes).padStart(9)}  across ${onDisk.length} file(s)`);

// ── 2. Every record must reach a manifest entry ──────────────────────────────
console.log('\n2  Records against the manifest');
const byComp = new Map();   // compName -> { matches, players, files:Set, ids:Map }
const manifestByComp = new Map();
const manifestBySeason = new Map();
for (const m of core.manifest) {
  if (m.compName) manifestByComp.set(m.compName, m);
  if (m.seasonId) manifestBySeason.set(m.seasonId, m);
}

function bucket(compName) {
  if (!byComp.has(compName)) {
    byComp.set(compName, { matches: 0, players: 0, files: new Set(), ids: new Map(), rounds: new Map() });
  }
  return byComp.get(compName);
}

const unplacedMatches = new Map();
const badPrefix = [];
const duplicateIds = [];

for (const [f, { payload }] of Object.entries(files)) {
  for (const rec of payload.matches || []) {
    const c = rec.compName || '(none)';
    const b = bucket(c);
    b.matches++;
    b.files.add(f);
    if (!manifestByComp.has(c)) unplacedMatches.set(c, (unplacedMatches.get(c) || 0) + 1);
    // The id is compName|age|rawGrade|roundToken|teams. If the prefix and the
    // compName field disagree the record is unreachable from either direction.
    if (rec.id && !String(rec.id).startsWith(c + '|')) {
      if (badPrefix.length < 5) badPrefix.push(`${f}: id "${rec.id}" but compName "${c}"`);
    }
    if (rec.id) {
      if (b.ids.has(rec.id) && duplicateIds.length < 5) {
        duplicateIds.push(`${c}: id "${rec.id}" appears more than once`);
      }
      b.ids.set(rec.id, true);
    }
    // Round coverage per grade, home-and-away only. Finals restart at 1 and
    // would corrupt the scan.
    if (!rec.isFinals && !rec.scheduled && typeof rec.round === 'number') {
      const key = `${c}|${rec.age}|${rec.rawGrade}`;
      if (!b.rounds.has(key)) b.rounds.set(key, new Set());
      b.rounds.get(key).add(rec.round);
    }
  }
  for (const rec of payload.players || []) {
    const c = rec.compName || '(none)';
    const b = bucket(c);
    b.players++;
    if (!manifestByComp.has(c)) unplacedMatches.set(c, (unplacedMatches.get(c) || 0) + 1);
  }
  for (const k of ['roster', 'gradeMeta']) {
    for (const key of Object.keys(payload[k] || {})) {
      const c = key.slice(0, key.indexOf('|'));
      if (!manifestByComp.has(c)) {
        err(`${f}: ${k} key "${key}" has no manifest entry for "${c}" — nothing can read it`);
      }
    }
  }
}

for (const [c, n] of unplacedMatches) {
  err(`${n} record(s) carry compName "${c}", which is not in the manifest — unreachable`);
}
for (const m of badPrefix) err(`match id does not match its compName — ${m}`);
for (const m of duplicateIds) err(`duplicate match id — ${m}`);
if (!unplacedMatches.size && !badPrefix.length && !duplicateIds.length) {
  console.log('  every record reaches a manifest entry, and every id matches its compName');
}

// ── 3. Seasons: right file, counts, completeness ─────────────────────────────
console.log('\n3  Seasons');
const rows = [];
for (const m of core.manifest) {
  if (!m.compName) continue;
  const b = byComp.get(m.compName);
  const expected = `${m.org}-${m.retired ? 'archive' : 'current'}.json`;

  if (!b || b.matches === 0) {
    info(`${m.compName} (${m.seasonId}) has no records — not backfilled`);
    rows.push([m.compName, m.seasonId, m.retired ? 'archive' : 'current', '0', '0', 'NOT BACKFILLED']);
    continue;
  }

  for (const f of b.files) {
    if (f !== expected) {
      err(`${m.compName} records are in ${f} but the manifest says ${m.retired ? 'retired' : 'live'}, ` +
          `so they belong in ${expected}`);
    }
  }

  // meta.phases in the file
  const fileMeta = (files[expected] || {}).payload;
  const filePhases = fileMeta && fileMeta.meta && (fileMeta.meta.phases || {})[m.seasonId];
  let state = 'ok';
  if (!filePhases) {
    err(`${m.compName}: ${expected} has ${b.matches} matches but meta.phases has no entry for ${m.seasonId}`);
    state = 'NO meta.phases';
  } else {
    if (filePhases.matches !== b.matches) {
      err(`${m.compName}: meta.phases says ${filePhases.matches} matches, the file holds ${b.matches}`);
      state = 'COUNT MISMATCH';
    }
    if (filePhases.players_n !== b.players) {
      err(`${m.compName}: meta.phases says ${filePhases.players_n} players, the file holds ${b.players}`);
      state = 'COUNT MISMATCH';
    }
  }

  // the manifest's copy of the same signal
  if (!m.phases) {
    warn(`${m.compName}: the manifest entry has no phases block — run "Discover seasons"`);
  } else if (filePhases) {
    if (m.phases.results !== filePhases.results || m.phases.players !== filePhases.players) {
      err(`${m.compName}: manifest says results=${m.phases.results} players=${m.phases.players}, ` +
          `the file says results=${filePhases.results} players=${filePhases.players}. The file is authoritative.`);
      state = 'MANIFEST DRIFT';
    }
  }

  rows.push([m.compName, m.seasonId, m.retired ? 'archive' : 'current',
             String(b.matches), String(b.players), state]);
}

const w = [22, 10, 9, 9, 9, 16];
const line = (r) => '  ' + r.map((c, i) => String(c).padEnd(w[i])).join(' ');
console.log(line(['season', 'id', 'file', 'matches', 'players', 'state']));
for (const r of rows.sort()) console.log(line(r));

// ── 4. Round coverage ────────────────────────────────────────────────────────
// The strongest check available: a grade holding rounds 1,2,3,5,6 lost round 4.
// Re-running the backfill repairs it, because the consecutive scan stops at the
// gap.
console.log('\n4  Round coverage');
let gradesChecked = 0, gradesWithGaps = 0;
const gapExamples = [];
const emptyGrade = new Map();
for (const [c, b] of byComp) {
  for (const [key, rounds] of b.rounds) {
    gradesChecked++;
    const max = Math.max(...rounds);
    const missing = [];
    for (let r = 1; r <= max; r++) if (!rounds.has(r)) missing.push(r);
    if (missing.length) {
      gradesWithGaps++;
      if (gapExamples.length < 10) {
        gapExamples.push(`${key} — has 1..${max}, missing ${missing.join(', ')}`);
      }
    }
    // An empty rawGrade means parseGradeName could not resolve a grade name and
    // collapsed it. Every grade sharing that key shares a match id space.
    if (key.split('|')[2] === '') emptyGrade.set(c, (emptyGrade.get(c) || 0) + 1);
  }
}
console.log(`  ${gradesChecked} grade(s) checked, ${gradesWithGaps} with a missing round`);
for (const g of gapExamples) warn(`round gap — ${g}`);
if (gradesWithGaps > gapExamples.length) {
  warn(`${gradesWithGaps - gapExamples.length} further grade(s) with gaps, not listed`);
}
for (const [c, n] of emptyGrade) {
  warn(`${c}: ${n} grade key(s) have an empty rawGrade — parseGradeName collapsed them, ` +
       `so games in different grades share a match id and one overwrites the other`);
}

// ── 5. grades.json coverage ──────────────────────────────────────────────────
console.log('\n5  grades.json');
if (!fs.existsSync(GRADES_PATH)) {
  warn('data/grades.json does not exist — an archive cannot be resolved to its grades');
} else {
  const grades = readJson(GRADES_PATH) || [];
  const seasonsInGrades = new Set(grades.map(g => g.seasonID));
  console.log(`  ${grades.length} grade(s) across ${seasonsInGrades.size} season(s)`);
  for (const m of core.manifest) {
    if (!m.compName) continue;
    const b = byComp.get(m.compName);
    if (!b || !b.matches) continue;
    if (!seasonsInGrades.has(m.seasonId)) {
      warn(`${m.compName} has ${b.matches} matches but no grades in grades.json — ` +
           `its archive cannot be resolved to a grade list`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(64)}`);
for (const m of infos) console.log(`INFO     ${m}`);
for (const m of warnings) console.log(`WARNING  ${m}`);
for (const m of errors) console.log(`ERROR    ${m}`);
console.log(`${'='.repeat(64)}`);
console.log(`${VERSION}: ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info`);

const failed = errors.length || (STRICT && warnings.length);
process.exit(failed ? 1 : 0);
