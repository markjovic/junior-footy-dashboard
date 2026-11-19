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

const VERSION = 'report-transfers v4 2026-11-18 show-the-durations';

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const OUT_DIR = path.join(ROOT, process.env.RT_OUT || 'reports');
const CLUB = (process.env.RT_CLUB || '').trim();
const LIMIT = Math.max(1, Number(process.env.RT_LIMIT || 40));

const log = (...a) => console.log(...a);
const die = (m, c = 1) => { console.error(`FATAL: ${m}`); process.exit(c); };
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
// ⚠️ SPLIT, DO NOT GUESS. "EFNL 2027" is a competition and a year glued together
// by this repo's own naming, so the year is the trailing 20NN and the competition
// is whatever precedes it. A season with no year in its name keeps the whole
// string as the competition and leaves the year blank rather than inventing one.
const splitSeason = (s) => {
  const str = String(s || '').trim();
  const m = str.match(/^(.*?)\s*\b(20\d\d)\b\s*$/);
  return m ? { comp: m[1].trim(), year: m[2] } : { comp: str, year: '' };
};

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

  // ⚠️ THE PREVIOUS TEAM IS NOT IN THE REGISTRATIONS FILE. `from` carries the
  // season and the club and nothing else, so age has to come from the stored
  // player record for that season — which is where `age` and `teamRaw` live.
  // Five files, read one at a time and released.
  const prev = new Map();   // uuid -> { age, team }
  const cohortIds = new Set((reg.meta || {}).cohortSeasons || []);
  const byId = new Map(manifest.map(m => [m.seasonId, m]));
  for (const sid of cohortIds) {
    const m = byId.get(sid);
    if (!m) continue;
    let data;
    try { data = store.load([m.compName], { players: true }); }
    catch (e) { console.error(`  ⚠️ ${m.compName}: ${e.message}`); continue; }
    for (const p of (data.players || [])) {
      if (!p || !p.uuid) continue;
      // Keep the first non-empty age seen; a player with two grades in a season
      // has two records and either age is as true as the other.
      if (!prev.has(p.uuid)) prev.set(p.uuid, { age: p.age || '', team: p.teamRaw || p.team || '' });
    }
  }
  log(`  previous-season records loaded for ${prev.size} player(s)`);

  const people = reg.players || {};
  const meta = reg.meta || {};
  log(`\n── the registrations file ──`);
  log(`  walkedAt ${meta.walkedAt || '(none)'}  people ${Object.keys(people).length}`);

  // ── Classify ───────────────────────────────────────────────────────────────
  // ⚠️ A CARNIVAL IS NOT A TRANSFER. v2 counted 227 players as "gone to a league
  // we do not track", and about 160 of those were AFL Nines Spring, Herald Sun
  // Shield or a VACSAL carnival — a weekend or a few weeks, played ALONGSIDE a
  // normal season, not instead of it. registrations_design.md already draws this
  // line at 60 days for the dashboard; the report now draws it too.
  //
  // A registration with no dates cannot be measured and goes to `undated` rather
  // than being guessed into either bucket.
  const MIN_SEASON_DAYS = Number(process.env.RT_MIN_DAYS || 60);
  const DAY = 86400000;
  const lengthOf = (o) => {
    if (!o || !o.startDate || !o.endDate) return null;
    const a = Date.parse(o.startDate), b = Date.parse(o.endDate);
    return (isNaN(a) || isNaN(b)) ? null : Math.round((b - a) / DAY);
  };

  const moved = [], stayed = [], outside = [], shortEvent = [], undated = [], none = [], stale = [], unwalked = [];
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
      // The longest registration decides: a child doing Nines AND a real season
      // elsewhere has left, and the real season is the one that says so.
      const withLen = ot.map(o => ({ o, days: lengthOf(o) }));
      const longest = withLen.filter(x => x.days !== null).sort((a, b) => b.days - a.days)[0];
      if (!longest) undated.push({ uuid, r, to: ot[0] });
      else if (longest.days >= MIN_SEASON_DAYS) outside.push({ uuid, r, to: longest.o, days: longest.days });
      else shortEvent.push({ uuid, r, to: longest.o, days: longest.days });
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
  const walked = moved.length + stayed.length + outside.length + shortEvent.length +
    undated.length + none.length;
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
  log(`  a real season elsewhere   : ${outside.length}   (${MIN_SEASON_DAYS}+ days — a genuine departure)`);
  log(`  a short event only        : ${shortEvent.length}   (AFL Nines, carnivals — NOT a departure)`);
  log(`  undated registration      : ${undated.length}   (cannot be measured either way)`);
  log(`  no registration yet       : ${none.length}`);
  log(`  ⚠️ A SHORT EVENT IS NOT A TRANSFER. Nines and carnivals run alongside a`);
  log('     normal season, so those players have not left anybody.');
  if (CLUB) log(`\n  filtered to "${CLUB}": ${movedF.length} moved, ${stayedF.length} stayed, ${outsideF.length} outside`);

  // ⚠️ MEASURE THE THRESHOLD, DO NOT DEFEND IT. 60 days is a proxy for "a season
  // rather than an event", and a spring tournament running October to December
  // beats it. This prints every outside competition with its length so the rule
  // can be judged against the data instead of assumed to work.
  const byLeague = new Map();
  for (const e of [...outside, ...shortEvent, ...undated]) {
    const k = e.to.league || '(league?)';
    if (!byLeague.has(k)) byLeague.set(k, { n: 0, days: e.days === undefined ? null : e.days,
      start: e.to.startDate || '', end: e.to.endDate || '' });
    byLeague.get(k).n++;
  }
  if (byLeague.size) {
    log('\n── every outside competition, by length ──');
    log('   Judge the 60-day line here. A long tournament that is NOT a move, or a');
    log('   short season that IS one, means the rule needs changing — tell me which.');
    for (const [k, v] of [...byLeague.entries()].sort((a, b) => b[1].n - a[1].n)) {
      const verdict = v.days === null ? 'no dates'
        : v.days >= MIN_SEASON_DAYS ? 'counted as a DEPARTURE' : 'counted as an event';
      log(`  ${String(v.n).padStart(4)}  ${pad(k, 52)} ${
        v.days === null ? '    ?' : String(v.days).padStart(4) + 'd'}  ${
        pad(v.start, 11)}${pad(v.end, 11)} ${verdict}`);
    }
  }

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
      const was = prev.get(e.uuid) || {};
      const toName = (e.to.seasonId && (byId.get(e.to.seasonId) || {}).compName) || e.to.compName || '';
      log(`  ${pad(e.r.name, 26)} ${pad(was.age || '?', 5)} ${pad(nameOf(e.r.from.club, e.r.from.clubName), 30)} → ` +
        `${pad(nameOf(e.to.club, e.to.clubName), 30)} ${toName}`);
    }
    if (movedF.length > LIMIT) log(`  …and ${movedF.length - LIMIT} more, all in the CSV`);
  }

  if (outsideF.length) {
    log(`\n── gone to a league we do not track ──`);
    for (const e of outsideF.slice(0, LIMIT)) {
      log(`  ${pad(e.r.name, 26)} ${pad(nameOf(e.r.from.club, e.r.from.clubName), 30)} → ` +
        `${pad(e.to.league || '(league?)', 44)} ${e.to.season || ''} (${e.days} days)`);
    }
    if (outsideF.length > LIMIT) log(`  …and ${outsideF.length - LIMIT} more, all in the CSV`);
  }

  // ── CSV ────────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [['status', 'player', 'uuid', 'checked_at',
    'from_comp', 'from_year', 'from_age', 'from_team', 'from_club',
    'to_comp', 'to_year', 'to_club', 'to_league', 'to_team',
    'to_start', 'to_end', 'to_days']];
  const push = (status, e, to) => {
    const from = e.r.from || {};
    const f = splitSeason(from.compName);
    const was = prev.get(e.uuid) || {};
    // ⚠️ RESOLVE THE DESTINATION THROUGH THE MANIFEST FIRST. 8 of 30 moved rows
    // and every "stayed" row came out with a blank season in v1, because the
    // stored compName on a tracked entry is not always set. The seasonId always
    // is, and the manifest knows its name.
    const toName = to
      ? ((to.seasonId && (byId.get(to.seasonId) || {}).compName) || to.compName || to.season || '')
      : '';
    const t = splitSeason(toName);
    rows.push([status, e.r.name, e.uuid, e.r.at || '',
      f.comp, f.year, was.age || '', was.team || '', nameOf(from.club, from.clubName),
      t.comp, t.year, to ? nameOf(to.club, to.clubName) : '',
      to ? (to.league || '') : '', to ? (to.team || '') : '',
      // ⚠️ THE DATES, SO THE 60-DAY RULE CAN BE JUDGED RATHER THAN TRUSTED. It is
      // a proxy for "season or event" and a long spring tournament defeats it.
      to ? (to.startDate || '') : '', to ? (to.endDate || '') : '',
      to && lengthOf(to) !== null ? lengthOf(to) : '']);
  };
  for (const e of moved) push('moved', e, e.to);
  for (const e of stayed) push('stayed', e, e.to);
  for (const e of outside) push('real season elsewhere', e, e.to);
  for (const e of shortEvent) push('short event only', e, e.to);
  for (const e of undated) push('undated registration', e, e.to);
  for (const e of none) push('no registration yet', e, null);
  for (const e of stale) push('checked before the season was known', e, null);
  fs.writeFileSync(path.join(OUT_DIR, 'transfers.csv'), csv(rows));

// ── By competition, then team ──────────────────────────────────────────────
  // ⚠️ GROUPED ON THE SEASON JUST GONE, not on where they are heading. A team is
  // a thing that existed; next season's teams do not yet. So every row is "of the
  // players who were in this team, what do we know now" — which is the question a
  // club actually has.
  const teamRows = new Map();
  const bump = (e, key) => {
    const from = e.r.from || {};
    const was = prev.get(e.uuid) || {};
    const f = splitSeason(from.compName);
    const k = `${f.comp}|${was.team || '(team unknown)'}|${was.age || ''}`;
    if (!teamRows.has(k)) {
      teamRows.set(k, { comp: f.comp, year: f.year, team: was.team || '(team unknown)',
        age: was.age || '', club: nameOf(from.club, from.clubName),
        moved: 0, stayed: 0, left: 0, event: 0, undated: 0, none: 0, notYet: 0 });
    }
    teamRows.get(k)[key]++;
  };
  for (const e of moved) bump(e, 'moved');
  for (const e of stayed) bump(e, 'stayed');
  for (const e of outside) bump(e, 'left');
  for (const e of shortEvent) bump(e, 'event');
  for (const e of undated) bump(e, 'undated');
  for (const e of none) bump(e, 'none');
  for (const e of stale) bump(e, 'notYet');
  for (const e of unwalked) bump(e, 'notYet');

  const teamList = [...teamRows.values()]
    .map(t => ({ ...t, judged: t.moved + t.stayed + t.left + t.event + t.undated + t.none }))
    .filter(t => !CLUB || fold(t.club).includes(fold(CLUB)) || fold(t.team).includes(fold(CLUB)));

  log(`\n═══ BY COMPETITION AND TEAM (${teamList.length} team(s)) ═══`);
  log('  "not yet" are players the walk has not reached, or reached before the next');
  log('  season existed. They are not a result — they are an unanswered question.');
  log(`\n  ${pad('comp', 6)} ${pad('team', 34)} ${pad('age', 6)} ` +
    `${'moved'.padStart(6)} ${'stayed'.padStart(7)} ${'left'.padStart(5)} ` +
    `${'event'.padStart(6)} ${'none'.padStart(5)} ${'notyet'.padStart(7)}`);
  const shown = teamList
    .sort((a, b) => b.moved - a.moved || b.judged - a.judged ||
      String(a.comp).localeCompare(String(b.comp)) || String(a.team).localeCompare(String(b.team)))
    .slice(0, LIMIT);
  for (const t of shown) {
    log(`  ${pad(t.comp, 6)} ${pad(t.team, 34)} ${pad(t.age, 6)} ` +
      `${String(t.moved).padStart(6)} ${String(t.stayed).padStart(7)} ${String(t.left).padStart(5)} ` +
      `${String(t.event).padStart(6)} ${String(t.none).padStart(5)} ${String(t.notYet).padStart(7)}`);
  }
  if (teamList.length > shown.length) {
    log(`  …and ${teamList.length - shown.length} more team(s), all of them in by-team.csv`);
  }

  const teamCsv = [['comp', 'year', 'club', 'team', 'age', 'players_judged',
    'moved', 'stayed', 'real_season_elsewhere', 'short_event_only', 'undated',
    'no_registration_yet', 'not_yet_checked']];
  for (const t of teamList.sort((a, b) =>
    String(a.comp).localeCompare(String(b.comp)) || String(a.team).localeCompare(String(b.team)))) {
    teamCsv.push([t.comp, t.year, t.club, t.team, t.age, t.judged,
      t.moved, t.stayed, t.left, t.event, t.undated, t.none, t.notYet]);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'by-team.csv'), csv(teamCsv));

  const rel = path.relative(ROOT, OUT_DIR);
  log(`\n  Written: ${pad(`${rel}/transfers.csv`, 30)} ${String(rows.length - 1).padStart(6)} row(s)`);
  log(`           ${pad(`${rel}/by-team.csv`, 30)} ${String(teamCsv.length - 1).padStart(6)} row(s)`);
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
