// scripts/report-data-size.js
// READ-ONLY. Reports the byte composition of data/data.json so the storage
// split can be designed from arithmetic rather than from dividing 36.6 MB by
// five and hoping.
//
// Writes nothing to data/. Commits nothing. Safe to delete once the storage
// design is settled.
//
// Byte figures are MINIFIED bytes — the form data.json is actually written in
// (fetch-results.js line 1154, JSON.stringify with no indent argument).

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_PATH = path.join(DATA_DIR, 'data.json');
const REPORT_PATH = path.join(ROOT, 'data-size-report.json');

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function pct(part, whole) {
  return whole ? `${((part / whole) * 100).toFixed(1)}%` : '—';
}

// Minified cost of one key/value pair inside an object: "key":value plus the
// separating comma. Close enough to exact that the shares are trustworthy.
function pairBytes(key, value) {
  return JSON.stringify(key).length + 1 + JSON.stringify(value === undefined ? null : value).length + 1;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padL(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`FATAL: ${DATA_PATH} not found.`);
    process.exit(1);
  }

  const report = { generatedAt: new Date().toISOString() };

  // ── Files on disk ──────────────────────────────────────────────────────────
  console.log('=== files in data/ ===');
  const files = fs.readdirSync(DATA_DIR).sort();
  report.files = {};
  for (const f of files) {
    const st = fs.statSync(path.join(DATA_DIR, f));
    if (!st.isFile()) continue;
    report.files[f] = st.size;
    console.log(`  ${pad(f, 28)} ${padL(human(st.size), 12)}`);
  }

  const rawBytes = report.files['data.json'] || 0;
  console.log(`\nreading data.json (${human(rawBytes)})...`);
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  // ── Top-level keys ─────────────────────────────────────────────────────────
  console.log('\n=== data.json top-level keys ===');
  console.log(`  ${pad('key', 20)} ${padL('bytes', 12)} ${padL('share', 8)}  entries`);
  const topLevel = {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    const bytes = pairBytes(k, v);
    const entries = Array.isArray(v)
      ? v.length
      : v && typeof v === 'object'
        ? Object.keys(v).length
        : null;
    topLevel[k] = { bytes, entries, type: Array.isArray(v) ? 'array' : typeof v };
  }
  report.topLevel = topLevel;

  const ordered = Object.entries(topLevel).sort((a, b) => b[1].bytes - a[1].bytes);
  for (const [k, v] of ordered) {
    console.log(`  ${pad(k, 20)} ${padL(human(v.bytes), 12)} ${padL(pct(v.bytes, rawBytes), 8)}  ${v.entries === null ? '' : v.entries}`);
  }

  const matches = Array.isArray(data.matches) ? data.matches : [];

  // ── Match record kinds ─────────────────────────────────────────────────────
  // Sentinels are not results. Counting them together with real matches would
  // overstate how much of the file is actual game data.
  console.log('\n=== match records by kind ===');
  const kinds = { real: 0, bye: 0, partial: 0, scheduled: 0 };
  const kindBytes = { real: 0, bye: 0, partial: 0, scheduled: 0 };
  for (const m of matches) {
    const kind = m.isBye ? 'bye' : m.isPartial ? 'partial' : m.scheduled ? 'scheduled' : 'real';
    kinds[kind]++;
    kindBytes[kind] += JSON.stringify(m).length + 1;
  }
  report.matchKinds = { counts: kinds, bytes: kindBytes };
  for (const k of Object.keys(kinds)) {
    console.log(`  ${pad(k, 20)} ${padL(kinds[k], 8)} records ${padL(human(kindBytes[k]), 12)}`);
  }

  // ── Per-competition ────────────────────────────────────────────────────────
  // This is the projection that matters: a split by organisation produces one
  // file per competition, so its size is what the split has to fit under.
  console.log('\n=== per competition ===');
  const byComp = {};
  const bump = (comp, field, n) => {
    if (!byComp[comp]) byComp[comp] = { matches: 0, matchBytes: 0, rosterBytes: 0, gradeMetaBytes: 0 };
    byComp[comp][field] += n;
  };

  for (const m of matches) {
    const comp = m.compName || '(none)';
    bump(comp, 'matches', 1);
    bump(comp, 'matchBytes', JSON.stringify(m).length + 1);
  }

  // roster keys are "compName|team|age", gradeMeta keys are "compName|age|grade"
  for (const [k, v] of Object.entries(data.roster || {})) {
    bump(k.slice(0, k.indexOf('|')) || '(none)', 'rosterBytes', pairBytes(k, v));
  }
  for (const [k, v] of Object.entries(data.gradeMeta || {})) {
    bump(k.slice(0, k.indexOf('|')) || '(none)', 'gradeMetaBytes', pairBytes(k, v));
  }

  report.byCompetition = byComp;
  console.log(`  ${pad('competition', 22)} ${padL('matches', 9)} ${padL('match', 11)} ${padL('roster', 10)} ${padL('gradeMeta', 10)} ${padL('total', 11)}`);
  const compRows = Object.entries(byComp)
    .map(([c, v]) => [c, v, v.matchBytes + v.rosterBytes + v.gradeMetaBytes])
    .sort((a, b) => b[2] - a[2]);
  for (const [c, v, total] of compRows) {
    console.log(`  ${pad(c, 22)} ${padL(v.matches, 9)} ${padL(human(v.matchBytes), 11)} ${padL(human(v.rosterBytes), 10)} ${padL(human(v.gradeMetaBytes), 10)} ${padL(human(total), 11)}`);
  }
  const largestComp = compRows.length ? compRows[0][2] : 0;

  // ── Field cost inside a match record ───────────────────────────────────────
  console.log('\n=== bytes per field across all match records ===');
  const fieldBytes = {};
  const fieldCount = {};
  for (const m of matches) {
    for (const k of Object.keys(m)) {
      fieldBytes[k] = (fieldBytes[k] || 0) + pairBytes(k, m[k]);
      fieldCount[k] = (fieldCount[k] || 0) + 1;
    }
  }
  report.matchFieldBytes = fieldBytes;
  const totalMatchBytes = Object.values(fieldBytes).reduce((a, b) => a + b, 0);
  console.log(`  ${pad('field', 16)} ${padL('bytes', 12)} ${padL('share', 8)} ${padL('present', 9)}`);
  for (const [k, b] of Object.entries(fieldBytes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(k, 16)} ${padL(human(b), 12)} ${padL(pct(b, totalMatchBytes), 8)} ${padL(fieldCount[k], 9)}`);
  }

  // ── Logo redundancy ────────────────────────────────────────────────────────
  // fetch-results.js line 1102 builds teamLogos FROM m.hLogo/m.aLogo, so every
  // per-match copy is a second storage of a URL already held once by team name.
  console.log('\n=== logo redundancy ===');
  const logoBytes = (fieldBytes.hLogo || 0) + (fieldBytes.aLogo || 0);
  const distinctLogos = new Set();
  for (const m of matches) {
    if (m.hLogo) distinctLogos.add(m.hLogo);
    if (m.aLogo) distinctLogos.add(m.aLogo);
  }
  const teamLogoBytes = topLevel.teamLogos ? topLevel.teamLogos.bytes : 0;
  report.logoRedundancy = {
    perMatchBytes: logoBytes,
    distinctUrls: distinctLogos.size,
    teamLogosBytes: teamLogoBytes,
    shareOfFile: rawBytes ? logoBytes / rawBytes : 0,
  };
  console.log(`  hLogo + aLogo on match records   ${padL(human(logoBytes), 12)}  ${pct(logoBytes, rawBytes)} of file`);
  console.log(`  distinct logo URLs               ${padL(distinctLogos.size, 12)}`);
  console.log(`  teamLogos map (holds them once)  ${padL(human(teamLogoBytes), 12)}`);

  // ── Projections ────────────────────────────────────────────────────────────
  console.log('\n=== projections ===');
  const withoutLogos = rawBytes - logoBytes;
  const perComp = compRows.length ? compRows.reduce((a, r) => a + r[2], 0) / compRows.length : 0;
  report.projections = {
    currentBytes: rawBytes,
    withoutMatchLogos: withoutLogos,
    largestCompetitionBytes: largestComp,
    meanCompetitionBytes: Math.round(perComp),
    sixteenCompetitionsCurrentSeason: Math.round(perComp * 16),
    githubFileLimit: 100 * 1024 * 1024,
  };
  console.log(`  data.json now                       ${padL(human(rawBytes), 12)}`);
  console.log(`  without per-match logos             ${padL(human(withoutLogos), 12)}  (${pct(logoBytes, rawBytes)} saved)`);
  console.log(`  largest single competition          ${padL(human(largestComp), 12)}`);
  console.log(`  mean competition                    ${padL(human(perComp), 12)}`);
  console.log(`  16 competitions, current season     ${padL(human(perComp * 16), 12)}  (one file each, so the`);
  console.log(`                                                     100 MB per-file limit applies per competition, not to this total)`);

  // A per-competition split is only worth doing if no single competition
  // approaches the limit. Say so rather than leaving it to be inferred.
  if (largestComp > 100 * 1024 * 1024) {
    console.log('\n  WARNING: the largest competition alone exceeds the 100 MB file limit.');
    console.log('  A per-competition split is not sufficient; it needs splitting per season too.');
  } else {
    console.log(`\n  Largest competition is ${pct(largestComp, 100 * 1024 * 1024)} of the 100 MB file limit,`);
    console.log('  so one file per competition fits with room for history.');
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nWrote ${REPORT_PATH}`);
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
}
