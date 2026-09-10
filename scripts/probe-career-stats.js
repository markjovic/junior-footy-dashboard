#!/usr/bin/env node
// scripts/probe-career-stats.js
//
// READ-ONLY. Writes no file, commits nothing, touches no season file.
//
// v3 (2026-09-10, after the v2 run and career_stats_design.md approval):
//   * T1's season selection is PROMOTED INTO THE BASE QUERY. It was measured
//     ACCEPTED, but only demonstrated on a HELD season — so whether
//     `competition` is POPULATED for an outside league was never measured, and
//     it is the ONLY source of a league name (both name fields are bare years).
//     Answer block 6 measures that, and the season STATUS distribution with it,
//     which is the one figure career_stats_design.md §3 records as unknown.
//   * T1-T4 and T6 are SETTLED and are not re-run. T5 is replaced by the T7
//     series: its rejection named the type `CareerStatistics`, so the field
//     EXISTS and only the selection set was wrong.
//
// v2 REBASED THE PROBE ON index.html's PLAYER_PROFILE_QUERY. v1 used
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
const { gqlPost, sleep, refreshSession } = playhq;

const VERSION = 'probe-career-stats v4 2026-09-10 opname-fix-and-trial-spacing';

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
const TRIAL_GAP_MS = Math.max(0, Number(process.env.PROBE_TRIAL_GAP_MS || 20000));
const TRIAL_MAX_REJECT = Math.max(1, Number(process.env.PROBE_TRIAL_MAX_REJECT || 3));

const log = (...a) => console.log(...a);

// ── The base query — index.html PLAYER_PROFILE_QUERY, copied verbatim ────────
const Q_BASE = `
query publicProfileStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    seasonStatistics {
      name
      statistics {
        season { id name startDate endDate status { value } competition { id name } }
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
function trials() {
  // v2 SETTLED T1-T6 on 2026-09-10 and they are NOT re-run:
  //   T1 season detail          ACCEPTED — promoted into Q_BASE above
  //   T2 season { sport }       REJECTED on DiscoverSeason
  //   T3 season { organisation} REJECTED on DiscoverSeason
  //   T4 details { name }       REJECTED on GameStatistic
  //   T6 (seasonID:) argument   REJECTED — Unknown argument on Query.publicProfileStatistics
  //
  // T5 asked for `careerStatistics { count details { value } }` and PlayHQ answered
  // `Cannot query field "count" on type "CareerStatistics"`.
  //
  // ⚠️ THAT REJECTION IS EVIDENCE THE FIELD EXISTS. An error naming a type means
  // the server resolved the field and rejected only the selection set — the mirror
  // of the result.periods trap, where an accepted field was always empty. The
  // series below settles its shape. Each is one call and a 400 is not retried.
  return [
    {
      id: 'T7a introspect CareerStatistics',
      why: 'If introspection is enabled this answers the whole question in one call. ' +
           'working_practice.md says it is disabled, so I expect a rejection — but the ' +
           'claim has no run number against it, and the answer also tells P1 whether ' +
           'per_game_stats_design.md §3 route 2 can introspect the Query type.',
      full: `query IntrospectCareer {
  __type(name: "CareerStatistics") {
    name
    fields { name type { name kind ofType { name kind } } }
  }
}`,
      show: (json) => JSON.stringify(json && json.data ? json.data : json).slice(0, 1200),
    },
    {
      id: 'T7b careerStatistics { __typename }',
      why: '__typename is legal on ANY object type, so this cannot fail for the reason ' +
           'T5 did. If it is accepted the field is an object and we learn its concrete ' +
           'type name; if it is rejected, careerStatistics is not an object field and ' +
           'the T5 error meant something else.',
      find: '    seasonStatistics {\n',
      with: '    careerStatistics { __typename }\n    seasonStatistics {\n',
      probe: 'careerStatistics',
    },
    {
      id: 'T7c careerStatistics { statistics { count details { value } } }',
      why: 'GUESS. The shape every other level of this response uses.',
      find: '    seasonStatistics {\n',
      with: '    careerStatistics { statistics { count details { value } } }\n    seasonStatistics {\n',
      probe: 'careerStatistics',
    },
    {
      id: 'T7d careerStatistics { totalStatistics { count details { value } } }',
      why: 'GUESS. The name used on the season and grade levels.',
      find: '    seasonStatistics {\n',
      with: '    careerStatistics { totalStatistics { count details { value } } }\n    seasonStatistics {\n',
      probe: 'careerStatistics',
    },
    {
      id: 'T7e careerStatistics { details { value } count }',
      why: 'GUESS. T5 put count OUTSIDE details; this puts it inside, in case ' +
           'CareerStatistics is itself the statistic rather than a wrapper.',
      find: '    seasonStatistics {\n',
      with: '    careerStatistics { details { value } }\n    seasonStatistics {\n',
      probe: 'careerStatistics',
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
async function askProfile(uuid, query, opName) {
  // ⚠️ THE OPERATION NAME MUST MATCH THE DOCUMENT. v3 sent every trial under
  // 'publicProfileStatistics', including the introspection trial whose document
  // declares `query IntrospectCareer`. A name matching no operation in the
  // document is rejected before execution, and that rejection would have read as
  // "introspection is disabled" — a negative result manufactured by the test.
  // Derived from the query text rather than passed in, so the two cannot drift.
  const op = opName || (/^\s*query\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query || Q_BASE) || [])[1]
    || 'publicProfileStatistics';
  const vars = { profileID: uuid };
  let json;
  try {
    json = await gqlPost(query || Q_BASE, vars, op);
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
  log(`manifest: ${manifest.length} entries, ${heldIds.size} season id(s) this project holds`);

  // ⚠️ ACQUIRE THE SESSION BEFORE ANYTHING ELSE. v3 walked twenty players without
  // one and printed twenty FAILED lines above an answers block of zeros, which
  // reads like a measurement of nothing rather than a failure to measure.
  // fetch-stats.js opens the same way.
  const gotSession = await refreshSession();
  if (!gotSession) {
    console.error('FATAL: no PlayHQ session. Every call would fail and the answers');
    console.error('block would be zeros, which is not a measurement.');
    console.error('If the log above shows CloudFront blocks on TenantConfig/ProfileSearch,');
    console.error('the WAF is refusing the handshake — dashboard_context.md §8d records a');
    console.error('burst of rejected-field probes on one run refusing every session attempt');
    console.error('on the next. Wait, then re-dispatch. Nothing was written.');
    process.exit(1);
  }
  if (playhq.summary().blocked) log(`⚠️ session acquired, but ${playhq.summary().blocked} block(s) on the way — the window is tight; treat timings below with suspicion`);

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
          status: reg.season && reg.season.status ? reg.season.status.value : null,
          compName: reg.season && reg.season.competition ? reg.season.competition.name : null,
          compId: reg.season && reg.season.competition ? reg.season.competition.id : null,
          startDate: reg.season ? reg.season.startDate : null,
          endDate: reg.season ? reg.season.endDate : null,
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
  // ⚠️ An answers block computed from nothing looks exactly like a measurement.
  if (!answered) {
    log('\n═══ NO ANSWERS ═══');
    log('Not one player answered, so there is nothing to summarise and the trials are');
    log('SKIPPED — a dead run must not add rejected-field probes to the next run\'s problem.');
    playhq.logSummary('probe-career-stats');
    process.exit(1);
  }
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

  // 6. season status and league — the §3 unknown, and the "accepted is not
  //    populated" check on competition. T1 was ACCEPTED in v2 but demonstrated on
  //    a HELD season only, so whether competition is POPULATED for an outside
  //    league was never measured. It is the only source of a league name.
  log(`\n6. season status and league (the T1 fields, now in the base query)`);
  const statusTally = new Map();
  for (const r of regs) bump(statusTally, `${r.status || '(null)'} ${r.held ? '[held]' : '[NOT held]'}`);
  log('   status × held:');
  log(tallyLine(statusTally, '     ') || '     (none)');
  const withComp = regs.filter(r => r.compName).length;
  const outRegs = regs.filter(r => !r.held);
  const outWithComp = outRegs.filter(r => r.compName).length;
  log(`   registrations carrying competition.name: ${withComp} of ${regs.length}`);
  log(`   ...of the ${outRegs.length} NOT held: ${outWithComp} carry one` +
      ` <- if this is short of ${outRegs.length}, an outside season has NO league name anywhere`);
  const outLeagues = [...new Set(outRegs.map(r => r.compName).filter(Boolean))].sort();
  log(`   distinct leagues on seasons we do NOT hold: ${outLeagues.length}`);
  for (const l of outLeagues.slice(0, 25)) log(`     ${JSON.stringify(l)}`);
  const outNoComp = outRegs.filter(r => !r.compName);
  if (outNoComp.length) {
    log(`   ${outNoComp.length} NOT-held registration(s) with no competition — first few:`);
    for (const r of outNoComp.slice(0, 5)) log(`     ${r.uuid} ${r.blockName} club=${JSON.stringify(r.club)}`);
  }
  // The weekly re-check set: a person with any season that is not COMPLETED and
  // that we do not hold. career_stats_design.md §3 says this figure is unknown;
  // this is the first measurement of it.
  const weeklyPeople = new Set(regs.filter(r => !r.held && r.status && r.status !== 'COMPLETED').map(r => r.uuid));
  log(`   PLAYERS needing a WEEKLY re-check (a live season we do not hold): ${weeklyPeople.size} of ${answered}`);
  log(`   -> extrapolated to 40,002 that is ~${Math.round(40002 * weeklyPeople.size / Math.max(1, answered)).toLocaleString('en-AU')} people a week,` +
      ` ${(40002 * weeklyPeople.size / Math.max(1, answered) / 75 / 60).toFixed(1)} hours at 75/min`);
  log('   ⚠️ TWENTY PLAYERS IS NOT A POPULATION. This sets an order of magnitude, not a budget.');
  const dateForms = regs.filter(r => r.startDate).length;
  log(`   registrations carrying startDate/endDate: ${dateForms} of ${regs.length}` +
      (regs.find(r => r.startDate) ? `; sample ${JSON.stringify(regs.find(r => r.startDate).startDate)} to ${JSON.stringify(regs.find(r => r.startDate).endDate)}` : ''));

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
  const TL = trials();
  log(`\n═══ TRIALS — one candidate field group per call, never combined ═══`);
  log(`trial profile: ${trialUuid} ${richest ? `(${richest.regs} registrations, ${richest.games} game lines, ${richest.blocks} blocks)` : '(no player answered; using the first selected)'}`);
  log('⚠️ result { home { score } } is NOT retried — settled rejected 2026-08-16.');

  // ⚠️ REJECTED FIELDS ARE THE EXPENSIVE PART OF A PROBE. dashboard_context.md
  // §8d: a burst of rejected-field probes on one run is the most likely reason
  // the WAF refused every session attempt on the NEXT run. So they are spaced
  // deliberately and capped — the token bucket permits 100 in 80 s and was doing
  // nothing to separate them. Better a second dispatch tomorrow than a poisoned
  // one in ten minutes.
  let rejections = 0;
  let trialIdx = 0;
  for (const t of TL) {
    if (rejections >= TRIAL_MAX_REJECT) {
      log(`\n${t.id}: NOT RUN — ${rejections} rejection(s) already this run, and a burst of them`);
      log('  is what refuses the NEXT run its session (dashboard_context.md §8d). Re-dispatch for the rest.');
      continue;
    }
    if (trialIdx++) { log(`  [spacing ${TRIAL_GAP_MS / 1000}s before the next trial]`); await sleep(TRIAL_GAP_MS); }
    let q;
    if (t.full) {
      q = t.full;
    } else {
      const occurrences = Q_BASE.split(t.find).length - 1;
      if (occurrences !== 1) {
        log(`\n${t.id}: NOT RUN — its anchor appears ${occurrences} time(s) in the base query, not once.`);
        log('  That is a defect in this probe, not an answer from PlayHQ.');
        continue;
      }
      q = Q_BASE.replace(t.find, t.with);
    }
    await pace();
    calls++;
    const r = await askProfile(trialUuid, q);
    log(`\n${t.id}`);
    log(`  why: ${t.why}`);
    log(`  asked for: ${(t.full || t.with).replace(/\s+/g, ' ').trim()}`);
    if (r.ok) {
      log('  ACCEPTED');
      if (t.full) {
        // An introspection query returns no publicProfileStatistics at all, so the
        // normal "first block" reporting below would say nothing about it.
        log(`    payload: ${t.show ? t.show(r.json) : JSON.stringify(r.json).slice(0, 1200)}`);
        continue;
      }
      if (t.probe === 'careerStatistics') {
        log(`    careerStatistics: ${r.career === undefined
          ? '⚠️ ACCEPTED BUT ABSENT FROM THE RESPONSE — that is the result.periods trap, NOT a working field'
          : JSON.stringify(r.career)}`);
        continue;
      }
      const first = r.seasons[0];
      if (first) {
        const reg0 = (first.statistics || [])[0] || {};
        log(`    first block: ${JSON.stringify({ name: first.name, season: reg0.season, club: reg0.club })}`);
      } else {
        log('    ⚠️ accepted but returned no season blocks — that is not the same as the field working');
      }
    } else {
      rejections++;
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
