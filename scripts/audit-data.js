#!/usr/bin/env node
// scripts/audit-data.js
//
// Reads data/core.json and data/seasons/*.json and reports whether what is on disk
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
//   AUDIT_ORG=<code>    also print a season-by-season breakdown for one
//                       organisation, by age group. Answers "where did the games
//                       go" — a whole age group disappearing is invisible to the
//                       round-coverage check, because a grade that was never
//                       fetched leaves no gap to find.
//
// Run: node scripts/audit-data.js

'use strict';

const fs = require('fs');
const path = require('path');
// The engine's own parser, so section 7 reproduces the stored age and rawGrade
// rather than re-deriving them. Required lazily below so the rest of the audit
// still runs if the engine is missing.
let parseGradeName = null;
let engineLoadError = null;
try { ({ parseGradeName } = require(path.join(__dirname, 'lib', 'results-engine'))); }
catch (e) { engineLoadError = e.message; }

const VERSION = 'audit-data v18 2026-08-19 unattributed-do-not-self-heal';
const ROOT = process.env.AUDIT_ROOT || path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SEASONS = path.join(DATA, 'seasons');
const ORGS = path.join(DATA, 'orgs');   // the previous layout, kept as a rollback path
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
// A season's display name, for the file listing.
function manifestSeasonName(core, seasonId) {
  const m = (core.manifest || []).find(x => x.seasonId === seasonId);
  return m ? (m.compName || m.seasonName || '') : '(not in manifest)';
}

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

const onDisk = fs.existsSync(SEASONS)
  ? fs.readdirSync(SEASONS).filter(f => /^[0-9a-f]{8}-(core|players)\.json$/.test(f)).sort()
  : [];
if (!onDisk.length) {
  console.error(`FATAL: no season files in data/seasons. Run "Split storage by season" first.`);
  process.exit(1);
}

// ── 1. Files against the seasonFiles index ───────────────────────────────────
// per_season_storage_design.md: one core file and one players file per season.
// A season's records never move between files, so there is no current/archive
// distinction to check — only whether the index matches what is on disk.
console.log('1  Files');
const indexed = new Set((core.seasonFiles || []).map(f => f.file));
for (const f of onDisk) {
  if (!indexed.has(`data/seasons/${f}`)) {
    err(`data/seasons/${f} exists but is missing from core.seasonFiles — the dashboard cannot find it`);
  }
}
for (const rel of indexed) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    err(`core.seasonFiles lists ${rel} but the file does not exist — every visitor gets a 404`);
  }
}

// The previous layout is a deliberate rollback path until a full weekend of
// scheduled runs has passed. Reported so it cannot be forgotten, not as a fault.
if (fs.existsSync(ORGS)) {
  const old = fs.readdirSync(ORGS).filter(f => f.endsWith('.json'));
  if (old.length) {
    const bytes = old.reduce((a, f) => a + fs.statSync(path.join(ORGS, f)).size, 0);
    info(`data/orgs still holds ${old.length} file(s), ${mb(bytes)} — the rollback path from the ` +
         `per-season split. Delete it once the new layout has run a full weekend.`);
  }
}

// seasonId -> { core, players } payloads, merged so the rest of the audit sees
// one object per season exactly as it saw one per organisation file before.
const files = {};
let totalBytes = 0, coreBytes = 0, playerBytes = 0;
for (const f of onDisk) {
  const full = path.join(SEASONS, f);
  const bytes = fs.statSync(full).size;
  totalBytes += bytes;
  const [seasonId, kindExt] = f.split('-');
  const kind = kindExt.replace('.json', '');
  const p = readJson(full);
  if (!p) continue;
  if (kind === 'core') coreBytes += bytes; else playerBytes += bytes;

  if (p.meta && p.meta.seasonId && p.meta.seasonId !== seasonId) {
    err(`${f}: meta.seasonId is ${p.meta.seasonId} but the filename says ${seasonId}`);
  }
  if (bytes > 90 * 1024 * 1024) err(`${f} is ${mb(bytes)} — over GitHub's 100 MB limit is a hard push failure`);
  else if (bytes > 50 * 1024 * 1024) warn(`${f} is ${mb(bytes)} — over half of GitHub's 100 MB per-file limit`);

  const key = seasonId;
  if (!files[key]) files[key] = { seasonId, bytes: 0, payload: { matches: [], players: [], roster: {}, gradeMeta: {} } };
  files[key].bytes += bytes;
  files[key].org = (p.meta && p.meta.org) || files[key].org;
  if (kind === 'core') {
    files[key].payload.matches = p.matches || [];
    files[key].payload.roster = p.roster || {};
    files[key].payload.gradeMeta = p.gradeMeta || {};
    files[key].meta = p.meta;
  } else {
    files[key].payload.players = p.players || [];
  }
}
for (const [sid, v] of Object.entries(files)) {
  const m = manifestSeasonName(core, sid);
  console.log(`  ${sid} ${String(m).padEnd(14)} ${mb(v.bytes).padStart(9)}  ` +
    `${v.payload.matches.length} matches, ${v.payload.players.length} players, ` +
    `${Object.keys(v.payload.roster).length} roster, ${Object.keys(v.payload.gradeMeta).length} gradeMeta`);
}
console.log(`  ${'TOTAL'.padEnd(24)} ${mb(totalBytes).padStart(9)}  across ${onDisk.length} file(s)`);
console.log(`  ${'  core only'.padEnd(24)} ${mb(coreBytes).padStart(9)}  ` +
  `— what a reader needs for ladders and results`);
console.log(`  ${'  players'.padEnd(24)} ${mb(playerBytes).padStart(9)}  ` +
  `(${(100 * playerBytes / totalBytes).toFixed(0)}%) — deferred until Scorers is opened`);

// ── 2. Every record must reach a manifest entry ──────────────────────────────
console.log('\n2  Records against the manifest');
const byComp = new Map();   // compName -> { matches, players, files:Set, ids:Map }
// Records with no gradeId. They cannot be attributed to a grade, so they have no
// round coverage to measure — reported as a total rather than bucketed under a
// fallback key that merges unrelated grades. Declared HERE and not beside the
// other section 4 counters: it is written inside the file loop above them, and a
// const declared after its first use throws at run time where node --check
// cannot see it. That is exactly what the first attempt at this change did.
const unattributed = new Map();
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
      // Keyed exactly as results-engine.js keys knownRounds. Grouping on
      // rawGrade instead measures the union of every collapsed grade and hides
      // the per-grade gaps that drive re-fetching.
      //
      // A record with NO gradeId is NOT bucketed at all. Falling back to
      // rawGrade merged unrelated grades and invented gaps that do not exist:
      // on 2026-08-13 this reported "LIVE YJFL 2026|U10| — has 1..14, missing
      // 8, 9, 10, 11, 12, 13". That key is SIX POOLS — af1a61fe through
      // 4a19ca7a, all parsing to an empty rawGrade — piled into one bucket
      // where no single pool has a contiguous run. The gap was an artefact of
      // this fallback, reported as a live grade costing re-fetches per run,
      // next to a real one (SEJ cb7b3db3 missing round 10) it sat beside.
      // report-grade-collisions.js measured 62 such keys across 121 shadowed
      // grades, so this was never going to be a one-off.
      //
      // Counted and reported separately instead — see the unattributed total
      // below. A record whose grade cannot be identified has no round coverage
      // to measure, and guessing at one is worse than saying so.
      if (rec.gradeId) {
        const key = `${c}|${rec.age}|${rec.gradeId}`;
        if (!b.rounds.has(key)) b.rounds.set(key, new Set());
        b.rounds.get(key).add(rec.round);
      } else {
        const k = `${c}|${rec.age}|${rec.rawGrade || '(empty rawGrade)'}`;
        unattributed.set(k, (unattributed.get(k) || 0) + 1);
      }
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
  // One file per season, so "the right file" is simply the season's own. There
  // is no current/archive placement to get wrong any more — records never move
  // between files, which is what the split removed.
  const expected = m.seasonId;

  if (!b || b.matches === 0) {
    info(`${m.compName} (${m.seasonId}) has no records — not backfilled`);
    rows.push([m.compName, m.seasonId, m.retired ? 'retired' : 'live', '0', '0', 'NOT BACKFILLED']);
    continue;
  }

  for (const f of b.files) {
    if (f !== expected) {
      err(`${m.compName} records are in season file ${f}, but the manifest says ` +
          `they belong to season ${expected}`);
    }
  }

  // meta.phases is flat now — one season per file, so it describes that season
  // rather than being keyed by season id.
  const filePhases = (files[expected] || {}).meta && files[expected].meta.phases;
  let state = 'ok';
  if (!filePhases) {
    err(`${m.compName}: ${expected}-core.json has ${b.matches} matches but no meta.phases`);
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

  rows.push([m.compName, m.seasonId, m.retired ? 'retired' : 'live',
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
console.log('\n4  Round coverage, per grade id — what the fetcher re-walks every run');
let gradesChecked = 0, gradesWithGaps = 0;
const gapExamples = [];
const allGaps = [];   // every gap, ranked before ten are printed
// fetch-results.js takes its competition list from config.json, which holds only
// the current seasons, so it never walks an archived season's rounds. A gap in a
// retired season is worth knowing about but costs nothing per run — counting all
// of them together produced "~645 calls re-fetched on EVERY run" against a real
// run total of 546, which was impossible and should have been caught by reading
// the run rather than trusting the metric.
const retiredComps = new Set(
  (core.manifest || []).filter(m => m.retired && m.compName).map(m => m.compName));
let liveWithGaps = 0, retiredWithGaps = 0;
for (const [c, b] of byComp) {
  const isLive = !retiredComps.has(c);
  for (const [key, rounds] of b.rounds) {
    gradesChecked++;
    const max = Math.max(...rounds);
    const missing = [];
    for (let r = 1; r <= max; r++) if (!rounds.has(r)) missing.push(r);
    if (missing.length) {
      gradesWithGaps++;
      if (isLive) liveWithGaps++; else retiredWithGaps++;
      // Collected in full and ranked below. Taking the first ten as they arrived
      // meant byComp iteration order decided which were shown: on 2026-08-13 the
      // run reported 1 live gap and 67 retired ones, and all ten printed
      // examples were retired. The single gap that costs anything per run was
      // the one gap not printed.
      allGaps.push({ isLive, key, max, missing });
    }
    // No grade id AND no rawGrade. parseGradeName collapsed the name and the
    // record has not been migrated, so nothing identifies its grade.
  }
}

// LIVE first, then by how many rounds are missing. A retired gap costs nothing
// per run; a live one is re-fetched every time. Ranking by cost is the whole
// point of separating the two counts a few lines above.
allGaps.sort((a, b) => (Number(b.isLive) - Number(a.isLive)) ||
                       (b.missing.length - a.missing.length));
for (const g of allGaps.slice(0, 10)) {
  gapExamples.push(`${g.isLive ? 'LIVE    ' : 'retired '}${g.key} — has 1..${g.max}, ` +
    `missing ${g.missing.join(', ')}`);
}
console.log(`  ${gradesChecked} grade(s) checked, ${gradesWithGaps} with a missing round ` +
  `(${liveWithGaps} in a live season, ${retiredWithGaps} in a retired one)`);
// A gap means the consecutive scan in results-engine.js stops there, so every
// round above it is re-fetched. Only a LIVE season costs anything: an archived
// season is not in config.json and is never walked.
if (gradesWithGaps) {
  let wasted = 0;
  for (const [c, b] of byComp) {
    if (retiredComps.has(c)) continue;
    for (const [, rounds] of b.rounds) {
      const mx = Math.max(...rounds);
      let consec = 0;
      for (let r = 1; rounds.has(r); r++) consec = r;
      if (consec < mx) wasted += (mx - consec);
    }
  }
  console.log(`  ~${wasted} round fixture call(s) re-fetched on every full results run ` +
    `(live seasons only — retired ones are never walked)`);
  if (wasted) {
    warn(`${liveWithGaps} live grade(s) have a round gap, costing roughly ${wasted} repeated ` +
         `fixture call(s) per full results run — the consecutive scan restarts at each gap`);
  }
  if (retiredWithGaps) {
    warn(`${retiredWithGaps} retired grade(s) have a round gap. These cost nothing per run — ` +
         `an archived season is not in config.json and is never re-walked — but a gap may be a ` +
         `round that was never played rather than one that was missed`);
  }
}
for (const g of gapExamples) warn(`round gap — ${g}`);
if (gradesWithGaps > gapExamples.length) {
  warn(`${gradesWithGaps - gapExamples.length} further grade(s) with gaps, not listed`);
}
// Records with no gradeId. Until v13 these were bucketed into the round-coverage
// map under `compName|age|rawGrade`, which merged unrelated grades and invented
// gaps: on 2026-08-13 that reported "LIVE YJFL 2026|U10| — has 1..14, missing 8,
// 9, 10, 11, 12, 13", where that key is SIX POOLS (af1a61fe..4a19ca7a) piled
// together and no single pool has a contiguous run. The gap was an artefact of
// the fallback key, reported in the live section beside a real one.
if (unattributed.size) {
  const tot = [...unattributed.values()].reduce((a, b) => a + b, 0);
  // ⚠️ THEY DO NOT SELF-HEAL. This said they would, and that was never true.
  //
  // A results run cannot reach them. `knownRounds` is built in memory from stored
  // records and fetchGrade skips anything at or below it — and a bye sentinel IS a
  // stored record, so its round is never re-walked. Most of these sit in RETIRED
  // seasons besides, which are not in config.json and are never walked at all.
  //
  // Measured 2026-08-19: the count has been exactly 49 across every audit run in
  // the session, and migrate-grade-ids pass 1 and pass 2 both resolved 0 of them.
  // Whether pass 3 can is UNKNOWN — a dry run reports it as having failed while
  // making no API calls at all.
  warn(`${tot} record(s) across ${unattributed.size} key(s) have NO gradeId, so they ` +
       `cannot be attributed to a grade and have no round coverage. These are the ` +
       `"needs pass 2" rows in section 7. They do NOT self-heal: a bye sentinel is ` +
       `a stored record, so its round is never re-walked, and most are in retired ` +
       `seasons that are never walked at all. Reaching them needs migrate-grade-ids ` +
       `pass 3, run for real — a dry run makes no calls`);
  for (const [k, n] of [...unattributed].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    warn(`  unattributed — ${k} — ${n} record(s)`);
  }
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

// ── 6. Per-organisation breakdown by age ─────────────────────────────────────
const ORG = (process.env.AUDIT_ORG || '').trim();
if (ORG) {
  const seasonOf = new Map();     // compName -> seasonName
  const orgComps = [];
  for (const m of core.manifest) {
    if (m.org === ORG && m.compName) { seasonOf.set(m.compName, String(m.seasonName)); orgComps.push(m); }
  }
  console.log(`\n6  Breakdown for ${ORG}` +
    (orgComps.length ? ` (${orgComps[0].orgName || ''})` : ''));

  if (!orgComps.length) {
    warn(`AUDIT_ORG=${ORG} has no manifest entries — nothing to break down`);
  } else {
    const seasons = [...new Set(orgComps.map(m => String(m.seasonName)))].sort();
    // age -> season -> { matches, grades:Set, teams:Set }
    const byAge = new Map();
    for (const [f, { org, payload }] of Object.entries(files)) {
      if (org !== ORG) continue;
      for (const rec of payload.matches || []) {
        const season = seasonOf.get(rec.compName);
        if (!season) continue;
        const age = rec.age || '(none)';
        if (!byAge.has(age)) byAge.set(age, new Map());
        const perSeason = byAge.get(age);
        if (!perSeason.has(season)) perSeason.set(season, { matches: 0, grades: new Set(), teams: new Set() });
        const cell = perSeason.get(season);
        cell.matches++;
        cell.grades.add(String(rec.rawGrade));
        if (rec.home) cell.teams.add(rec.home);
        if (rec.away) cell.teams.add(rec.away);
      }
    }

    // U8 before U10 before U17, and anything non-numeric last.
    const ageNum = (s) => { const m = String(s).match(/(\d+)/); return m ? +m[1] : 9999; };
    const ages = [...byAge.keys()].sort((x, y) => ageNum(x) - ageNum(y) || String(x).localeCompare(String(y)));

    const fmt = (c) => c ? `${c.matches}/${c.grades.size}/${c.teams.size}` : '·';

    const totals = seasons.map(s => {
      let m = 0; const g = new Set(), t = new Set();
      for (const [age, row] of byAge) {
        const c = row.get(s);
        if (!c) continue;
        m += c.matches;
        // Deduplicate on age AND grade. Deduplicating on the grade letter alone
        // collapsed U8 A and U12 A into one and understated every total.
        for (const x of c.grades) g.add(age + '|' + x);
        for (const x of c.teams) t.add(x);
      }
      return `${m}/${g.size}/${t.size}`;
    });

    // ONE width for every row, from the widest thing that has to fit in a
    // column — including the totals, which are the widest cells in the table.
    // Sizing on the heading alone ran them together; sizing the totals
    // separately broke the grid instead.
    const cells = [];
    for (const age of ages) for (const s of seasons) cells.push(fmt(byAge.get(age).get(s)));
    const aw = Math.max(6, ...ages.map(x => String(x).length)) + 2;
    const cw = Math.max(...seasons.map(s => s.length), ...cells.map(c => c.length),
                        ...totals.map(v => v.length)) + 2;
    const head = '  ' + 'age'.padEnd(aw) + seasons.map(s => s.padStart(cw)).join('');

    console.log('  matches / grades / teams');
    console.log(head);
    console.log('  ' + '-'.repeat(aw + seasons.length * cw));
    for (const age of ages) {
      const row = byAge.get(age);
      console.log('  ' + String(age).padEnd(aw) +
        seasons.map(s => fmt(row.get(s)).padStart(cw)).join(''));
    }
    console.log('  ' + '-'.repeat(aw + seasons.length * cw));
    console.log('  ' + 'TOTAL'.padEnd(aw) + totals.map(v => v.padStart(cw)).join(''));

    // An age present in an earlier season and absent from the latest is the
    // thing the round-coverage check cannot see.
    const latest = seasons[seasons.length - 1];
    const dropped = ages.filter(a => byAge.get(a).size && !byAge.get(a).has(latest));
    if (dropped.length) {
      console.log(`\n  present earlier but ABSENT from ${latest}: ${dropped.join(', ')}`);
      for (const a of dropped) {
        const had = [...byAge.get(a).keys()].sort();
        console.log(`    ${String(a).padEnd(aw)} last seen ${had[had.length - 1]}` +
          ` (${byAge.get(a).get(had[had.length - 1]).matches} matches)`);
      }
    } else {
      console.log(`\n  no age group present earlier is missing from ${latest}`);
    }
  }
}

// ── 7. Grade identity coverage ───────────────────────────────────────────────
// Answers grade_identity_migration.md §7 Q1: how many stored RECORDS sit in a
// colliding grade key. 121 of 1,006 grades are shadowed, but grades vary
// enormously in size and the affected ones skew small, so the grade count does
// not bound the record count in either direction.
//
// Offline. No API calls. Every figure is from running the real parseGradeName
// over the real grade names, and counting the real records.
console.log('\n7  Grade identity (grade_identity_migration.md)');
if (!parseGradeName) {
  // An ERROR, not a warning. Silently skipping the measurement and still
  // reporting "0 errors" is how a clean-looking audit hides a gap.
  err(`could not load scripts/lib/results-engine.js, so grade coverage was NOT ` +
      `measured — ${engineLoadError}`);
} else if (!fs.existsSync(GRADES_PATH)) {
  warn('data/grades.json is missing — grade coverage not measured');
} else {
  const grades = readJson(GRADES_PATH) || [];

  // season id -> "age|rawGrade" -> [gradeId, ...]
  const keyToGrades = new Map();
  for (const g of grades) {
    if (!g.seasonID || !g.id) continue;
    if (!keyToGrades.has(g.seasonID)) keyToGrades.set(g.seasonID, new Map());
    const { age, rawGrade } = parseGradeName(g.name, g.ageName, g.genderName);
    const k = `${age}|${rawGrade}`;
    const m = keyToGrades.get(g.seasonID);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(g.id);
  }

  // compName -> seasonId, so a stored record can find its season's grade list.
  const seasonOfComp = new Map();
  for (const m of core.manifest) if (m.compName && m.seasonId) seasonOfComp.set(m.compName, m.seasonId);

  const rows = [];
  const hotKeys = [];     // colliding keys, by how many records they hold
  let tMatches = 0, tDone = 0, tOne = 0, tColl = 0, tNone = 0;

  for (const m of core.manifest) {
    if (!m.compName) continue;
    const seasonId = m.seasonId;
    const km = keyToGrades.get(seasonId);
    let matches = 0, done = 0, one = 0, coll = 0, none = 0;
    const perKey = new Map();

    for (const [f, { payload }] of Object.entries(files)) {
      for (const rec of payload.matches || []) {
        if (rec.compName !== m.compName) continue;
        matches++;
        // Migrated means the id's third segment IS the grade id, not the parsed
        // rawGrade. Both are checked: a gradeId field with an unmigrated id is a
        // half-done record and must not count as done.
        const seg = String(rec.id).split('|')[2];
        if (rec.gradeId && seg === rec.gradeId) { done++; continue; }

        // Not migrated. Why not?
        const k = `${rec.age}|${rec.rawGrade}`;
        const ids = km && km.get(k);
        if (!ids) none++;
        else if (ids.length === 1) one++;
        else {
          coll++;
          perKey.set(k, (perKey.get(k) || 0) + 1);
        }
      }
    }
    if (!matches) continue;
    tMatches += matches; tDone += done; tOne += one; tColl += coll; tNone += none;
    rows.push([m.compName, matches, done, one, coll, none]);
    for (const [k, n] of perKey) hotKeys.push([m.compName, k, n, (km.get(k) || []).length]);
  }

  const w = [14, 10, 11, 12, 14, 10];
  const hdr = ['season', 'matches', 'migrated', 'pass 1 can', 'needs pass 2', 'unknown'];
  console.log('  ' + hdr.map((h, i) => i === 0 ? h.padEnd(w[0]) : h.padStart(w[i])).join(''));
  console.log('  ' + '-'.repeat(w.reduce((x, y) => x + y, 0)));
  for (const r of rows.sort()) {
    console.log('  ' + r.map((c, i) => i === 0 ? String(c).padEnd(w[0]) : String(c).padStart(w[i])).join(''));
  }
  console.log('  ' + '-'.repeat(w.reduce((x, y) => x + y, 0)));
  console.log('  ' + ['TOTAL', tMatches, tDone, tOne, tColl, tNone]
    .map((c, i) => i === 0 ? String(c).padEnd(w[0]) : String(c).padStart(w[i])).join(''));

  const donePct = tMatches ? ((tDone / tMatches) * 100).toFixed(2) : '0.00';
  console.log(`\n  ${tDone} of ${tMatches} record(s) carry their PlayHQ grade id — ${donePct}%.`);
  console.log(`  migrated      the id's third segment is the grade id, and gradeId agrees`);
  console.log(`  pass 1 can    not migrated, but resolvable offline — run the migration`);
  console.log(`  needs pass 2  not migrated, and needs the season team registry`);
  console.log(`  unknown       no grade in grades.json reduces to this record's age|rawGrade`);
  if (tOne) {
    warn(`${tOne} record(s) could be migrated offline right now and have not been — ` +
         `run "Migrate grade ids"`);
  }

  if (hotKeys.length) {
    console.log(`\n  UNMIGRATED records by colliding key — pass 3's worklist:`);
    hotKeys.sort((x, y) => y[2] - x[2]);
    for (const [comp, k, n, g] of hotKeys.slice(0, 15)) {
      console.log(`    ${comp.padEnd(12)} "${k}"`.padEnd(46) + `${String(n).padStart(6)} records across ${g} grades`);
    }
    if (hotKeys.length > 15) console.log(`    ... ${hotKeys.length - 15} further colliding key(s)`);
  }
  if (tNone) {
    warn(`${tNone} stored record(s) have an age|rawGrade that no grade in grades.json ` +
         `reduces to — they cannot be resolved offline OR by the registry`);
  }
}

// ── 8. What a cross-season player search index would cost ───────────────────
// Search covers only the seasons in memory, because all eighteen seasons of
// player records are 94 MB. An index would let it span every season without
// them — but its size depends on how many DISTINCT people there are, not on the
// 224,247 player-season records. The same child across five seasons is five
// records and one person.
//
// Measured here rather than estimated, because the whole decision turns on it.
console.log('\n8  A cross-season search index, sized');
{
  const byUuid = new Map();       // uuid -> { name, seasons:Set }
  let withUuid = 0, noUuid = 0;
  for (const [, v] of Object.entries(files)) {
    for (const p of v.payload.players || []) {
      if (!p.uuid) { noUuid++; continue; }
      withUuid++;
      if (!byUuid.has(p.uuid)) byUuid.set(p.uuid, { name: p.name || '', seasons: new Set() });
      byUuid.get(p.uuid).seasons.add(v.seasonId);
    }
  }
  const people = byUuid.size;
  // PERSON-SEASONS, not records. fetch-stats.js stores one record PER GRADE, so a
  // child who played in two grades in one season has two records and one
  // person-season — section 11 measured 18,540 such person-seasons. Dividing
  // records by people therefore overstated the average: measured 2.54 against a
  // true 2.27 on the real tree, and 2.40 against 2.00 on the verification fixture.
  //
  // The INDEX SIZE below was never affected, and an earlier note in
  // OUTSTANDING_TASKS.md claiming it was has been retracted. `seasons` is a Set,
  // so a second record in the same season adds no entry, and the serialised index
  // carries exactly one entry per person-season. This is a reporting fix, not a
  // sizing one — it does not move the megabyte figure the decision turns on.
  const personSeasons = [...byUuid.values()].reduce((n, v) => n + v.seasons.size, 0);
  console.log(`  ${withUuid} player record(s) with a uuid, ${noUuid} without`);
  console.log(`  ${personSeasons} person-season(s) — a person in two grades in one`);
  console.log(`    season is two records and ONE person-season`);
  console.log(`  ${people} DISTINCT people`);
  if (people) {
    console.log(`  ${(personSeasons / people).toFixed(2)} season(s) each on average`);
    if (withUuid !== personSeasons) {
      console.log(`    (${withUuid - personSeasons} record(s) are a second or later grade ` +
        `within a season the person already appears in)`);
    }
  }

  // Two shapes, both measured by serialising the real thing rather than by
  // multiplying an assumed row size.
  const minimal = [...byUuid].map(([u, v]) => [u, v.name, [...v.seasons]]);
  const minBytes = JSON.stringify(minimal).length;
  console.log(`  index of uuid + name + seasons : ${mb(minBytes)}`);
  console.log(`    (enough to FIND someone; the row's team, age and goals would`);
  console.log(`     come from that season's player file when it is shown)`);

  // For comparison, what search costs today if every season were loaded.
  let allPlayers = 0;
  for (const [, v] of Object.entries(files)) allPlayers += (v.payload.players || []).length;
  console.log(`  every player record, all seasons: ${mb(playerBytes)} (${allPlayers} records)`);
  if (minBytes) {
    console.log(`  the index is ${(playerBytes / minBytes).toFixed(0)}x smaller`);
  }
}

// ── 9. Cross-organisation key shapes ────────────────────────────────────────
// lastround_gotw_keying_design.md. Added as a ninth section rather than inserted
// near the other core.json checks, so no existing section number moves.
//
// gotwFlags must be compName|age|roundKey. It did not carry a competition until
// 2026-08-13.
//
// This is here because the failure mode is silent: a gotwFlags key the dashboard
// cannot build falls through to the automatic closest-margin pick, which looks
// entirely normal. Nothing on screen says the administrator's choice was lost, so
// this is the only place a stale key can announce itself.
//
// lastRound was checked here too until 2026-08-16. It is retired — engine v19
// stopped writing it and Beta 0.176 removed its only reader — so a shape check on
// it would report on a key nothing builds. A stale map may still sit in core.json
// until store.js drops it from CORE_KEYS; it is inert, and reported below as INFO
// rather than checked for shape.
console.log('\n9  Cross-organisation key shapes (lastround_gotw_keying_design.md)');
{
  const compNames = new Set((core.manifest || []).filter(m => m.compName).map(m => m.compName));
  const SHAPES = [
    { key: 'gotwFlags', shape: 'compName|age|roundKey',
      repair: 'these are set from the dashboard, so a wrong one must be re-picked' },
  ];
  for (const { key, shape, repair } of SHAPES) {
    const keys = Object.keys(core[key] || {});
    const wrong = keys.filter(k => k.split('|').length !== 3);
    const unknownComp = keys.filter(k =>
      k.split('|').length === 3 && !compNames.has(k.slice(0, k.indexOf('|'))));
    console.log(`  ${key.padEnd(10)} ${String(keys.length).padStart(5)} key(s), ` +
      `${keys.length - wrong.length} in the ${shape} shape`);
    if (wrong.length) {
      warn(`core.${key}: ${wrong.length} of ${keys.length} key(s) are not ${shape} — e.g. ` +
           `${wrong.slice(0, 3).map(k => `"${k}"`).join(', ')}. index.html cannot build these, ` +
           `so nothing reads them and nothing reports an error. To repair: ${repair}.`);
    }
    if (unknownComp.length) {
      warn(`core.${key}: ${unknownComp.length} key(s) name a competition absent from the ` +
           `manifest — e.g. ${unknownComp.slice(0, 3).map(k => `"${k}"`).join(', ')}. ` +
           `Unreachable, because the dashboard builds the key from a manifest compName.`);
    }
  }

  // RETIRED. Not a shape check — there is no correct shape for a key with no
  // reader. INFO rather than a warning because it costs nothing and cannot be
  // repaired from here: it goes when store.js drops it from CORE_KEYS.
  const retired = Object.keys(core.lastRound || {}).length;
  console.log(`  lastRound  ${String(retired).padStart(5)} key(s) — RETIRED, no reader ` +
    `since Beta 0.176, no writer since engine v19`);
  if (retired) {
    info(`core.lastRound holds ${retired} key(s) and is inert. Nothing reads or writes ` +
         `it. Removed when scripts/lib/store.js drops it from CORE_KEYS.`);
  }
}

// ── 10. Records the dashboard never shows ───────────────────────────────────
// grade_attribution_split_design.md §2 and §5.
//
// index.html's precomputeMatches() sets `_valid = (hg === ag)` where each side's
// grade comes from the ROSTER, and every ladder, scorer list and grade tab filters
// on it. A record whose two sides resolve to different grades is discarded with no
// error. report-grade-collisions.js v2 measured 3,967 such records — 7.6% of all
// stored records, in every one of the eighteen seasons.
//
// WHY THIS IS HERE AND NOT IN THAT REPORT. Two earlier explanations were wrong:
// a mid-season grade split, then colliding age|rawGrade keys. The control killed
// the second — SER 2026 has ZERO colliding keys and drops 11.0%, WFNL 2026 has one
// and drops 1.3%. The cause is GRADING ROUNDS: SER 2026's biggest offender is
// grade 2e8ff182, "U13 Mixed GRADING". Everyone plays in the grading grade, gets
// placed into divisions, and moves; the roster then resolves every team to its
// final division, so every grading game has two sides in different grades.
//
// Grading rounds have nothing to do with grade-name collisions, so this belongs in
// the audit — where it is watched every run — rather than bolted onto a report
// named for something else.
//
// A grading grade and a pre-split grade share a property a promotion does not:
// NO TEAM RESOLVES TO THEM ANY MORE. That "defunct" test is what §4 of the design
// proposes to key the fix on, so the split between defunct and live below is the
// measurement that confirms or kills it.
console.log('\n10  Records the dashboard never shows (grade_attribution_split_design.md)');
console.log('    NOTE: this measures hg === ag from the ROSTER, which Beta 0.166');
console.log('    deliberately did not change. It cannot show that change working —');
console.log('    matchLadderGrade() lives in index.html and is not run here. Do not');
console.log('    read a steady figure as the fix having failed.');
{
  // Grade names, so a defunct grade id can be read rather than merely counted.
  // "U13 Mixed GRADING" is the whole reason this section exists, and a bare id
  // would have hidden it.
  const gradeNameById = new Map();
  for (const g of (readJson(GRADES_PATH) || [])) {
    if (g && g.id) gradeNameById.set(g.id, `${g.compName || '?'} — ${g.name || '?'}`);
  }
  const rosterGrade = (roster, comp, name, age, rawGrade) => {
    const e = roster[`${comp}|${name}|${age}`];
    if (!e) return rawGrade;
    return e.gradeId || e.grade || rawGrade;
  };
  const perComp = new Map();   // comp -> { total, counted, defunct, live }
  const defunctGrades = new Map();  // gradeId -> dropped count
  const liveGrades = new Map();
  const examples = [];

  for (const [, v] of Object.entries(files)) {
    const roster = v.payload.roster || {};
    // Every grade any team currently resolves to. A grade absent from this set is
    // DEFUNCT: nobody is in it, so it cannot be a promotion's origin.
    const liveSet = new Set();
    for (const e of Object.values(roster)) {
      const g = e && (e.gradeId || e.grade);
      if (g) liveSet.add(g);
    }
    for (const m of v.payload.matches || []) {
      if (m.isBye || m.isPartial || m.scheduled) continue;
      const comp = m.compName || '(none)';
      if (!perComp.has(comp)) perComp.set(comp, { total: 0, counted: 0, defunct: 0, live: 0, unresolved: 0 });
      const c = perComp.get(comp);
      c.total++;
      const hg = rosterGrade(roster, comp, m.home, m.age, m.rawGrade);
      const ag = rosterGrade(roster, comp, m.away, m.age, m.rawGrade);
      // THREE outcomes, not two. Collapsing the third into "dropped" is what the
      // first version of this section did, and it inflated the count with records
      // that have no grade information at all rather than a conflict between two.
      //   agree, non-empty  -> shown
      //   neither resolves  -> UNRESOLVED. The page drops it too, but for a
      //                        different reason and with a different fix, so it is
      //                        counted separately.
      //   they disagree     -> dropped, which is what the design is about.
      if (hg === ag) {
        if (hg === undefined || hg === null || hg === '') c.unresolved++;
        else c.counted++;
        continue;
      }
      const gid = m.gradeId || '';
      const isDefunct = gid && !liveSet.has(gid);
      if (isDefunct) { c.defunct++; defunctGrades.set(gid, (defunctGrades.get(gid) || 0) + 1); }
      else { c.live++; liveGrades.set(gid || '(no gradeId)', (liveGrades.get(gid || '(no gradeId)') || 0) + 1); }
      if (examples.length < 8) {
        examples.push(`${comp} R${m.round} ${m.home} -> ${hg} v ${m.away} -> ${ag}` +
          `  [stored ${gid || 'NONE'}, ${isDefunct ? 'DEFUNCT' : 'LIVE'}]`);
      }
    }
  }

  const wc = Math.max(14, ...[...perComp.keys()].map(k => k.length)) + 2;
  console.log('  ' + 'season'.padEnd(wc) + 'records'.padStart(9) + 'shown'.padStart(9) +
    'dropped'.padStart(9) + 'defunct'.padStart(9) + 'live'.padStart(7) +
    'no grade'.padStart(10) + 'dropped %'.padStart(11));
  let tT = 0, tD = 0, tDef = 0, tLive = 0, tU = 0;
  for (const [comp, c] of [...perComp].sort()) {
    const dropped = c.defunct + c.live;
    tT += c.total; tD += dropped; tDef += c.defunct; tLive += c.live; tU += c.unresolved;
    console.log('  ' + comp.padEnd(wc) + String(c.total).padStart(9) +
      String(c.counted).padStart(9) + String(dropped).padStart(9) +
      String(c.defunct).padStart(9) + String(c.live).padStart(7) +
      String(c.unresolved).padStart(10) +
      `${c.total ? ((dropped / c.total) * 100).toFixed(1) : '0.0'}%`.padStart(11));
  }
  console.log('  ' + 'TOTAL'.padEnd(wc) + String(tT).padStart(9) +
    String(tT - tD).padStart(9) + String(tD).padStart(9) +
    String(tDef).padStart(9) + String(tLive).padStart(7) +
    String(tU).padStart(10) +
    `${tT ? ((tD / tT) * 100).toFixed(1) : '0.0'}%`.padStart(11));

  // THE ANSWER TO §5 CLAIM 2. If `live` is near zero, the defunct rule covers
  // essentially every dropped record and the fix in §4 is sound. If it is
  // material, those are promotions and need separate handling — the rule would
  // fire where it should not.
  console.log(`\n  ${tDef} dropped record(s) sit in a DEFUNCT grade (no team resolves to it)`);
  console.log(`  ${tLive} sit in a LIVE grade — these are promotions, NOT grading rounds,`);
  console.log(`  and the defunct rule would not fix them.`);
  if (tU) {
    console.log(`  ${tU} record(s) have NO grade on either side — neither the roster nor`);
    console.log(`  rawGrade resolves them. The page drops these too, but they need grade`);
    console.log(`  identity, not an attribution rule. Counted apart deliberately.`);
  }
  if (tD) {
    console.log(`  defunct share of dropped: ${((tDef / tD) * 100).toFixed(1)}%`);
  }
  if (defunctGrades.size) {
    console.log(`\n  worst defunct grades:`);
    for (const [g, n] of [...defunctGrades].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${String(n).padStart(6)}  ${g}  ${gradeNameById.get(g) || '(not in grades.json)'}`);
    }
  }
  if (liveGrades.size) {
    console.log(`\n  dropped in LIVE grades — investigate before trusting the rule:`);
    for (const [g, n] of [...liveGrades].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${String(n).padStart(6)}  ${g}  ${gradeNameById.get(g) || '(not in grades.json)'}`);
    }
  }
  for (const e of examples) console.log(`    ${e}`);
  if (tD) warn(`${tD} stored record(s) (${((tD / tT) * 100).toFixed(1)}%) never reach the ` +
    `dashboard: their two sides resolve to different grades. ${tDef} are in defunct ` +
    `grades (grading rounds and splits), ${tLive} in live grades (promotions). ` +
    `grade_attribution_split_design.md`);
}

// ── 11. Player records per person per season ────────────────────────────────
// grade_attribution_split_design.md §3.1 depends on an answer this gives.
//
// A grading grade is to get its own tab, ladder and SCORERS list. Whether the
// Scorers part is achievable at all depends on how PlayHQ stores a player who
// played grading and was then placed in a division:
//
//   TWO records in the season, one per gradeID  -> the grading goals are
//     separable, so a grading Scorers list can be built. But anything summing gp
//     or goals across a season double-counts unless it groups by gradeID, and
//     section 8's cross-season index sizing assumes one record per person per
//     season.
//
//   ONE record, folded  -> the grading goals are NOT separable and a grading
//     Scorers list cannot be correct. §3.1 would then apply to ladders and
//     results only, and that has to be written down rather than discovered.
//
// playerGrade() in index.html prefers the ROSTER over p.gradeID and returns early
// when the roster answers with an id. For a graded-then-placed team the roster
// answers with the DIVISION, so grading goals are currently attributed to the
// division's Scorers — the mirror of the match-record defect in section 10.
console.log('\n11  Player records per person per season');
{
  const gradeNameById = new Map();
  for (const g of (readJson(GRADES_PATH) || [])) {
    if (g && g.id) gradeNameById.set(g.id, g.name || '');
  }
  const isGrading = (gid) => /grading/i.test(gradeNameById.get(gid) || '');

  const perComp = new Map();   // comp -> { people, multi, multiWithGrading, maxRecs }
  const gradingGrades = new Map();   // gradeId -> player records
  const examples = [];

  for (const [, v] of Object.entries(files)) {
    // uuid -> [records] within THIS season file.
    const byPerson = new Map();
    for (const rec of v.payload.players || []) {
      if (!rec || !rec.uuid) continue;
      if (!byPerson.has(rec.uuid)) byPerson.set(rec.uuid, []);
      byPerson.get(rec.uuid).push(rec);
      const gid = rec.gradeID || '';
      if (gid && isGrading(gid)) gradingGrades.set(gid, (gradingGrades.get(gid) || 0) + 1);
    }
    for (const [uuid, recs] of byPerson) {
      const comp = recs[0].compName || '(none)';
      if (!perComp.has(comp)) {
        perComp.set(comp, { people: 0, multi: 0, multiWithGrading: 0, maxRecs: 0 });
      }
      const c = perComp.get(comp);
      c.people++;
      if (recs.length > c.maxRecs) c.maxRecs = recs.length;
      if (recs.length > 1) {
        c.multi++;
        const grades = recs.map(r => r.gradeID || '(none)');
        if (grades.some(isGrading)) {
          c.multiWithGrading++;
          if (examples.length < 8) {
            examples.push(`${comp}  ${uuid}  ${recs.length} record(s): ` +
              grades.map(g => `${g}${isGrading(g) ? ' [GRADING]' : ''}`).join(', '));
          }
        } else if (examples.length < 8) {
          examples.push(`${comp}  ${uuid}  ${recs.length} record(s): ${grades.join(', ')}`);
        }
      }
    }
  }

  const wc = Math.max(14, ...[...perComp.keys()].map(k => k.length)) + 2;
  console.log('  ' + 'season'.padEnd(wc) + 'people'.padStart(8) + 'multi'.padStart(8) +
    'w/ grading'.padStart(12) + 'max recs'.padStart(10));
  let tP = 0, tM = 0, tMG = 0, tMax = 0;
  for (const [comp, c] of [...perComp].sort()) {
    tP += c.people; tM += c.multi; tMG += c.multiWithGrading;
    if (c.maxRecs > tMax) tMax = c.maxRecs;
    console.log('  ' + comp.padEnd(wc) + String(c.people).padStart(8) +
      String(c.multi).padStart(8) + String(c.multiWithGrading).padStart(12) +
      String(c.maxRecs).padStart(10));
  }
  console.log('  ' + 'TOTAL'.padEnd(wc) + String(tP).padStart(8) +
    String(tM).padStart(8) + String(tMG).padStart(12) + String(tMax).padStart(10));

  // THE ANSWER §3.1 NEEDS.
  if (!tM) {
    console.log(`\n  >> ONE record per person per season, everywhere. Grading appearances are`);
    console.log(`     FOLDED IN and cannot be separated, so a grading-grade Scorers list`);
    console.log(`     cannot be built. §3.1 applies to ladders and results only.`);
  } else {
    console.log(`\n  >> ${tM} person-season(s) have more than one record, ${tMG} of them`);
    console.log(`     involving a grading grade.`);
    console.log(`     Scorers shows ONE row per person per season, in the grade they ended`);
    console.log(`     in, with gp and goals SUMMED across grades — so index.html must`);
    console.log(`     aggregate these before rendering, and a grading grade gets no Scorers`);
    console.log(`     list of its own. grade_attribution_split_design.md §4.`);
    // NOT a warning about section 8 any more. v16 made that section divide by
    // person-seasons, and the text here still said it counted records — so the
    // audit contradicted itself in its own output, reporting 2.26 above and then
    // calling that very figure inflated below. Restated as what it actually is: a
    // fact the dashboard has to handle, not a defect in this script.
    info(`${tM} person-season(s) hold more than one player record. Anything that ` +
      `summarises a PERSON — the Scorers list, the player panel header — must ` +
      `aggregate them; reading one record gives a single team's figures wearing ` +
      `the person's name. grade_attribution_split_design.md §3.1`);
  }

  if (gradingGrades.size) {
    console.log(`\n  player records in grading grades:`);
    for (const [g, n] of [...gradingGrades].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${String(n).padStart(6)}  ${g}  ${gradeNameById.get(g) || '?'}`);
    }
  } else {
    console.log(`\n  NO player record carries a grading grade id. If grading grades have`);
    console.log(`  results but no player records, Scorers cannot be built for them at all.`);
  }
  for (const e of examples) console.log(`    ${e}`);
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
