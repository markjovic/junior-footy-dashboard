#!/usr/bin/env node
// scripts/report-leads.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'report-leads v1 2026-11-21';

//
// What are the `lastOrg` leads actually worth?
//
// The walk now stores `lastInteractedOrganisation` — the club PlayHQ currently
// lists a player at. Measured over the cohort, about 3% differ from the club we
// hold. This report says how many of those are genuinely NEW information and how
// many merely restate a registration we already have.
//
// ⚠️ MOST OF THEM WILL BE RESTATEMENTS, AND THAT IS NOT A FAULT. A player with a
// 2027 registration at a new club naturally has a `lastOrg` naming that club. It
// "differs" from their 2026 club while telling us nothing we did not already
// know. The only rows that ADD anything are those with NOTHING in `tracked`.
//
// ⚠️ A DIFFERENT CLUB IS NOT YET A TRANSFER. data/organisations.json says what
// kind of body each one is:
//
//   league   runs one long season a year        -> very likely a move
//   event    runs carnivals and Nines           -> a second registration
//   mixed    runs both                          -> undecided, say so
//   unknown  not in the repository yet          -> run build-organisations
//
// ⚠️ READ-ONLY. Makes no PlayHQ call and writes nothing to the repo. The CSV
// goes out as a run artifact.
//
// Env: RL_LIMIT (rows printed per section, default 30), RL_OUT (reports).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const ORG_PATH = path.join(ROOT, 'data', 'organisations.json');
const OUT_DIR = path.join(ROOT, process.env.RL_OUT || 'reports');
const LIMIT = Math.max(1, Number(process.env.RL_LIMIT || 30));

const log = (...a) => console.log(...a);
const die = (m, c = 1) => { console.error(`FATAL: ${m}`); process.exit(c); };
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows) => rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';

function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: no PlayHQ call, nothing written to the repo.\n');

  if (!fs.existsSync(REG_PATH)) die('data/registrations.json.gz does not exist.');
  const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));

  let orgs = {};
  if (fs.existsSync(ORG_PATH)) {
    try { orgs = (JSON.parse(fs.readFileSync(ORG_PATH, 'utf8')).organisations) || {}; }
    catch (e) { log(`  ⚠️ organisations.json unreadable: ${e.message}`); }
  } else {
    log('  ⚠️ data/organisations.json does not exist. Every destination will read');
    log('     as "unknown" and NOTHING below can be called a transfer. Run');
    log('     build-organisations first.');
  }
  log(`organisations known: ${Object.keys(orgs).length}`);

  const kindOf = (id) => (orgs[id] && orgs[id].kind) || 'unknown';
  const orgName = (id, fallback) => (orgs[id] && orgs[id].competitions
    && orgs[id].competitions[0] && orgs[id].competitions[0].name) || fallback || id || '';

  // ── Sort every player ──────────────────────────────────────────────────────
  const t = { noLastOrg: 0, same: 0, restates: 0, newLead: 0, unwalked: 0 };
  const byKind = {};
  const leads = [];
  const restated = [];

  for (const [uuid, r] of Object.entries(reg.players || {})) {
    if (!r.at) { t.unwalked++; continue; }
    const lo = r.lastOrg;
    if (!lo || !lo.id) { t.noLastOrg++; continue; }
    const from = r.from || {};
    if (!from.club || lo.id === from.club) { t.same++; continue; }

    const tracked = r.tracked || [];
    // ⚠️ THE WHOLE POINT OF THIS SPLIT. A lastOrg that names a club already in
    // `tracked` adds nothing — we found that registration by the normal route.
    const alreadyKnown = tracked.some(x => x.club === lo.id);
    const row = {
      uuid, name: r.name, fromComp: from.compName, fromClub: from.clubName || from.club,
      toClub: lo.name || lo.id, toId: lo.id, kind: kindOf(lo.id),
      league: orgName(lo.id, ''), trackedCount: tracked.length, at: lo.at || r.at,
    };
    if (alreadyKnown || tracked.length) { t.restates++; restated.push(row); continue; }
    t.newLead++;
    byKind[row.kind] = (byKind[row.kind] || 0) + 1;
    leads.push(row);
  }

  const judged = t.same + t.restates + t.newLead;
  log('\n── every walked player ──');
  log(`  lastOrg matches the club we hold   : ${t.same}`);
  log(`  differs, but we already have a 2027 registration : ${t.restates}`);
  log(`  differs, and we have NOTHING for them            : ${t.newLead}   ← the only new information`);
  log(`  no lastOrg returned                : ${t.noLastOrg}`);
  log(`  never walked                       : ${t.unwalked}`);
  if (judged) log(`\n  new leads are ${((t.newLead / judged) * 100).toFixed(2)}% of ${judged} judged`);

  // ── What kind of club are they heading to? ─────────────────────────────────
  log('\n── the new leads, by what kind of organisation ──');
  for (const k of ['league', 'mixed', 'event', 'unknown']) {
    const n = byKind[k] || 0;
    const note = k === 'league' ? '  ← very likely a real transfer'
      : k === 'event' ? '  ← a carnival or Nines: NOT a move'
      : k === 'mixed' ? '  ← runs both: undecided, do not count either way'
      : '  ← not in organisations.json; run build-organisations';
    log(`  ${pad(k, 8)} ${String(n).padStart(5)}${n ? note : ''}`);
  }

  const likely = leads.filter(x => x.kind === 'league');
  if (likely.length) {
    log(`\n── likely transfers nobody has recorded (${likely.length}) ──`);
    for (const x of likely.slice(0, LIMIT)) {
      log(`  ${pad(x.name, 24)} ${pad(x.fromComp || '', 11)} ${pad(x.fromClub, 28)} -> ${x.toClub}`);
    }
    if (likely.length > LIMIT) log(`  …and ${likely.length - LIMIT} more, all in the CSV`);
  }

  const undecided = leads.filter(x => x.kind === 'mixed' || x.kind === 'unknown');
  if (undecided.length) {
    log(`\n── undecided (${undecided.length}) — these need the organisation profiled ──`);
    const ids = [...new Set(undecided.map(x => x.toId))];
    log(`  ${ids.length} distinct organisation(s). Feed them to build-organisations:`);
    log(`    ${ids.slice(0, 20).join(',')}`);
  }

  // ── CSV ────────────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [['status', 'player', 'uuid', 'from_comp', 'from_club', 'to_club',
    'to_org_id', 'to_org_kind', 'to_league', 'tracked_registrations', 'seen_at']];
  for (const x of leads) rows.push(['new lead', x.name, x.uuid, x.fromComp, x.fromClub,
    x.toClub, x.toId, x.kind, x.league, x.trackedCount, x.at]);
  for (const x of restated) rows.push(['already known', x.name, x.uuid, x.fromComp, x.fromClub,
    x.toClub, x.toId, x.kind, x.league, x.trackedCount, x.at]);
  fs.writeFileSync(path.join(OUT_DIR, 'last-org-leads.csv'), csv(rows));

  log(`\n  Written: ${path.relative(ROOT, OUT_DIR)}/last-org-leads.csv  ${rows.length - 1} row(s)`);
  log("  (not committed — download it from the run's artifact)");
  log('\n  ⚠️ A LEAD IS NOT A TRANSFER. lastOrg carries no season and no date, so');
  log('     none of these can be placed in time. They say only that PlayHQ now');
  log('     lists the player somewhere else.');
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
