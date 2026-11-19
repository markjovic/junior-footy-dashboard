#!/usr/bin/env node
// scripts/report-transfers.js
//
// Who has registered with a DIFFERENT club for next season? READ-ONLY — no
// PlayHQ call, no session, nothing written to the repo. Seconds to run.
//
// ⚠️ A CLUB IS KNOWN LONG BEFORE A TEAM IS. A pre-season registration carries
// `organisation` from the moment a child signs up, months before teams are
// picked. So a transfer is visible NOW even though the 2027 teams do not exist:
// compare the club on their current-season record against the club on their
// next-season one.
//
// ⚠️ COMPARED BY ORGANISATION ID, NOT BY NAME. "Northcote Junior Football Club
// (YJFL)" and "Northcote JFC" are the same club typed two ways, and a name
// comparison would report a transfer that never happened.
//
// ⚠️ A PLAYER WALKED BEFORE THE 2027 SEASONS ENTERED THE MANIFEST IS UNRELIABLE.
// `tracked` means "this season is one of ours"; until discover-seasons recorded
// YJFL/EFNL/SEJ 2027 on 2026-11-18, a real 2027 registration was filed under
// `other` instead. Those players look like "no registration" and are not. This
// report finds the cutoff from the manifest and counts them separately rather
// than letting them dilute the answer.
//
// Env: RT_CLUB (filter to one club, name or org id), RT_LIMIT (rows per section,
//      default 40), RT_OUT (reports).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');

const VERSION = 'report-transfers v1 2026-11-18';

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const OUT_DIR = path.join(ROOT, process.env.RT_OUT || 'reports');
const CLUB = (process.env.RT_CLUB || '').trim();
const LIMIT = Math.max(1, Number(process.env.RT_LIMIT || 40));

const log = (...a) => console.log(...a);
const die = (m, c = 1) => { console.error(`FATAL: ${m}`); process.exit(c); };
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows) => rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';

function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: no PlayHQ call, nothing written to the repo.\n');

  if (!fs.existsSync(REG_PATH)) die('data/registrations.json.gz does not exist — walk-registrations has never run.');
  let reg;
  try { reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8')); }
  catch (e) { die(`could not read the registrations file: ${e.message}`); }

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  const yearOf = (c) => Number((String(c).match(/\b(20\d\d)\b/) || [])[1]) || 0;
  const latest = Math.max(...manifest.map(m => yearOf(m.compName)));
  const nextSeasons = manifest.filter(m => yearOf(m.compName) === latest);

  // ⚠️ THE CUTOFF. The earliest stateAt among the next-season entries is when the
  // walk first COULD classify a 2027 registration as tracked. Anyone checked
  // before it was judged against a manifest that had no next season at all.
  const stamps = nextSeasons.map(m => m.stateAt).filter(Boolean).sort();
  const cutoff = stamps.length ? stamps[0] : null;

  log('── what the manifest knows ──');
  log(`  latest season year: ${latest}`);
  for (const m of nextSeasons) {
    log(`    ${pad(m.compName, 34)} ${pad(m.state || '(no state)', 9)} recorded ${m.stateAt || '(no stateAt)'}`);
  }
  if (!cutoff) {
    log('  ⚠️ NO stateAt ON ANY NEXT-SEASON ENTRY, so "checked before the season was');
    log('     known" cannot be identified. Every player below is reported as-is and');
    log('     some may be stale. Re-run discover-seasons and then this.');
  } else {
    log(`  cutoff: a player checked before ${cutoff} could not have been classified`);
    log('          as tracked, however real their registration.');
  }

  const people = reg.players || {};
  const meta = reg.meta || {};
  log(`\n── the registrations file ──`);
  log(`  walkedAt ${meta.walkedAt || '(none)'}  people ${Object.keys(people).length}`);

  // ── Classify ───────────────────────────────────────────────────────────────
  const moved = [], stayed = [], outside = [], none = [], stale = [], unwalked = [];
  const clubName = new Map();   // org id -> the longest name seen for it

  for (const [uuid, r] of Object.entries(people)) {
    const from = r.from || {};
    if (from.club && from.clubName) {
      const prev = clubName.get(from.club);
      if (!prev || from.clubName.length > prev.length) clubName.set(from.club, from.clubName);
    }
    for (const t of (r.tracked || [])) {
      if (t.club && t.clubName) {
        const prev = clubName.get(t.club);
        if (!prev || t.clubName.length > prev.length) clubName.set(t.club, t.clubName);
      }
    }

    if (!r.at) { unwalked.push({ uuid, r }); continue; }
    if (cutoff && r.at < cutoff) { stale.push({ uuid, r }); continue; }

    const tr = r.tracked || [], ot = r.other || [];
    if (tr.length) {
      // ⚠️ BY ID. Several clubs spell their own name more than one way.
      const same = tr.some(t => t.club && from.club && t.club === from.club);
      (same ? stayed : moved).push({ uuid, r, to: tr[0] });
    } else if (ot.length) {
      outside.push({ uuid, r, to: ot[0] });
    } else {
      none.push({ uuid, r });
    }
  }

  const nameOf = (id, fallback) => clubName.get(id) || fallback || '(club unknown)';
  const inClub = (e) => {
    if (!CLUB) return true;
    const f = fold(CLUB), from = e.r.from || {};
    return from.club === CLUB || fold(nameOf(from.club, from.clubName)).includes(f)
      || (e.to && (e.to.club === CLUB || fold(nameOf(e.to.club, e.to.clubName)).includes(f)));
  };
  const movedF = moved.filter(inClub), stayedF = stayed.filter(inClub), outsideF = outside.filter(inClub);

  // ── Report ─────────────────────────────────────────────────────────────────
  log('\n═══ COVERAGE — read this before any number below ═══');
  const walked = moved.length + stayed.length + outside.length + none.length;
  const total = Object.keys(people).length;
  log(`  usable (checked since the ${latest} seasons were known): ${walked} of ${total}`);
  log(`  checked EARLIER, so their next-season status is unknown : ${stale.length}`);
  log(`  never checked at all                                    : ${unwalked.length}`);
  log('  ⚠️ A player in either of those last two rows is NOT "staying" and NOT');
  log('     "no registration" — nothing is known about them yet. They are excluded');
  log('     from every figure below rather than counted as a negative.');

  log(`\n═══ NEXT SEASON, of the ${walked} we can judge ═══`);
  log(`  moved to a different club : ${moved.length}`);
  log(`  same club again           : ${stayed.length}`);
  log(`  a league we do not track  : ${outside.length}`);
  log(`  no registration yet       : ${none.length}`);
  if (CLUB) log(`\n  filtered to "${CLUB}": ${movedF.length} moved, ${stayedF.length} stayed, ${outsideF.length} outside`);

  const byMove = new Map();
  for (const e of moved) {
    const k = `${e.r.from.club}|${e.to.club}`;
    if (!byMove.has(k)) byMove.set(k, { from: e.r.from, to: e.to, n: 0 });
    byMove.get(k).n++;
  }
  if (byMove.size) {
    log('\n── club to club, most common first ──');
    for (const v of [...byMove.values()].sort((a, b) => b.n - a.n).slice(0, LIMIT)) {
      log(`  ${String(v.n).padStart(3)}  ${pad(nameOf(v.from.club, v.from.clubName), 34)} → ${nameOf(v.to.club, v.to.clubName)}`);
    }
  }

  if (movedF.length) {
    log(`\n── who moved ──`);
    for (const e of movedF.slice(0, LIMIT)) {
      log(`  ${pad(e.r.name, 26)} ${pad(nameOf(e.r.from.club, e.r.from.clubName), 30)} → ` +
        `${pad(nameOf(e.to.club, e.to.clubName), 30)} ${e.to.compName}`);
    }
    if (movedF.length > LIMIT) log(`  …and ${movedF.length - LIMIT} more, all in the CSV`);
  }

  if (outsideF.length) {
    log(`\n── gone to a league we do not track ──`);
    for (const e of outsideF.slice(0, LIMIT)) {
      log(`  ${pad(e.r.name, 26)} ${pad(nameOf(e.r.from.club, e.r.from.clubName), 30)} → ${e.to.league || '(league?)'} ${e.to.season || ''}`);
    }
    if (outsideF.length > LIMIT) log(`  …and ${outsideF.length - LIMIT} more, all in the CSV`);
  }

  // ── CSV ────────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [['status', 'player', 'uuid', 'checked_at', 'from_season', 'from_club',
    'to_season', 'to_club', 'to_league', 'team_name_if_any']];
  const push = (status, e, to) => rows.push([status, e.r.name, e.uuid, e.r.at || '',
    (e.r.from || {}).compName || '', nameOf((e.r.from || {}).club, (e.r.from || {}).clubName),
    to ? (to.compName || to.season || '') : '', to ? nameOf(to.club, to.clubName) : '',
    to ? (to.league || '') : '', to ? (to.team || '') : '']);
  for (const e of moved) push('moved', e, e.to);
  for (const e of stayed) push('stayed', e, e.to);
  for (const e of outside) push('outside league', e, e.to);
  for (const e of none) push('no registration yet', e, null);
  for (const e of stale) push('checked before the season was known', e, null);
  fs.writeFileSync(path.join(OUT_DIR, 'transfers.csv'), csv(rows));

  const rel = path.relative(ROOT, OUT_DIR);
  log(`\n  Written: ${rel}/transfers.csv  ${rows.length - 1} row(s)`);
  log("  (not committed — download it from the run's artifact)");

  if (stale.length || unwalked.length) {
    log(`\n⚠️ ${stale.length + unwalked.length} player(s) cannot be judged yet. The walk covers`);
    log('   about 5,770 a day; re-run this once "still due" reaches zero for a');
    log('   complete picture. Until then a club\'s outward transfers are a FLOOR.');
  }
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
