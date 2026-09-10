#!/usr/bin/env node
// scripts/probe-career-stats.js
//
// READ-ONLY. Writes no file, commits nothing, touches no season file.
//
// v2 REBASES THE PROBE ON index.html's PLAYER_PROFILE_QUERY. v1 used
// fetch-stats.js's Q_PROFILE_STATS, which stops at season totals. Reading
// index.html (Beta 0.219, lines 4881-4911) settled that gameStatistics is NOT a
// second route: it is nested inside publicProfileStatistics, four levels down,
// and takes no arguments —
//
//   publicProfileStatistics(profileID)
//     seasonStatistics[]                    the season, labelled
//       statistics[]                        one per club registration
//         season { id name }  club { id name }  totalStatistics
//         teamStatistics[]                  one per team
//           gradeStatistics[]               one per grade — carries grade { id name }
//             gameStatistics[]              ONE ROW PER GAME
//               game { id round date home away }   statistics
//
// So ONE call per person returns the whole career AND every per-game line
// behind it, for every season the person ever played — including seasons this
// project does not store. That is what makes Mark's 2026-09-10 proposal work,
// and it is why this probe now measures the game lines as well as the totals.
//
// ⚠️ THE PANEL SENDS THIS QUERY THROUGH A CLOUDFLARE WORKER; THIS SENDS IT
// DIRECT. The text is production-proven either way — validation happens at
// PlayHQ — but I am INFERRING the direct endpoint validates it identically.
// fetch-stats.js's subset already runs direct, so only the three deeper levels
// are unproven on this transport. If the base walk fails wholesale on a
// validation error, that is itself the answer.
//
// WHAT IS MEASURED (career_stats_design.md §2 and §8, plus the game lines):
//   1. the form of seasonStatistics[].name AND of statistics[].season.name —
//      two different fields. index.html matches S.selYear against the first, so
//      for OUR seasons it is a bare year; nothing proves what an outside league
//      uses.
//   2. whether seasons from other sports appear on the afl tenant
//   3. whether club.name carries the league suffix
//   4. which statistic values come back — per season, per grade, and per GAME
//   5. the game lines: how many, for held and NOT-held seasons separately,
//      whether they carry game.id, and what a round name looks like outside
//      our leagues
//
// THE WAF BUDGET IS NOT MEASURED BY DEFAULT. Deferred by Mark 2026-09-10. The
// walk paces at 100 calls per 80 s, the figure walk-registrations.js has never
// tripped. PROBE_BURST=true fires a bounded unpaced burst when asked.
//
// ⚠️ THE BURST MEASURES THE COUNT, NOT THE RECOVERY. registrations_design.md §8
// warned lib/playhq.js's retry path might absorb a block and hide it: it does —
// gqlPost waits a flat 80 s and retries — but it increments counters.blocked,
// so the block is visible through summary() without writing a second transport.
// Recovery was measured at 76-77 s on 2026-09-05 and is not re-measured.
//
// EVERY EXTRA FIELD IS A SEPARATE TRIAL ON ITS OWN CALL. A rejected field fails
// the WHOLE query (measured 2026-08-16) — which is also why `result { home
// { score } }` is NOT retried here. That one is settled.
//
// COHORT SOURCE: data/registrations.json.gz, the walker's own file — one object
// per profile id carrying name and from.compName, which is a cohort already
// spread across the five competitions, for one 1.4 MB gunzip. lib/store.js is
// deliberately not used: store.load would parse a whole 20 MB players file to
// pick twenty uuids out of it.
//
// Env: PROBE_PER_COMP (4), PROBE_EXTRA_IDS (csv), PROBE_RAW (2),
//      PROBE_BURST (false), PROBE_BURST_CALLS (250),
//      PROBE_RATE (100) / PROBE_WINDOW_MS (80000).
//
// Exit codes: 0 = the probe ran (whatever it found). 1 = it could not start —
// no cohort file — or threw. A lost session is NOT exit 1: lib/playhq.js warns
// and proceeds, so it shows as every player failing, which is what the
// per-player lines and the ok/blocked counters are for.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const playhq = require('./lib/playhq');
const { gqlPost, sleep } = playhq;

const VERSION = 'probe-career-stats v2 2026-09-10 game-lines';

const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'data', 'core.json');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const REG_LEGACY = path.join(ROOT, 'data', 'registrations.json');

const PER_COMP = Math.max(1, Number(process.env.PROBE_PER_COMP || 4));
const RAW_LIMIT = Math.max(0, Number(process.env.PROBE_RAW || 2));
const RATE = Math.max(1, Number(process.env.PROBE_RATE || 100));
const WINDOW_MS = Math.max(1, Number(process.env.PROBE_WINDOW_MS || 80000));
const BURST = String(process.env.PROBE_BURST || 'false') === 'true';
const BURST_CALLS = Math.max(1, Number(process.env.PROBE_BURST_CALLS || 250));

const log = (...a) => console.log(...a);

// ── The base query — index.html PLAYER_PROFILE_QUERY, copied verbatim ────────
const Q_BASE = `
query publicProfileStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name
      statistics {
        season { id name }
        club { id name }
        totalStatistics { count details { value } }
        teamStatistics {
          team { ... on DiscoverTeam { id name } }
          gradeStatistics {
            grade { id name }
            totalStatistics { count details { value } }
            gameStatistics {
              game {
                id
                round { name }
                date
                home { ... on DiscoverTeam { id name } }
                away { ... on DiscoverTeam { id name } }
              }
              statistics { count details { value } }
            }
          }
        }
      }
    }
  }
  publicProfile(profileID: $profileID) { id firstName lastName }
}`;

// ── Trials — each is the base query with ONE substitution, run alone ─────────
// `find` must occur exactly once; the loop refuses an ambiguous anchor rather
// than silently probing the wrong place.
function trials(sampleSeasonId) {
  return [
    {
      id: 'T1 season detail',
      why: 'The selection walk-registrations.js proves on DiscoverTeam.season. I am ' +
           'INFERRING publicProfileStatistics hangs the same type. THIS IS THE CRITICAL ' +
           'ONE: if the block label is a bare year, an outside season\'s LEAGUE has ' +
           'nowhere else to come from — club.name\'s bracket is the club\'s home ' +
           'association, not the competition it played in (API reference §10).',
      find: '        season { id name }\n',
      with: '        season { id name startDate endDate status { value } competition { id name } }\n',
    },
    {
      id: 'T2 season sport',
      why: 'GUESS. Settles measurement 2 outright instead of by reading names.',
      find: '        season { id name }\n',
      with: '        season { id name sport { name } }\n',
    },
    {
      id: 'T3 season organisation',
      why: 'GUESS. A league organisation id would join an outside season to something ' +
           'stable rather than to a parsed name.',
      find: '        season { id name }\n',
      with: '        season { id name organisation { id name } }\n',
    },
    {
      id: 'T4 statistic label on a GAME line',
      why: 'GUESS. If details carries a human label as well as the enum, a box score can ' +
           'print PlayHQ\'s own wording for a statistic we have never seen before.',
      find: '              statistics { count details { value } }\n',
      with: '              statistics { count details { value name } }\n',
    },
    {
      id: 'T5 career totals',
      why: 'GUESS, and the one that decides the header strip. PlayHQ\'s page shows a career ' +
           'total (398 games, 630 goals). If a field serves it, the file stores it instead ' +
           'of summing, and the strip cannot drift from PlayHQ.',
      find: '    seasonStatistics {\n',
      with: '    careerStatistics { count details { value } }\n    seasonStatistics {\n',
    },
    {
      id: 'T6 season-scoped argument',
      why: 'GUESS, and it decides the refresh cadence. index.html fetches the whole career ' +
           'and filters client-side, which is NOT evidence the argument is absent — it may ' +
           'simply never have been tried. If publicProfileStatistics takes a seasonID, an ' +
           'in-season re-check asks for one season instead of a career, and the weekly ' +
           're-walk is far cheaper than either design assumes.',
      find: 'query publicProfileStatistics($profileID: ID!) {\n  publicProfileStatistics(profileID: $profileID) {\n',
      with: 'query publicProfileStatistics($profileID: ID!, $seasonID: ID!) {\n  publicProfileStatistics(profileID: $profileID, seasonID: $seasonID) {\n',
      vars: sampleSeasonId ? { seasonID: sampleSeasonId } : null,
      needs: 'a season id from the manifest',
    },
  ];
}

// ── Token bucket — the shape walk-registrations.js has never tripped ─────────
const callTimes = [];
async function pace() {
  const now = Date.now();
  while (callTimes.length && now - callTimes[0] >= WINDOW_MS) callTimes.shift();
  if (callTimes.length >= RATE) {
    const wait = WINDOW_MS - (now - callTimes[0]) + 5;
    await sleep(wait);
    return pace();
  }
  callTimes.push(Date.now());
}

// ── Cohort ──────────────────────────────────────────────────────────────────
function readCohort() {
  let raw = null;
  if (fs.existsSync(REG_PATH)) raw = zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8');
  else if (fs.existsSync(REG_LEGACY)) raw = fs.readFileSync(REG_LEGACY, 'utf8');
  if (raw === null) return null;
  const r = JSON.parse(raw);
  return r && r.players ? r : null;
}

// Deterministic: walked players first (their record is known real), then uuid
// order, so two runs on the same file pick the same people.
function select(cohort, perComp, extraIds) {
  const byComp = new Map();
  for (const [uuid, rec] of Object.entries(cohort.players)) {
    const comp = rec.from && rec.from.compName ? rec.from.compName : '(no competition)';
    if (!byComp.has(comp)) byComp.set(comp, []);
    byComp.get(comp).push({ uuid, name: rec.name || null, comp, walked: !!rec.at });
  }
  const picked = [];
  const seen = new Set();
  for (const id of extraIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = [...byComp.values()].flat().find(p => p.uuid === id);
    picked.push(known || { uuid: id, name: null, comp: '(supplied)', walked: false });
  }
  for (const comp of [...byComp.keys()].sort()) {
    const list = byComp.get(comp).sort((a, b) =>
      (a.walked === b.walked ? 0 : a.walked ? -1 : 1) || (a.uuid < b.uuid ? -1 : 1));
    for (const p of list) {
      if (picked.filter(x => x.comp === comp).length >= perComp) break;
      if (seen.has(p.uuid)) continue;
      seen.add(p.uuid);
      picked.push(p);
    }
  }
  return picked;
}

// ── One call ────────────────────────────────────────────────────────────────
// A 403 on this operation is DATA, not an expired session — lib/playhq.js holds
// publicProfileStatistics in AUTH_403_IS_DATA and throws rather than refreshing.
// Caught per player so one private profile cannot end the run.
async function askProfile(uuid, query, extraVars) {
  const vars = Object.assign({ profileID: uuid }, extraVars || {});
  let json;
  try {
    json = await gqlPost(query || Q_BASE, vars, 'publicProfileStatistics');
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    return { ok: false, reason: /403 not accessible/.test(msg) ? 'private (403)' : msg, json: null };
  }
  if (json && json.errors && json.errors.length) {
    return { ok: false, reason: String(json.errors[0].message || 'error').slice(0, 240), json };
  }
  const block = json && json.data ? json.data.publicProfileStatistics : null;
  return {
    ok: true,
    json,
    seasons: (block && block.seasonStatistics) || [],
    career: block ? block.careerStatistics : undefined,
    profile: (json && json.data && json.data.publicProfile) || null,
  };
}

const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const tallyLine = (m, indent) => [...m.entries()].sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${indent}${String(k).padEnd(28)} ${n}`).join('\n');

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log(`=== ${VERSION} ===`);
  log(`pace: ${RATE} calls / ${WINDOW_MS / 1000}s${BURST ? `  BURST ENABLED (${BURST_CALLS} calls, unpaced)` : ''}`);

  let manifest = [];
  try {
    manifest = JSON.parse(fs.readFileSync(CORE_PATH, 'utf8')).manifest || [];
  } catch (e) {
    log(`⚠️ could not read data/core.json (${e.message}) — every season will read as NOT held`);
  }
  const heldIds = new Set(manifest.filter(m => m.seasonId).map(m => m.seasonId));
  const compOf = new Map(manifest.filter(m => m.seasonId).map(m => [m.seasonId, m.compName || null]));
  // For T6: any real season id, so the argument has a genuine value to reject or accept.
  const sampleSeason = (manifest.find(m => m.seasonId && m.compName && m.state === 'active')
    || manifest.find(m => m.seasonId && m.compName) || {}).seasonId || null;
  log(`manifest: ${manifest.length} entries, ${heldIds.size} season id(s) this project holds`);

  const cohort = readCohort();
  if (!cohort) {
    console.error('FATAL: data/registrations.json.gz is not present or has no players.');
    console.error('It is the cohort source. Either dispatch Walk registrations first,');
    console.error('or pass profile ids directly with extra_profile_ids.');
    process.exit(1);
  }
  const extraIds = String(process.env.PROBE_EXTRA_IDS || '')
    .split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const people = Object.keys(cohort.players).length;
  const walkedN = Object.values(cohort.players).filter(r => r.at).length;
  log(`cohort file: ${people} people, ${walkedN} walked at least once (version ${cohort.meta && cohort.meta.version})`);

  const picked = select(cohort, PER_COMP, extraIds);
  log(`\nselected ${picked.length} player(s): up to ${PER_COMP} per competition` +
      (extraIds.length ? `, including ${extraIds.length} supplied id(s) — a supplied id already in the cohort counts inside its own competition's quota` : ''));
  for (const p of picked) log(`  ${p.uuid}  ${(p.name || '(name unknown)').padEnd(24)} ${p.comp}`);

  // ── The walk ──────────────────────────────────────────────────────────────
  log('\n── per player ──');
  let calls = 0, answered = 0, failed = 0;
  let burstFired = 0;
  const failures = [];
  const regs = [];          // one per club registration
  const games = [];         // one per game line
  const perPlayer = [];
  const raws = [];

  for (const p of picked) {
    await pace();
    calls++;
    const r = await askProfile(p.uuid);
    if (!r.ok) {
      failed++;
      failures.push(`${p.uuid} (${p.comp}): ${r.reason}`);
      log(`  ${p.uuid} ${(p.name || '').padEnd(20)} FAILED — ${r.reason}`);
      continue;
    }
    answered++;

    let nRegs = 0, nGames = 0, heldG = 0, outG = 0;
    for (const block of r.seasons) {
      for (const reg of (block.statistics || [])) {
        nRegs++;
        const sid = reg.season ? reg.season.id : null;
        const isHeld = !!(sid && heldIds.has(sid));
        const rec = {
          uuid: p.uuid,
          blockName: block.name || null,
          seasonName: reg.season ? reg.season.name : null,
          seasonId: sid,
          held: isHeld,
          heldComp: isHeld ? compOf.get(sid) : null,
          club: reg.club ? reg.club.name : null,
          totals: reg.totalStatistics || [],
          teams: reg.teamStatistics || [],
          grades: [],
          games: 0,
        };
        for (const t of (reg.teamStatistics || [])) {
          for (const gs of (t.gradeStatistics || [])) {
            rec.grades.push(gs.grade ? gs.grade.name : null);
            for (const line of (gs.gameStatistics || [])) {
              nGames++; rec.games++;
              if (isHeld) heldG++; else outG++;
              games.push({
                uuid: p.uuid, held: isHeld, seasonId: sid,
                gradeName: gs.grade ? gs.grade.name : null,
                gameId: line.game ? line.game.id : null,
                round: line.game && line.game.round ? line.game.round.name : null,
                date: line.game ? line.game.date : null,
                home: line.game && line.game.home ? line.game.home.name : null,
                away: line.game && line.game.away ? line.game.away.name : null,
                stats: line.statistics || [],
                raw: line,
              });
            }
          }
        }
        regs.push(rec);
      }
    }
    if (raws.length < RAW_LIMIT && r.seasons.length) raws.push({ p, block: r.seasons[0] });
    perPlayer.push({ uuid: p.uuid, name: p.name, comp: p.comp, blocks: r.seasons.length,
                     regs: nRegs, games: nGames, heldGames: heldG, outGames: outG });
    log(`  ${p.uuid} ${(p.name || '').padEnd(20)} ${String(r.seasons.length).padStart(2)} season block(s), ` +
        `${nRegs} registration(s), ${nGames} game line(s) — ${heldG} in seasons we hold, ${outG} not`);
  }

  if (failures.length) {
    log(`\n${failures.length} player(s) did not answer:`);
    for (const f of failures.slice(0, 10)) log('  ' + f);
  }

  // ── Raw ───────────────────────────────────────────────────────────────────
  // ONE SEASON BLOCK, not the whole answer: a 398-game career serialises to
  // something nobody can paste back. A block still shows every level of nesting
  // with real values, which is what a shape question needs.
  if (raws.length) {
    log(`\n── RAW: the first season block of the first ${raws.length} answer(s) ──`);
    for (const { p, block } of raws) {
      log(`\n--- ${p.uuid} ${p.name || ''} (${p.comp}) ---`);
      log(JSON.stringify(block));
    }
  }
  const outLine = games.find(g => !g.held);
  const heldLine = games.find(g => g.held);
  log('\n── RAW: one game line from a season we HOLD ──');
  log(heldLine ? JSON.stringify(heldLine.raw) : '  (none returned)');
  log('── RAW: one game line from a season we DO NOT hold ──');
  log(outLine ? JSON.stringify(outLine.raw) : '  (none returned — see point 5)');

  // ── ANSWERS ───────────────────────────────────────────────────────────────
  log('\n═══ ANSWERS ═══');

  const blockNames = [...new Set(regs.map(r => r.blockName).filter(Boolean))].sort();
  const seasonNames = [...new Set(regs.map(r => r.seasonName).filter(Boolean))].sort();
  // Buckets describe the SHAPE, not a meaning. An earlier wording called the
  // second one "League YYYY" and then counted "October 2026" into it, which is a
  // month and a year — the label was asserting an interpretation the regex does
  // not test. Buckets are exclusive and first-match-wins; every value is printed
  // below them regardless, so the classification cannot hide anything.
  const patterns = [
    ['ends ", YYYY"', /^.+,\s*\d{4}$/],
    ['ends " YYYY"', /^.+\s\d{4}$/],
    ['bare YYYY', /^\d{4}$/],
  ];
  const classify = (labels, label) => {
    log(`\n   ${label} — ${labels.length} distinct value(s)`);
    const counted = new Set();
    for (const [nm, re] of patterns) {
      const hits = labels.filter(l => !counted.has(l) && re.test(l));
      hits.forEach(l => counted.add(l));
      log(`     ${nm}: ${hits.length}`);
    }
    const none = labels.filter(l => !counted.has(l));
    log(`     matching none of those: ${none.length}`);
    for (const l of none.slice(0, 10)) log(`       NO PATTERN: ${JSON.stringify(l)}`);
    log('     every distinct value:');
    for (const l of labels.slice(0, 40)) log(`       ${JSON.stringify(l)}`);
    if (labels.length > 40) log(`       … and ${labels.length - 40} more`);
  };
  log('\n1. the two name fields — they are NOT the same field');
  log('   index.html matches S.selYear against seasonStatistics[].name, so for OUR');
  log('   seasons that label is a bare year. Nothing proves what an outside league uses.');
  classify(blockNames, 'seasonStatistics[].name  (the block label)');
  classify(seasonNames, "statistics[].season.name (the season's own name)");
  const disagree = regs.filter(r => r.blockName && r.seasonName && r.blockName !== r.seasonName);
  log(`\n   registrations where the two DISAGREE: ${disagree.length} of ${regs.length}`);
  for (const r of disagree.slice(0, 8)) log(`     block ${JSON.stringify(r.blockName)} vs season ${JSON.stringify(r.seasonName)}`);

  // ⚠️ Test with the AFL compound removed first. "Western Football Netball
  // League" is an AFL league, and a bare /netball/ test flagged five of six
  // fixture labels — an answer produced entirely by the test.
  const SPORT = /netball|basketball|cricket|hockey|softball|baseball|touch\b|volleyball|soccer|futsal|rugby|lacrosse|tennis/i;
  const deAfl = (l) => String(l).replace(/football\s+(and\s+)?netball/gi, 'football');
  const sportHits = [...new Set([...blockNames, ...seasonNames])].filter(l => SPORT.test(deAfl(l)));
  log(`\n2. seasons from other sports on the afl tenant`);
  log(`   name values matching a non-AFL sport word: ${sportHits.length}`);
  for (const l of sportHits.slice(0, 20)) log(`     ${JSON.stringify(l)}`);
  log('   ⚠️ INFERRED from wording only. T2 settles it if accepted.');

  const clubs = [...new Set(regs.map(r => r.club).filter(Boolean))].sort();
  const suffixed = clubs.filter(c => /\([^)]+\)\s*$/.test(c));
  const suffixes = [...new Set(suffixed.map(c => (/\(([^)]+)\)\s*$/.exec(c) || [])[1]))].sort();
  log(`\n3. club.name — ${clubs.length} distinct club(s)`);
  log(`   carrying a trailing "(...)" suffix: ${suffixed.length} of ${clubs.length}`);
  for (const s of suffixes.slice(0, 25)) log(`     (${s})`);
  const bare = clubs.filter(c => !/\([^)]+\)\s*$/.test(c));
  log(`   clubs with NO suffix: ${bare.length}`);
  for (const c of bare.slice(0, 15)) log(`     ${JSON.stringify(c)}`);
  log(`   registrations with no club at all: ${regs.filter(r => !r.club).length}`);

  const tally = (arrs) => {
    const m = new Map();
    for (const a of arrs) for (const s of (a || [])) bump(m, (s.details && s.details.value) || '(no details.value)');
    return m;
  };
  const tSeason = tally(regs.map(r => r.totals));
  const tGrade = tally(regs.flatMap(r => (r.teams || []).flatMap(t => (t.gradeStatistics || []).map(g => g.totalStatistics))));
  const tGame = tally(games.map(g => g.stats));
  log(`\n4. statistic values returned, at each level`);
  log('   per season registration (totalStatistics):');
  log(tallyLine(tSeason, '     ') || '     (none)');
  log('   per grade (gradeStatistics.totalStatistics):');
  log(tallyLine(tGrade, '     ') || '     (none)');
  log('   PER GAME (gameStatistics.statistics):');
  log(tallyLine(tGame, '     ') || '     (none)');
  const KNOWN = new Set(['APPEARANCE', 'GOAL_COUNT', 'BEST_PLAYER']);
  const novel = [...new Set([...tSeason.keys(), ...tGrade.keys(), ...tGame.keys()])].filter(v => !KNOWN.has(v));
  log(`   NOT among APPEARANCE / GOAL_COUNT / BEST_PLAYER: ${novel.length ? novel.join(', ') : 'none'}`);
  log('   ⚠️ BEHINDS is what a box score needs and per_game_stats_design.md §5 leaves optional.');
  log('      If it is absent above, the box score is goals and votes — which §7 already allows.');

  log(`\n5. game lines`);
  log(`   total: ${games.length} across ${answered} player(s)`);
  const heldGames = games.filter(g => g.held).length;
  log(`   in seasons this project HOLDS:     ${heldGames}`);
  log(`   in seasons this project does NOT:  ${games.length - heldGames}   <- the history no game-side route can reach`);
  log(`   carrying a game.id:                ${games.filter(g => g.gameId).length} of ${games.length}`);
  log(`   carrying a date:                   ${games.filter(g => g.date).length}`);
  log(`   carrying both team names:          ${games.filter(g => g.home && g.away).length}`);
  log(`   NOT held AND carrying a game.id:   ${games.filter(g => !g.held && g.gameId).length}` +
      ' — ids we could not obtain any other way, since a game id otherwise comes from a grade we walk');
  const roundForms = new Map();
  for (const g of games) {
    const r = String(g.round || '');
    bump(roundForms, /^Round \d+$/.test(r) ? '"Round N"'
      : /final/i.test(r) ? '"...Final..."'
      : r === '' ? '(empty)' : `other: ${JSON.stringify(r)}`);
  }
  log('   round.name forms:');
  log(tallyLine(roundForms, '     ') || '     (none)');
  const dates = games.map(g => g.date).filter(Boolean).sort();
  if (dates.length) {
    log(`   date sample: ${JSON.stringify(dates[0])}; earliest ${dates[0]}, latest ${dates[dates.length - 1]}`);
    const iso = dates.filter(d => /^\d{4}-\d{2}-\d{2}/.test(String(d))).length;
    log(`   dates starting YYYY-MM-DD: ${iso} of ${dates.length} — anything else must not go near new Date(string)`);
  }
  const gradesOutside = [...new Set(regs.filter(r => !r.held).flatMap(r => r.grades).filter(Boolean))];
  log(`   grade names on seasons we do NOT hold: ${gradesOutside.length} distinct`);
  for (const g of gradesOutside.slice(0, 12)) log(`     ${JSON.stringify(g)}`);
  log('   ⚠️ career_stats_design.md §7 says "no grades for outside seasons". If the line');
  log('      above is non-empty, §7 is wrong and a career table can carry a grade.');

  // ── Cost, for both designs ────────────────────────────────────────────────
  log('\n── cost (career_stats_design.md §3/§4, per_game_stats_design.md §4/§5) ──');
  const stat = (arr) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    const zeros = s.filter(n => n === 0).length;
    return { min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1], n: s.length,
             mean: sum / s.length, zeros, meanNonZero: s.length - zeros ? sum / (s.length - zeros) : 0 };
  };
  const rS = stat(perPlayer.map(p => p.regs));
  const gS = stat(perPlayer.map(p => p.games));
  if (rS) {
    log(`   registrations per player: min ${rS.min}, median ${rS.med}, max ${rS.max}, mean ${rS.mean.toFixed(1)}`);
    log(`   players who answered with NOTHING: ${rS.zeros} of ${rS.n}` +
        (rS.zeros ? ` — excluding them the mean is ${rS.meanNonZero.toFixed(1)}` : '') +
        ' (a zero drags the mean every projection below rests on)');
    log('   §3 assumed ~5 seasons per person -> 36 MB plain / 4-5 MB gzipped for 40,002');
    log(`   at ${rS.mean.toFixed(1)} and 180 bytes/season that is ${(40002 * rS.mean * 180 / 1e6).toFixed(1)} MB plain`);
  }
  if (gS) {
    log(`   game lines per player: min ${gS.min}, median ${gS.med}, max ${gS.max}, mean ${gS.mean.toFixed(1)}`);
    log(`   × 40,002 people ≈ ${Math.round(40002 * gS.mean).toLocaleString('en-AU')} lines for the cohort's whole career`);
    log('   per_game_stats_design.md §5 estimated 475,000 lines for two seasons at ~45 bytes');
    log(`   -> ${(40002 * gS.mean * 45 / 1e6).toFixed(0)} MB plain on the same assumption, BEFORE deduplication`);
    log('   ⚠️ THESE LINES DUPLICATE ACROSS PLAYERS. Two players in one game each carry it;');
    log('      a game-keyed store holds it once. The figure above counts lines, not games.');
  }
  log(`   one pass over 40,002 people at 75/min ≈ ${(40002 / 75 / 60).toFixed(1)} hours, and that single`);
  log('   pass returns season totals AND grades AND game lines together.');

  // ── TRIALS ────────────────────────────────────────────────────────────────
  const richest = perPlayer.slice().sort((a, b) => b.regs - a.regs)[0];
  const trialUuid = richest ? richest.uuid : (picked[0] && picked[0].uuid);
  const TL = trials(sampleSeason);
  log(`\n═══ TRIALS — one candidate field group per call, never combined ═══`);
  log(`trial profile: ${trialUuid} ${richest ? `(${richest.regs} registrations, ${richest.games} game lines, ${richest.blocks} blocks)` : '(no player answered; using the first selected)'}`);
  log('⚠️ result { home { score } } is NOT retried — settled rejected 2026-08-16.');

  for (const t of TL) {
    const occurrences = Q_BASE.split(t.find).length - 1;
    if (occurrences !== 1) {
      log(`\n${t.id}: NOT RUN — its anchor appears ${occurrences} time(s) in the base query, not once.`);
      log('  That is a defect in this probe, not an answer from PlayHQ.');
      continue;
    }
    if (t.needs && !t.vars) {
      log(`\n${t.id}: NOT RUN — needs ${t.needs}, and none was available.`);
      continue;
    }
    const q = Q_BASE.replace(t.find, t.with);
    await pace();
    calls++;
    const r = await askProfile(trialUuid, q, t.vars);
    log(`\n${t.id}`);
    log(`  why: ${t.why}`);
    log(`  asked for: ${t.with.replace(/\s+/g, ' ').trim()}`);
    if (t.vars) log(`  extra variables: ${JSON.stringify(t.vars)}`);
    if (r.ok) {
      log('  ACCEPTED');
      if (t.id.startsWith('T5')) {
        log(`    careerStatistics: ${r.career === undefined
          ? '(absent from the response — accepted but empty is NOT the same as working)'
          : JSON.stringify(r.career)}`);
      }
      if (t.id.startsWith('T6')) {
        log(`    season blocks returned: ${r.seasons.length}; the unscoped call returned ${richest ? richest.blocks : '?'}`);
        log('    -> if these DIFFER the argument filters; if they are equal it is accepted and ignored,');
        log('       which is the "accepted is not populated" trap and must not be read as working.');
      }
      const first = r.seasons[0];
      if (first) {
        const reg0 = (first.statistics || [])[0] || {};
        log(`    first block: ${JSON.stringify({ name: first.name, season: reg0.season, club: reg0.club })}`);
      } else {
        log('    ⚠️ accepted but returned no season blocks — that is not the same as the field working');
      }
    } else {
      log(`  REJECTED — ${r.reason}`);
    }
  }

  // ── Optional unpaced burst ────────────────────────────────────────────────
  if (BURST) {
    log(`\n═══ UNPACED BURST — publicProfileStatistics only ═══`);
    log('Measures CALLS BEFORE THE FIRST BLOCK, and nothing else. gqlPost absorbs a');
    log('block with a flat 80 s wait, so recovery cannot be timed from here; it was');
    log('measured at 76-77 s on 2026-09-05. The block is seen through summary().blocked.');
    const pool = Object.keys(cohort.players).filter(u => !picked.some(p => p.uuid === u));
    const t0 = Date.now();
    let fired = 0, blockedAt = 0;
    const before = playhq.summary().blocked;
    for (const uuid of pool.slice(0, BURST_CALLS)) {
      fired++;
      calls++;
      await askProfile(uuid);
      if (playhq.summary().blocked > before) { blockedAt = fired; break; }
    }
    const secs = (Date.now() - t0) / 1000;
    // ⚠️ Never print a rate divided by a zero elapsed time. The first fixture run
    // reported "Infinity req/s", exactly the kind of figure that gets read back
    // as a measurement.
    const rate = secs >= 0.05 ? `${(fired / secs).toFixed(2)} req/s` : 'rate not computable — elapsed too small to divide by';
    if (blockedAt) {
      log(`  BLOCKED on burst call ${blockedAt} after ${secs.toFixed(1)}s — ${secs >= 0.05 ? `${(blockedAt / secs).toFixed(2)} req/s` : 'rate not computable'}`);
      log('  (elapsed INCLUDES the 80 s the transport waited out, so the rate BEFORE the block was higher)');
    } else {
      log(`  no block in ${fired} call(s) over ${secs.toFixed(1)}s — ${rate}`);
      log('  ⚠️ A CLEAN BURST DOES NOT PROVE A BUDGET. It proves this many calls at this rate did not trip it.');
    }
    burstFired = fired;
  }

  log(`\n── summary ──`);
  log(`calls ${calls} = ${picked.length} player(s) + ${TL.length} trial(s)` +
      (burstFired ? ` + ${burstFired} burst` : '') +
      `; answered ${answered}, failed ${failed}`);
  playhq.logSummary('probe-career-stats');
  log('Read-only: nothing was written. Exit 0.');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
