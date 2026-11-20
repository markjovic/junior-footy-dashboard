#!/usr/bin/env node
// scripts/probe-signings.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-signings v2 2026-11-20 tenant-scoped';

//
// Does `lastInteractedOrganisation` find club changes BEFORE a team exists?
//
// Thomas Arbuckle is the case that prompted this: the field names South Croydon
// while publicProfileTeams returns only his three Norwood teams, because EFNL
// 2027 junior teams have not been formed yet. If that generalises, we can see
// signings months earlier than the current route. If he is a one-off, we cannot.
//
// This samples players with NO next-season registration on record and asks what
// the field says about them.
//
// ⚠️ THE FIELD IS TENANT-SCOPED. Probing as `afl` returns FOOTBALL organisations
// only — a basketball club cannot come back, whatever the same profile looks like
// on another tenant. v1 of this probe was built around that fear and it was
// unfounded; the classification below is unchanged but the third bucket means
// something quite different from what v1 claimed.
//
// Every answer is sorted into:
//
//   SAME        the club we already have for them. Tells us nothing new.
//   KNOWN CLUB  an organisation that appears in OUR football data, so it is in
//               one of the five competitions we track. A move inside our data.
//   UNKNOWN ORG a FOOTBALL organisation we have never seen — another league,
//               another state, or a body that runs carnivals and Nines.
//
// ⚠️ UNKNOWN ORG IS NOT "NOT A TRANSFER". It is undecided. A different league
// running a real winter season is very likely a move; a body that runs a spring
// Nines is a second registration alongside the normal season. Which one it is
// depends on the ORGANISATION, and scripts/probe-org-profile.js is what answers
// that — it profiles an org from its season history. Feed the ids printed below
// into it rather than drawing a conclusion here.
//
// READ-ONLY: nothing is written. One call per sampled player, paced.
//
// Env: PS_SAMPLE (default 120), PS_PACE_MS (default 900), PS_COMP (restrict to
//      one competition, e.g. "EFNL").

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const SAMPLE = Math.max(1, Number(process.env.PS_SAMPLE || 120));
const PACE = Math.max(0, Number(process.env.PS_PACE_MS || 900));
const COMP = (process.env.PS_COMP || '').trim();

const log = (...a) => console.log(...a);
const die = (m, c = 1) => { console.error(`FATAL: ${m}`); process.exit(c); };
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const Q_SEARCH = 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) ' +
  '{ result { id firstName lastName lastInteractedOrganisation { id name } } } }';

const fold = (s) => String(s || '').replace(/\s*\([^)]*\)\s*$/, '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: nothing is written.\n');

  if (!fs.existsSync(REG_PATH)) die('data/registrations.json.gz does not exist.');
  const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));

  // ── Every organisation we have ever seen, by id AND by folded name ─────────
  // ⚠️ BOTH, because the field returns a DECORATED name — "South Croydon
  // (Eastern Football Netball League)" — and an id we may hold under a different
  // spelling. Matching on one alone would put real clubs in the unknown bucket.
  const knownIds = new Set(), knownNames = new Map();
  const addClub = (id, name) => {
    if (id) knownIds.add(id);
    if (name) knownNames.set(fold(name), name);
  };
  for (const [id, v] of Object.entries(core.clubs || {})) addClub(id, (v && (v.name || v)) || '');
  for (const v of Object.values(core.teamClub || {})) addClub(v, '');
  for (const v of Object.values(core.teamOrg || {})) addClub(v, '');
  for (const r of Object.values(reg.players || {})) {
    const f = r.from || {};
    addClub(f.club, f.clubName);
    for (const t of (r.tracked || [])) addClub(t.club, t.clubName);
  }
  log(`known football organisations: ${knownIds.size} id(s), ${knownNames.size} name(s)`);

  // ── The population: walked, nothing next season on record ──────────────────
  const pool = [];
  for (const [uuid, r] of Object.entries(reg.players || {})) {
    if (!r.at || !r.name || !r.from || !r.from.club) continue;
    if ((r.tracked || []).length) continue;
    if (COMP && !String(r.from.compName || '').toLowerCase().includes(COMP.toLowerCase())) continue;
    pool.push({ uuid, r });
  }
  log(`players with nothing recorded for next season${COMP ? ` in ${COMP}` : ''}: ${pool.length}`);
  if (!pool.length) die('nobody to sample.', 2);

  // Every Nth, not the first N — the file is in walk order and the first N share
  // a season and often a club.
  const step = Math.max(1, Math.floor(pool.length / SAMPLE));
  const sample = [];
  for (let i = 0; i < pool.length && sample.length < SAMPLE; i += step) sample.push(pool[i]);
  log(`sampling ${sample.length}, one every ${step}\n`);

  await phq.ensureSession();

  const t = { same: 0, knownClub: 0, unknownOrg: 0, none: 0, ambiguous: 0, notFound: 0, error: 0 };
  const examples = { knownClub: [], unknownOrg: [] };

  for (const e of sample) {
    await sleep(PACE);
    let json;
    try { json = await phq.gqlPost(Q_SEARCH, { fullName: e.r.name }, 'ProfileSearch'); }
    catch (err) { t.error++; continue; }
    if (json && json.errors && json.errors.length) { t.error++; continue; }

    const res = ((json.data && json.data.profileSearch) || {}).result || [];
    if (!res.length) { t.notFound++; continue; }
    const exact = res.filter(p => p.id === e.uuid);
    // ⚠️ NEVER RESOLVED BY GUESSING. A name with no exact id match is skipped and
    // counted; "Thomas Arbuckle" sits beside "Thomas Tarbuck" in PlayHQ's own
    // results and picking one would invent an answer.
    if (!exact.length) { t.ambiguous++; continue; }

    const lio = exact[0].lastInteractedOrganisation;
    if (!lio) { t.none++; continue; }

    const oldId = e.r.from.club, oldName = e.r.from.clubName || '';
    if (lio.id === oldId || (oldName && fold(lio.name) === fold(oldName))) { t.same++; continue; }

    const known = knownIds.has(lio.id) || knownNames.has(fold(lio.name));
    if (known) {
      t.knownClub++;
      if (examples.knownClub.length < 12) {
        examples.knownClub.push(`${pad(e.r.name, 24)} ${pad(e.r.from.compName || '', 11)} ` +
          `${pad(oldName || oldId, 26)} -> ${lio.name}`);
      }
    } else {
      t.unknownOrg++;
      if (examples.unknownOrg.length < 12) {
        examples.unknownOrg.push(`${pad(e.r.name, 24)} ${pad(oldName || oldId, 26)} -> ${lio.name}`);
      }
    }
  }

  const judged = t.same + t.knownClub + t.unknownOrg;
  log('── results ──');
  log(`  SAME club as we hold        : ${t.same}`);
  log(`  a club we KNOW, different   : ${t.knownClub}   ← the only transfer evidence`);
  log(`  an organisation we DO NOT   : ${t.unknownOrg}   ← UNDECIDED — profile these orgs`);
  log(`  field was null              : ${t.none}`);
  log(`  name ambiguous, skipped     : ${t.ambiguous}`);
  log(`  not found / errored         : ${t.notFound} / ${t.error}`);

  if (examples.knownClub.length) {
    log('\n  moved to a club we know:');
    for (const x of examples.knownClub) log(`    ${x}`);
  }
  if (examples.unknownOrg.length) {
    log('\n  a football organisation we have never seen. Feed these ids to');
    log('  probe-org-profile.js: one that runs a real season is very likely a move,');
    log('  one that runs carnivals is a second registration:');
    for (const x of examples.unknownOrg) log(`    ${x}`);
  }

  log('\n═══ WHAT THIS SAYS ═══');
  if (!judged) {
    log('  Nothing was judged. No conclusion.');
  } else {
    const pct = (n) => ((n / judged) * 100).toFixed(1) + '%';
    log(`  Of ${judged} judged, ${pct(t.knownClub)} name a DIFFERENT club we already know.`);
    if (t.knownClub === 0) {
      log('  ⚠️ Thomas Arbuckle appears to be an exception, not a pattern. This field');
      log('     agrees with publicProfileTeams everywhere else sampled, so it is NOT');
      log('     an earlier signal and does not belong in the pipeline.');
    } else {
      log('  Those are players our registration walk has NOTHING for, whose club has');
      log('  changed according to PlayHQ. If the examples above read as real football');
      log('  transfers, this field sees signings before a team is ever formed.');
      log(`  ⚠️ AT THIS RATE, ${Math.round((t.knownClub / judged) * pool.length)} of the ${pool.length} players with nothing recorded`);
      log('     would be flagged. Check the examples before believing that number.');
    }
    if (t.unknownOrg) {
      log(`\n  ⚠️ ${pct(t.unknownOrg)} name a football organisation absent from our data —`);
      log('     another league, another state, or a carnival body. UNDECIDED until');
      log('     each org is profiled. Do not count them either way.');
    }
  }
  const amb = t.ambiguous / (sample.length || 1);
  log(`\n  ⚠️ ${(amb * 100).toFixed(0)}% of names could not be resolved to one profile. Searching by`);
  log('     name cannot be a cohort-wide route until that is solved.');

  phq.logSummary('probe-signings');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
