#!/usr/bin/env node
// scripts/probe-last-interacted.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-last-interacted v1 2026-11-20';

//
// What does profileSearch's `lastInteractedOrganisation` actually MEAN?
//
// ⚠️ ONE RESULT IS NOT A MEANING. It returns "South Croydon (EFNL)" for Thomas
// Arbuckle, whose every stored team is Norwood. That proves the field exists and
// that it is NOT simply "the last club they played for". It does not tell us
// whether it tracks a REGISTRATION, a game, a profile view, or something else
// entirely — and a field whose meaning is guessed is worse than no field, because
// it will be believed.
//
// So this measures it against cases where WE ALREADY KNOW THE ANSWER, from
// data this repo collected by another route:
//
//   MOVERS   players with a 2027 tracked registration at a DIFFERENT club.
//            If the field means "latest registration", it should name the NEW
//            club for these.
//   STAYERS  players re-signed at the SAME club. It should name that club.
//   QUIET    players with no next-season registration at all. If it names their
//            2026 club, the field is simply "most recent anything" and is no
//            earlier a signal than what we already hold. If it names a club we
//            have never seen, the field knows something we do not — which is the
//            result that would make it worth using.
//
// The verdict is a rate, not an anecdote. Anything below unanimous gets reported
// as the rate it is, with the disagreements printed so they can be read.
//
// ⚠️ IT SEARCHES BY NAME, WHICH IS AMBIGUOUS. "Thomas Arbuckle" sits next to
// "Thomas Tarbuck" in the app's own results. Any name returning more than one
// profile, or one whose id does not match the player we asked about, is SKIPPED
// and counted — never resolved by guessing.
//
// READ-ONLY: nothing is written. One call per sampled player, paced.
//
// Env: PL_SAMPLE (players per group, default 40), PL_PACE_MS (default 900).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const SAMPLE = Math.max(1, Number(process.env.PL_SAMPLE || 40));
const PACE = Math.max(0, Number(process.env.PL_PACE_MS || 900));

const log = (...a) => console.log(...a);
const die = (m, c = 1) => { console.error(`FATAL: ${m}`); process.exit(c); };
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const Q_SEARCH = 'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) ' +
  '{ result { id firstName lastName lastInteractedOrganisation { id name } } } }';

// Club names arrive decorated — "South Croydon (Eastern Football Netball League)"
// against a stored "South Croydon". Compare on the part before the bracket, and
// fold, because only the id is authoritative and we do not always have it.
const fold = (s) => String(s || '').replace(/\s*\([^)]*\)\s*$/, '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function lookup(name) {
  const json = await phq.gqlPost(Q_SEARCH, { fullName: name }, 'ProfileSearch');
  if (json && json.errors && json.errors.length) {
    return { error: String(json.errors[0].message).slice(0, 120) };
  }
  const res = ((json && json.data && json.data.profileSearch) || {}).result || [];
  return { results: res };
}

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: nothing is written.\n');

  if (!fs.existsSync(REG_PATH)) die('data/registrations.json.gz does not exist.');
  const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const clubs = core.clubs || {};
  const clubName = (id) => (clubs[id] && (clubs[id].name || clubs[id])) || '';

  const movers = [], stayers = [], quiet = [];
  for (const [uuid, r] of Object.entries(reg.players || {})) {
    if (!r.at || !r.name || !r.from || !r.from.club) continue;
    const tr = r.tracked || [];
    if (tr.length && tr[0].club && tr[0].club !== r.from.club) movers.push({ uuid, r, to: tr[0] });
    else if (tr.length && tr[0].club === r.from.club) stayers.push({ uuid, r, to: tr[0] });
    else if (!tr.length && !(r.other || []).length) quiet.push({ uuid, r, to: null });
  }
  log(`cohort: ${movers.length} mover(s), ${stayers.length} stayer(s), ${quiet.length} with nothing next`);

  // ⚠️ EVERY NTH, NOT THE FIRST N. The file is in walk order, so the first N
  // share a season and often a club — which would measure one club, not a field.
  const spread = (arr) => {
    const step = Math.max(1, Math.floor(arr.length / SAMPLE));
    const out = [];
    for (let i = 0; i < arr.length && out.length < SAMPLE; i += step) out.push(arr[i]);
    return out;
  };

  await phq.ensureSession();
  const tally = {};

  for (const [group, list] of [['MOVER', spread(movers)], ['STAYER', spread(stayers)], ['QUIET', spread(quiet)]]) {
    log(`\n── ${group} (${list.length} sampled) ──`);
    const t = { matchNew: 0, matchOld: 0, other: 0, none: 0, ambiguous: 0, notFound: 0, error: 0 };
    const disagreements = [];

    for (const e of list) {
      await sleep(PACE);
      let out;
      try { out = await lookup(e.r.name); }
      catch (err) { t.error++; continue; }
      if (out.error) { t.error++; continue; }

      const exact = (out.results || []).filter(p => p.id === e.uuid);
      if (!out.results.length) { t.notFound++; continue; }
      // More than one profile for the name, and none of them is the person we
      // asked about: unusable, and counted as such rather than guessed at.
      if (!exact.length) { t.ambiguous++; continue; }
      if (out.results.length > 1) t.ambiguous++;   // counted, but still measured below

      const lio = exact[0].lastInteractedOrganisation;
      if (!lio) { t.none++; continue; }

      const oldName = e.r.from.clubName || clubName(e.r.from.club);
      const newName = e.to ? (e.to.clubName || clubName(e.to.club)) : '';
      const got = fold(lio.name);

      if (lio.id === e.r.from.club || (oldName && got === fold(oldName))) t.matchOld++;
      else if (e.to && (lio.id === e.to.club || (newName && got === fold(newName)))) t.matchNew++;
      else {
        t.other++;
        if (disagreements.length < 6) {
          disagreements.push(`${pad(e.r.name, 24)} stored old "${oldName}"` +
            (newName ? ` new "${newName}"` : '') + ` -> field says "${lio.name}"`);
        }
      }
    }

    tally[group] = t;
    log(`    names their NEW club   : ${t.matchNew}`);
    log(`    names their OLD club   : ${t.matchOld}`);
    log(`    names some OTHER club  : ${t.other}`);
    log(`    field was null         : ${t.none}`);
    log(`    name ambiguous/skipped : ${t.ambiguous}`);
    log(`    not found / errored    : ${t.notFound} / ${t.error}`);
    for (const d of disagreements) log(`      ${d}`);
  }

  // ── What it means, stated as a rate ────────────────────────────────────────
  log('\n═══ WHAT THIS SAYS ═══');
  const m = tally.MOVER || {}, q = tally.QUIET || {};
  const mTotal = (m.matchNew || 0) + (m.matchOld || 0) + (m.other || 0);
  const rate = mTotal ? (m.matchNew || 0) / mTotal : 0;

  if (!mTotal) {
    log('  No mover produced a usable comparison. Nothing is established.');
  } else if (rate >= 0.95) {
    log(`  For movers it names the NEW club ${(rate * 100).toFixed(0)}% of the time (${m.matchNew}/${mTotal}).`);
    log('  That is consistent with "most recent REGISTRATION", which would make it');
    log('  an earlier signal than a team being formed.');
    log('  ⚠️ CONSISTENT WITH IS NOT THE SAME AS MEANS. It could still be "most');
    log('     recent anything", and the QUIET group below is what separates those.');
  } else {
    log(`  For movers it names the new club only ${(rate * 100).toFixed(0)}% of the time (${m.matchNew}/${mTotal}).`);
    log('  ⚠️ DO NOT USE THIS FIELD as a registration signal. It is measuring');
    log('     something else, and the disagreements above say what.');
  }

  const qTotal = (q.matchOld || 0) + (q.other || 0);
  if (qTotal) {
    const qOther = (q.other || 0) / qTotal;
    log(`\n  Of players with NOTHING next season, ${(qOther * 100).toFixed(0)}% name a club we have`);
    log('  never recorded for them. A high figure there means the field knows about');
    log('  registrations we cannot otherwise see — which is the result worth having.');
    log('  A low one means it is just their old club, and tells us nothing new.');
  }

  log('\n  ⚠️ A SAMPLE IS NOT THE COHORT, and this is one run on one day. Nothing');
  log('     here justifies writing the field into the pipeline on its own.');
  phq.logSummary('probe-last-interacted');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
