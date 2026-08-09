#!/usr/bin/env node
// scripts/probe-finals-rounds.js
//
// READ-ONLY PROBE. Writes nothing, commits nothing, pushes nothing.
//
// Answers one question that cannot be answered by reading source: what does
// PlayHQ put in rounds[].number for a finals round, relative to the
// home-and-away rounds in the same grade?
//
// Three outcomes are possible and they demand different fixes:
//   SEQUENTIAL — finals continue the numbering (H&A ends R18, finals are R19+).
//                Finals ingest today, which means they are already counting
//                towards the ladder.
//   NULLISH    — number is null/absent, so parseInt(...) || 0 yields 0 and
//                fetch-results.js line 462 skips it as "already stored".
//                Finals are never fetched.
//   COLLIDING  — finals restart at 1, so the match id
//                "comp|age|grade|1|Away|Home" collides with real Round 1 and
//                a finals result overwrites a home-and-away result.
//
// The query and the HTTP/session stack are copied from the live
// fetch-results.js, with `abbreviatedName` added to the round selection.
//
// Usage (all optional):
//   node scripts/probe-finals-rounds.js
//   node scripts/probe-finals-rounds.js --comp="EFNL 2026"
//   node scripts/probe-finals-rounds.js --age=U12 --fixtures
//   node scripts/probe-finals-rounds.js --grade=<gradeID>
//   node scripts/probe-finals-rounds.js --limit=40
//
//   --comp=<name>      only grades whose compName matches (case-insensitive substring)
//   --age=<text>       only grades whose name matches (case-insensitive substring)
//   --grade=<id>       probe exactly one grade id and ignore every other filter
//   --limit=<n>        stop after n grades (0 = no limit, the default)
//   --fixtures         also fetch the fixture for each finals round, to show
//                      whether undetermined teams arrive as ProvisionalTeam
//   --fixture-cap=<n>  how many finals rounds to fixture-probe (default 5)
//   --all-rounds       print every grade, not just grades that have finals
//   --cooldown-every=<n>    grades between cooldowns (default 60, 0 disables)
//   --cooldown-seconds=<n>  cooldown duration (default 30, 0 disables)
//
// COOLDOWN NOTE. fetch-results.js pauses 60s every 20 grades, but it issues one
// gradeRounds call PLUS one discoverFixtureByRound call per round, per grade.
// This probe issues one call per grade and nothing more unless --fixtures is
// set, so its request rate is a small fraction of the pattern that cooldown was
// tuned for, and the defaults here are correspondingly looser. The safety net is
// reactive rather than assumed: three consecutive grade failures trigger a
// 60-second backoff regardless of the configured interval.

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT        = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const GRADES_PATH = path.join(ROOT, 'grades.json');
const DATA_PATH   = path.join(ROOT, 'data.json');

// ─── Config ───────────────────────────────────────────────────────────────────

const FETCH_DELAY = parseInt(process.env.FETCH_DELAY_MS || '200', 10);
const API_URL     = 'https://api.playhq.com/graphql';
const USER_AGENT  = 'PlayHQ/1.47.2 Android/28 (Android SDK built for x86)';

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    comp:            null,
    age:             null,
    gradeId:         null,
    limit:           0,
    fixtures:        false,
    fixtureCap:      5,
    allRounds:       false,
    cooldownEvery:   60,
    cooldownSeconds: 30,
  };
  // parseInt returns NaN for junk, and `|| fallback` would then silently
  // reinstate the default. For the cooldown options an explicit 0 is a
  // meaningful value (disable), so NaN and 0 must be told apart.
  const intOr = (val, fallback) => {
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? fallback : n;
  };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const val = eq === -1 ? '' : arg.slice(eq + 1);
    switch (key) {
      case '--comp':             opts.comp            = val.trim() || null; break;
      case '--age':              opts.age             = val.trim() || null; break;
      case '--grade':            opts.gradeId         = val.trim() || null; break;
      case '--limit':            opts.limit           = intOr(val, 0); break;
      case '--fixture-cap':      opts.fixtureCap      = intOr(val, 5); break;
      case '--cooldown-every':   opts.cooldownEvery   = Math.max(0, intOr(val, 60)); break;
      case '--cooldown-seconds': opts.cooldownSeconds = Math.max(0, intOr(val, 30)); break;
      case '--fixtures':         opts.fixtures        = true; break;
      case '--all-rounds':       opts.allRounds       = true; break;
      default:
        if (key.startsWith('--')) {
          console.error(`Unknown argument: ${key}`);
          process.exit(1);
        }
    }
  }
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));

// ─── GraphQL queries ──────────────────────────────────────────────────────────
// Q_GRADE_ROUNDS is fetch-results.js's query with `abbreviatedName` added.
// Q_FIXTURE_PROBE spreads BOTH DiscoverTeam and ProvisionalTeam, because the
// live fetchers only spread DiscoverTeam and therefore cannot see an
// undetermined finals fixture at all.

const Q_GRADE_ROUNDS = `
query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    id
    name
    dates
    rounds {
      id
      name
      abbreviatedName
      number
      current
      isFinalsRound
      provisionalDates
    }
  }
}`;

const Q_FIXTURE_PROBE = `
query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      id
      home {
        ... on DiscoverTeam { id name }
        ... on ProvisionalTeam { name }
      }
      away {
        ... on DiscoverTeam { id name }
        ... on ProvisionalTeam { name }
      }
      status { value }
      date
    }
  }
}`;

// ─── HTTP / GraphQL (copied from fetch-results.js) ────────────────────────────

let SESSION_COOKIE = '';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function gqlPost(query, variables, operationName) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(operationName
      ? { operationName, query, variables }
      : { query, variables });
    const req = https.request(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     USER_AGENT,
        'Accept':         'application/json',
        'tenant':         'afl',
        'origin':         'https://www.playhq.com',
        'request-id':     crypto.randomUUID(),
        ...(SESSION_COOKIE ? { 'Cookie': SESSION_COOKIE } : {}),
      },
      timeout: 60000,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200)
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

async function getSession() {
  const body = JSON.stringify({
    operationName: 'TenantConfig',
    variables: {},
    query: 'query TenantConfig { tenantConfiguration { label } }',
  });
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await sleep(attempt * 2000);
    const raw = await new Promise((resolve) => {
      const req = https.request(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent':     USER_AGENT,
          'Accept':         'application/json',
          'tenant':         'afl',
          'origin':         'https://www.playhq.com',
          'request-id':     crypto.randomUUID(),
        },
        timeout: 30000,
      }, res => {
        resolve(res.headers['set-cookie']?.join(';') || '');
        res.resume();
      });
      req.on('error', () => resolve(''));
      req.write(body);
      req.end();
    });
    const m = raw.match(/phq_session=([^;]+)/);
    if (m) {
      SESSION_COOKIE = `phq_session=${m[1]}`;
      console.log('Session cookie obtained');
      return;
    }
  }
  console.warn('Could not obtain session cookie — proceeding without');
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

// Show the RAW value, not a coerced one. null, undefined, "" and 0 are four
// different diagnoses and coercing them to a number destroys the evidence.
function raw(v) {
  return JSON.stringify(v === undefined ? null : v);
}

// What fetch-results.js line 458 would compute for this round.
function asStoredRound(numberValue) {
  return parseInt(numberValue, 10) || 0;
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

// ─── Per-grade classification ─────────────────────────────────────────────────

// Given one grade's round list, work out what the finals numbering does.
function classifyGrade(rounds) {
  const finals = rounds.filter(r => r.isFinalsRound === true);
  const homeAway = rounds.filter(r => r.isFinalsRound !== true);

  if (!finals.length) return { verdict: 'NO_FINALS', finals, homeAway };

  const haStored     = homeAway.map(r => asStoredRound(r.number));
  const finalsStored = finals.map(r => asStoredRound(r.number));
  const maxHA        = haStored.length ? Math.max(...haStored) : 0;

  // Any finals round whose stored value duplicates a home-and-away stored
  // value is an id collision: the match id embeds this number.
  const haSet      = new Set(haStored);
  const collisions = finalsStored.filter(n => haSet.has(n));

  // Any finals round whose stored value duplicates ANOTHER finals round's
  // stored value collapses two finals onto one round key.
  const seen = new Set();
  const internalDupes = [];
  for (const n of finalsStored) {
    if (seen.has(n)) internalDupes.push(n);
    seen.add(n);
  }

  const allNullish = finals.every(r => asStoredRound(r.number) === 0);
  const allAbove   = finalsStored.every(n => n > maxHA);

  let verdict;
  if (collisions.length)      verdict = 'COLLIDING';
  else if (allNullish)        verdict = 'NULLISH';
  else if (allAbove)          verdict = 'SEQUENTIAL';
  else                        verdict = 'MIXED';

  return {
    verdict, finals, homeAway,
    maxHA, finalsStored, collisions, internalDupes,
  };
}

// ─── Grade selection ──────────────────────────────────────────────────────────

function loadGrades() {
  if (!fs.existsSync(GRADES_PATH)) {
    console.error(`grades.json not found at ${GRADES_PATH} — run fetch-results.js first`);
    process.exit(1);
  }
  let grades;
  try {
    grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8'));
  } catch (e) {
    console.error(`Could not parse grades.json: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(grades) || !grades.length) {
    console.error('grades.json is empty');
    process.exit(1);
  }
  return grades;
}

function selectGrades(allGrades) {
  if (OPTS.gradeId) {
    const one = allGrades.find(g => g.id === OPTS.gradeId);
    if (one) return [one];
    // Allow probing a grade id that isn't in the cache yet.
    console.log(`Grade ${OPTS.gradeId} not in grades.json — probing it directly`);
    return [{ id: OPTS.gradeId, name: '(not in grades.json)', compName: '(unknown)' }];
  }

  let out = allGrades;
  if (OPTS.comp) {
    const needle = OPTS.comp.toLowerCase();
    out = out.filter(g => (g.compName || '').toLowerCase().includes(needle));
  }
  if (OPTS.age) {
    const needle = OPTS.age.toLowerCase();
    out = out.filter(g => (g.name || '').toLowerCase().includes(needle));
  }
  if (OPTS.limit > 0) out = out.slice(0, OPTS.limit);
  return out;
}

// ─── Stored-round cross-reference (read-only) ─────────────────────────────────
// Groups data.json's existing match records by compName|age|rawGrade and
// reports the highest stored round. No parsing or inference — these fields are
// already on the records. Lets us see whether finals are ALREADY in the store.

function reportStoredRounds() {
  if (!fs.existsSync(DATA_PATH)) {
    console.log('\nNo data.json present — skipping stored-round cross-reference.');
    return;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    console.log(`\nCould not parse data.json (${e.message}) — skipping cross-reference.`);
    return;
  }
  const matches = data.matches || [];
  if (!matches.length) {
    console.log('\ndata.json has no matches — skipping cross-reference.');
    return;
  }

  const byKey = new Map();
  for (const m of matches) {
    const key = `${m.compName || ''}|${m.age || ''}|${m.rawGrade || ''}`;
    let e = byKey.get(key);
    if (!e) {
      e = { max: 0, real: 0, bye: 0, partial: 0, scheduled: 0, rounds: new Set() };
      byKey.set(key, e);
    }
    const r = typeof m.round === 'number' ? m.round : asStoredRound(m.round);
    if (r > e.max) e.max = r;
    e.rounds.add(r);
    if (m.isBye)          e.bye++;
    else if (m.isPartial) e.partial++;
    else if (m.scheduled) e.scheduled++;
    else                  e.real++;
  }

  console.log('\n' + '='.repeat(78));
  console.log('STORED ROUNDS IN data.json  (read-only cross-reference)');
  console.log('='.repeat(78));
  console.log(`${pad('comp|age|grade', 44)} ${pad('maxR', 5)} ${pad('real', 6)} ${pad('bye', 5)} ${pad('part', 5)} ${pad('sched', 6)} rounds`);

  const keys = [...byKey.keys()].sort();
  for (const key of keys) {
    const e = byKey.get(key);
    const rounds = [...e.rounds].sort((a, b) => a - b).join(',');
    console.log(`${pad(key, 44)} ${pad(e.max, 5)} ${pad(e.real, 6)} ${pad(e.bye, 5)} ${pad(e.partial, 5)} ${pad(e.scheduled, 6)} ${rounds}`);
  }
  console.log(`\n${keys.length} grade key(s) in data.json, ${matches.length} match record(s) total.`);
}

// ─── Fixture shape probe ──────────────────────────────────────────────────────
// Shows whether an undetermined finals fixture arrives as ProvisionalTeam.
// The live fetchers only spread DiscoverTeam, so they would see name: undefined
// and discard the game.

async function probeFixture(gradeLabel, round) {
  const number = asStoredRound(round.number);
  console.log(`\n  FIXTURE PROBE — ${gradeLabel} / ${round.name || '(unnamed)'} (stored R${number})`);

  let res;
  try {
    res = await gqlPost(Q_FIXTURE_PROBE, { roundID: round.id });
    await sleep(FETCH_DELAY);
  } catch (e) {
    console.log(`    fixture fetch failed: ${e.message}`);
    return;
  }

  if (res?.errors?.length) {
    console.log(`    GraphQL errors: ${res.errors.map(e => e.message).join('; ')}`);
    return;
  }

  const games = res?.data?.discoverFixtureByRound?.games || [];
  if (!games.length) {
    console.log('    no games returned (bye round, or fixture not yet published)');
    return;
  }

  for (const g of games) {
    // A DiscoverTeam carries an id. A ProvisionalTeam does not.
    const hKind = g.home?.id ? 'DiscoverTeam' : (g.home?.name ? 'ProvisionalTeam' : 'ABSENT');
    const aKind = g.away?.id ? 'DiscoverTeam' : (g.away?.name ? 'ProvisionalTeam' : 'ABSENT');
    const wouldDrop = !g.home?.name || !g.away?.name;
    console.log(
      `    ${pad(g.status?.value || '?', 10)} ` +
      `home=${pad(raw(g.home?.name), 34)} [${pad(hKind, 15)}]  ` +
      `away=${pad(raw(g.away?.name), 34)} [${pad(aKind, 15)}]` +
      (wouldDrop ? '   <-- live fetchers DISCARD this game' : '')
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('probe-finals-rounds.js — READ-ONLY. Nothing is written or committed.');
  console.log(`Options: ${JSON.stringify(OPTS)}`);

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const names = (cfg.competitions || []).map(c => `${c.name}${c.vip ? ' (VIP)' : ''}`);
      if (names.length) console.log(`Configured competitions: ${names.join(', ')}`);
    } catch (e) {
      console.warn(`Could not parse config.json: ${e.message}`);
    }
  }

  await getSession();

  const allGrades = loadGrades();
  const grades    = selectGrades(allGrades);
  console.log(`\nProbing ${grades.length} of ${allGrades.length} grade(s).`);
  if (!grades.length) {
    console.log('Nothing to probe — check --comp / --age filters.');
    return;
  }

  // Print the plan before doing any of it, so a wrong setting can be cancelled
  // in the first few seconds rather than discovered half an hour later.
  const cooldownOn = OPTS.cooldownEvery > 0 && OPTS.cooldownSeconds > 0;
  const pauses     = cooldownOn ? Math.floor((grades.length - 1) / OPTS.cooldownEvery) : 0;
  const callSecs   = grades.length * (FETCH_DELAY / 1000 + 0.4); // delay + rough latency
  const pauseSecs  = pauses * OPTS.cooldownSeconds;
  console.log(
    cooldownOn
      ? `Cooldown: ${OPTS.cooldownSeconds}s every ${OPTS.cooldownEvery} grade(s) — ${pauses} pause(s) expected.`
      : 'Cooldown: DISABLED.'
  );
  console.log(`Reactive backoff: 60s after 3 consecutive grade failures.`);
  console.log(`Projected runtime: ~${Math.round((callSecs + pauseSecs) / 60)} min ` +
              `(${Math.round(callSecs)}s of calls + ${pauseSecs}s of cooldown).`);

  const verdicts       = new Map(); // verdict -> count
  const gradesWithFinals = [];
  const failures       = [];
  const fixtureQueue   = [];

  let idx = 0;
  let consecutiveFailures = 0;
  let backoffs = 0;

  for (const grade of grades) {
    idx++;
    const label = `${grade.compName || '?'} — ${grade.name || '?'}`;

    if (cooldownOn && idx > 1 && (idx - 1) % OPTS.cooldownEvery === 0) {
      console.log(`  [cooldown ${OPTS.cooldownSeconds}s after ${idx - 1} grades]`);
      await sleep(OPTS.cooldownSeconds * 1000);
    }

    let res;
    try {
      res = await gqlPost(Q_GRADE_ROUNDS, { gradeID: grade.id });
      await sleep(FETCH_DELAY);
    } catch (e) {
      console.log(`[${idx}/${grades.length}] ${label} — FAILED: ${e.message}`);
      failures.push({ label, reason: e.message });
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        console.log(`  [${consecutiveFailures} consecutive failures — backing off 60s]`);
        await sleep(60000);
        consecutiveFailures = 0;
        backoffs++;
      }
      continue;
    }

    if (res?.errors?.length) {
      const msg = res.errors.map(e => e.message).join('; ');
      console.log(`[${idx}/${grades.length}] ${label} — GraphQL errors: ${msg}`);
      failures.push({ label, reason: msg });
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        console.log(`  [${consecutiveFailures} consecutive failures — backing off 60s]`);
        await sleep(60000);
        consecutiveFailures = 0;
        backoffs++;
      }
      continue;
    }

    consecutiveFailures = 0;

    const gradeData = res?.data?.discoverGrade;
    const rounds    = gradeData?.rounds || [];
    if (!rounds.length) {
      console.log(`[${idx}/${grades.length}] ${label} — no rounds returned`);
      continue;
    }

    const c = classifyGrade(rounds);
    verdicts.set(c.verdict, (verdicts.get(c.verdict) || 0) + 1);

    if (c.verdict === 'NO_FINALS' && !OPTS.allRounds) {
      console.log(`[${idx}/${grades.length}] ${label} — ${rounds.length} round(s), no finals`);
      continue;
    }

    gradesWithFinals.push({ label, ...c });

    console.log(`\n[${idx}/${grades.length}] ${label}`);
    console.log(`  gradeID: ${grade.id}`);
    console.log(`  dates:   ${raw(gradeData?.dates)}`);
    console.log(`  verdict: ${c.verdict}`);
    console.log(`  ${pad('name', 26)} ${pad('abbrev', 10)} ${pad('number(raw)', 13)} ${pad('->stored', 9)} ${pad('current', 8)} ${pad('finals', 7)} provisionalDates`);

    for (const r of rounds) {
      console.log(
        `  ${pad(r.name, 26)} ${pad(r.abbreviatedName ?? '-', 10)} ` +
        `${pad(raw(r.number), 13)} ${pad(asStoredRound(r.number), 9)} ` +
        `${pad(raw(r.current), 8)} ${pad(raw(r.isFinalsRound), 7)} ${raw(r.provisionalDates)}`
      );
    }

    if (c.collisions.length) {
      console.log(`  *** COLLISION: finals stored round(s) ${[...new Set(c.collisions)].join(',')} duplicate home-and-away round(s) in this grade.`);
      console.log(`      A finals match id would overwrite a home-and-away match id.`);
    }
    if (c.internalDupes.length) {
      console.log(`  *** INTERNAL DUPLICATE: finals rounds share stored round(s) ${[...new Set(c.internalDupes)].join(',')}.`);
      console.log(`      Two different finals would collapse onto one round key.`);
    }
    if (c.verdict === 'SEQUENTIAL') {
      console.log(`      Last home-and-away stored round is ${c.maxHA}; finals are ${c.finalsStored.join(',')}.`);
      console.log(`      These ingest today, so they are already reaching computeLadder().`);
    }
    if (c.verdict === 'NULLISH') {
      console.log(`      Every finals round resolves to stored round 0.`);
      console.log(`      fetch-results.js line 462 would skip them as "already stored".`);
    }

    if (OPTS.fixtures) {
      for (const fr of c.finals) fixtureQueue.push({ label, round: fr });
    }
  }

  // ── Fixture shape probe ──
  if (OPTS.fixtures) {
    const cap = OPTS.fixtureCap > 0 ? OPTS.fixtureCap : fixtureQueue.length;
    const slice = fixtureQueue.slice(0, cap);
    console.log('\n' + '='.repeat(78));
    console.log(`FIXTURE SHAPE PROBE — ${slice.length} of ${fixtureQueue.length} finals round(s)`);
    console.log('='.repeat(78));
    console.log('A DiscoverTeam carries an id; a ProvisionalTeam does not.');
    console.log('The live fetchers only spread DiscoverTeam, so a ProvisionalTeam');
    console.log('arrives with name undefined and the game is discarded.');
    for (const item of slice) {
      await probeFixture(item.label, item.round);
    }
  }

  // ── Verdict summary ──
  console.log('\n' + '='.repeat(78));
  console.log('VERDICT SUMMARY');
  console.log('='.repeat(78));

  const totalProbed = grades.length - failures.length;
  console.log(`Grades probed successfully: ${totalProbed} of ${grades.length}`);
  if (backoffs) {
    console.log(`\n*** ${backoffs} reactive backoff(s) fired — three consecutive failures each time.`);
    console.log(`    The configured cooldown (${OPTS.cooldownEvery} grades / ${OPTS.cooldownSeconds}s) may be too loose.`);
    console.log(`    Re-run with a smaller --cooldown-every or a larger --cooldown-seconds.`);
  }
  if (failures.length) {
    console.log(`Failures: ${failures.length}`);
    for (const f of failures.slice(0, 10)) console.log(`  ${f.label} — ${f.reason}`);
    if (failures.length > 10) console.log(`  ... and ${failures.length - 10} more`);
  }

  console.log('\nVerdict counts:');
  for (const [v, n] of [...verdicts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(v, 12)} ${n}`);
  }

  console.log(`\nGrades with at least one finals round: ${gradesWithFinals.length}`);
  if (gradesWithFinals.length) {
    console.log(`\n${pad('verdict', 12)} ${pad('maxHA', 6)} ${pad('finals stored rounds', 24)} grade`);
    for (const g of gradesWithFinals) {
      console.log(`${pad(g.verdict, 12)} ${pad(g.maxHA, 6)} ${pad((g.finalsStored || []).join(','), 24)} ${g.label}`);
    }
  }

  const distinct = [...verdicts.keys()].filter(v => v !== 'NO_FINALS');
  console.log('');
  if (!gradesWithFinals.length) {
    console.log('CONCLUSION: no finals rounds found in the probed set. Widen the filters,');
    console.log('or the competitions probed have not published a finals fixture yet.');
  } else if (distinct.length === 1) {
    console.log(`CONCLUSION: finals numbering is consistently ${distinct[0]} across ${gradesWithFinals.length} grade(s).`);
  } else {
    console.log(`CONCLUSION: finals numbering is NOT consistent — ${distinct.join(', ')} all appear.`);
    console.log('The fix must handle every observed case, not the most common one.');
  }

  reportStoredRounds();

  console.log('\nProbe complete. Nothing was written.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
