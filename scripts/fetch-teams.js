#!/usr/bin/env node
// scripts/fetch-teams.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'fetch-teams v1 2026-11-25';

//
// The season team registry — docs/team_registry_design.md §3.2, build order
// step 3, with the storage and scope revisions in §9 (2026-11-25).
//
// One `discoverTeams` call per season. Writes, per season:
//
//   data/season-teams/<seasonId>.json
//
// and repairs dead logo URLs in core.json's `teamLogos` from the same response.
//
// ⚠️ IT REPLACES refresh-team-logos.js, WHICH MADE THIS EXACT CALL AND THREW
// THE TEAM LIST AWAY. Two scripts calling one endpoint on two schedules is how
// they drift apart. §9.4. Delete that script and its workflow with this.
//
// ── WHY A REGISTRY AT ALL ────────────────────────────────────────────────────
//
// ⚠️ A TEAM WITH NO PLAYERS IS INVISIBLE EVERYWHERE ELSE. The registrations
// walk only ever sees a team THROUGH a player, and discoverTeams cannot return
// members. Measured on SEJ 2027, 2026-11-25: 117 teams here against 59 in
// data/rosters/ — 58 teams the walk could not see. During the registration
// window those are the clubs' shape for next season, forming before anyone has
// played a game.
//
// ⚠️ discoverTeams REACHES A RETIRED SEASON — 969 teams for EFNL 2026, 447 for
// YJFL 2026 — which store.fetchTargets() refuses outright on its first test:
//     if (!m.compName || !m.seasonId || m.retired) continue;
// That is what lets this repair things a results run never can.
//
// ── STORAGE ──────────────────────────────────────────────────────────────────
//
// ⚠️ ONE FILE PER SEASON, AND NOT INSIDE <seasonId>-core.json. That file is
// written WHOLE by store.save, which fetch-results owns; a second writer in it
// is the clobber this repo has already been bitten by. §9.2.
//
// ⚠️ THE ONLY TIMESTAMP IS fetchedAt AND IT IS NOT IN THE COMPARED PAYLOAD. A
// timestamp inside the content makes write-if-changed impossible — the lesson
// build-player-index recorded for generatedAt and build-transfers v13 had to
// learn again for rosters. Files are written only when their teams change.
//
// ── THE QUERY ────────────────────────────────────────────────────────────────
//
// ⚠️ A REJECTED FIELD FAILS THE WHOLE QUERY. `gender` and `ageGroup` are
// documented (playhq_api_reference.md, discoverTeams) but are not load-bearing
// for anything built today, so a rejection must not take the run down with it:
// the first season falls back to a minimal field set, says so loudly, and the
// whole run uses the reduced shape from then on.
//
// Env: FT_SEASONS   comma-separated seasonIDs. Default: every manifest season.
//      FT_DRY       true = print the plan, write nothing.
//      FT_NO_LOGOS  true = registry only, skip the teamLogos repair.
//      FT_NO_VERIFY true = write a logo URL without checking it resolves. Don't.
//      FT_PACE_MS   gap between calls, default 800 (the walk's safe value).
//
// Exit codes: 0 = something changed and was written, 2 = nothing to change,
//             1 = fatal (including: no season answered).

'use strict';

const fs = require('fs');
const path = require('path');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const TEAMS_DIR = path.join(ROOT, process.env.FT_TEAMS_DIR || 'data/season-teams');
const SEASONS = (process.env.FT_SEASONS || '').split(',').map(s => s.trim()).filter(Boolean);
const DRY = /^(1|true|yes)$/i.test(process.env.FT_DRY || '');
const NO_LOGOS = /^(1|true|yes)$/i.test(process.env.FT_NO_LOGOS || '');
const NO_VERIFY = /^(1|true|yes)$/i.test(process.env.FT_NO_VERIFY || '');
const PACE_MS = Math.max(0, Number(process.env.FT_PACE_MS || 800));

const log = (...a) => console.log(...a);
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);

const Q_FULL = `query SeasonTeams($seasonID: ID!) {
  discoverTeams(filter: { seasonID: $seasonID }) {
    id
    name
    gender { value }
    ageGroup { value }
    grade { id name }
    organisation { id name logo { sizes { url } } }
  }
}`;

// The fields nothing here can do without.
const Q_MIN = `query SeasonTeams($seasonID: ID!) {
  discoverTeams(filter: { seasonID: $seasonID }) {
    id
    name
    grade { id name }
    organisation { id name logo { sizes { url } } }
  }
}`;

// /production/afl/<uuid>/<version>/logo.<ext> — the first eight hex characters
// of that uuid are the organisation code. Anchored on the path segment, because
// the host and the transform contain hex-ish text too.
function orgOfUrl(u) {
  const m = /\/production\/[^/]+\/([0-9a-f]{8})[0-9a-f-]*\//i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : null;
}
// The pixel size baked into a Cloudinary transform, e.g. h_96,w_96 → 96.
const sizeOfUrl = (u) => {
  const m = /\/h_(\d+),w_\1\//.exec(String(u || ''));
  return m ? Number(m[1]) : null;
};
// ⚠️ PRESERVE THE RENDITION. Keys hold a mix of h_64 and h_96 and the page
// sizes its crests from whichever it gets; normalising them all to one size
// would change crest sharpness across the dashboard for no reason.
function pickRendition(urls, wantSize) {
  if (!urls.length) return null;
  if (wantSize) {
    const exact = urls.find(u => sizeOfUrl(u) === wantSize);
    if (exact) return exact;
  }
  const ninetySix = urls.find(u => sizeOfUrl(u) === 96);
  if (ninetySix) return ninetySix;
  return urls.slice().sort((a, b) => (sizeOfUrl(b) || 0) - (sizeOfUrl(a) || 0))[0];
}

const _checked = new Map();
async function resolves(u) {
  if (_checked.has(u)) return _checked.get(u);
  let r;
  try {
    const res = await fetch(u, { method: 'GET' });
    r = { status: res.status, ok: res.status === 200, checked: true };
  } catch (e) {
    // ⚠️ "COULD NOT CHECK" IS NOT "DEAD", and must not be written either way.
    r = { status: `unreachable (${e.message})`, ok: false, checked: false };
  }
  _checked.set(u, r);
  return r;
}

async function main() {
  log(`=== ${VERSION} (${phq.LIB_VERSION}, store ${store.STORE_VERSION}) ===`);
  if (DRY) log('DRY RUN — nothing will be written.');
  if (NO_LOGOS) log('FT_NO_LOGOS — the registry only; teamLogos will not be touched.');
  if (NO_VERIFY) {
    log('⚠️ FT_NO_VERIFY IS SET. Logo URLs will be written WITHOUT checking they');
    log('   resolve, which is how the dead ones got there in the first place.');
  }
  log('');

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  if (!manifest.length) { console.error('FATAL: no seasons in the manifest.'); process.exit(1); }
  const teamLogos = core.teamLogos || {};

  const targets = SEASONS.length ? manifest.filter(m => SEASONS.includes(m.seasonId)) : manifest;
  if (!targets.length) { console.error('FATAL: FT_SEASONS matched no manifest entry.'); process.exit(1); }
  log(`seasons to ask: ${targets.length} (one call each)\n`);

  await phq.ensureSession();

  // ── Ask each season ───────────────────────────────────────────────────────
  let query = Q_FULL, reduced = false;
  const bySeason = new Map();        // sid -> { compName, teams }
  const liveByOrg = new Map();       // org8 -> [urls]
  let asked = 0, failed = 0, totalTeams = 0;

  for (const m of targets) {
    let json;
    try { json = await phq.gqlPost(query, { seasonID: m.seasonId }, 'SeasonTeams'); }
    catch (e) { log(`  ${pad(m.compName, 14)} call failed — ${e.message}`); failed++; continue; }
    if (PACE_MS) await phq.sleep(PACE_MS);

    // ⚠️ FALL BACK ONCE, THEN STAY REDUCED. An optional field that this schema
    // does not have would otherwise fail all 21 seasons, one at a time, and a
    // nightly job would die on a field nothing depends on.
    if (json && json.errors && json.errors.length && !reduced) {
      const msg = String(json.errors[0].message || '');
      log(`  ${pad(m.compName, 14)} full query rejected — ${msg.slice(0, 110)}`);
      log('    ⚠️ FALLING BACK to the minimal field set for the WHOLE run. gender');
      log('       and ageGroup are not stored by this run; everything else is.');
      query = Q_MIN; reduced = true;
      try { json = await phq.gqlPost(query, { seasonID: m.seasonId }, 'SeasonTeams'); }
      catch (e) { log(`  ${pad(m.compName, 14)} minimal query also failed — ${e.message}`); failed++; continue; }
      if (PACE_MS) await phq.sleep(PACE_MS);
    }
    if (json && json.errors && json.errors.length) {
      log(`  ${pad(m.compName, 14)} rejected — ${String(json.errors[0].message).slice(0, 110)}`);
      failed++;
      continue;
    }

    asked++;
    const rows = (json && json.data && json.data.discoverTeams) || [];
    totalTeams += rows.length;
    const teams = {};
    let graded = 0;
    for (const t of rows) {
      if (!t || !t.id) continue;
      const o = t.organisation || {};
      const e = { name: t.name || null, org: o.id ? String(o.id).toLowerCase() : null,
        orgName: o.name || null };
      if (t.grade && (t.grade.id || t.grade.name)) {
        e.grade = t.grade.name || null;
        e.gradeId = t.grade.id || null;
        graded++;
      }
      if (t.ageGroup && t.ageGroup.value) e.age = t.ageGroup.value;
      if (t.gender && t.gender.value) e.gender = t.gender.value;
      teams[t.id] = e;

      // The logo half, from the same response.
      const urls = ((o.logo && o.logo.sizes) || []).map(x => x && x.url).filter(Boolean);
      if (o.id && urls.length && !liveByOrg.has(String(o.id).toLowerCase())) {
        liveByOrg.set(String(o.id).toLowerCase(), urls);
      }
    }
    bySeason.set(m.seasonId, { compName: m.compName, teams });
    log(`  ${pad(m.compName, 14)} ${String(rows.length).padStart(4)} team(s), ` +
      `${graded} graded, ${new Set(Object.values(teams).map(x => x.org).filter(Boolean)).size} club(s)`);
  }

  log(`\nasked ${asked} season(s), ${totalTeams} team record(s)` +
    (failed ? `, ${failed} FAILED` : '') + (reduced ? ' — reduced field set' : ''));

  // ⚠️ A COLLECTION FAILURE MUST NOT LOOK LIKE "NOTHING CHANGED". Writing an
  // empty registry over a good one would delete every team we know about.
  if (!asked) {
    log('\n⚠️ NO SEASON ANSWERED. Nothing is written and this exits 1 so the run');
    log('   shows red, rather than quietly reporting that nothing changed.');
    phq.logSummary();
    process.exit(1);
  }

  // ── Write the registry, per season, only where it changed ────────────────
  let wrote = 0, unchanged = 0, bytes = 0;
  const plan = [];
  for (const [sid, se] of bySeason) {
    // fetchedAt is deliberately OUTSIDE the compared payload.
    const payload = JSON.stringify({ version: 1, seasonId: sid, compName: se.compName,
      teams: se.teams });
    const f = path.join(TEAMS_DIR, `${sid}.json`);
    let same = false, before = 0;
    if (fs.existsSync(f)) {
      try {
        const prev = JSON.parse(fs.readFileSync(f, 'utf8'));
        before = Object.keys(prev.teams || {}).length;
        const { fetchedAt, ...rest } = prev;
        same = JSON.stringify(rest) === payload;
      } catch (e) { same = false; }
    }
    const now = Object.keys(se.teams).length;
    bytes += payload.length;
    if (same) { unchanged++; continue; }
    wrote++;
    plan.push({ sid, comp: se.compName, before, now, f,
      out: JSON.stringify({ version: 1, seasonId: sid, compName: se.compName,
        fetchedAt: new Date().toISOString(), teams: se.teams }) });
  }

  log(`\nregistry: ${wrote} season file(s) changed, ${unchanged} unchanged, ` +
    `${Math.round(bytes / 1024)} KB total`);
  for (const p of plan) {
    log(`  ${pad(p.comp, 14)} ${p.before} → ${p.now} team(s)` +
      (p.now > p.before ? `  (+${p.now - p.before})` : p.now < p.before ? `  (${p.now - p.before})` : ''));
  }

  if (!DRY && wrote) {
    fs.mkdirSync(TEAMS_DIR, { recursive: true });
    for (const p of plan) fs.writeFileSync(p.f, p.out);
    log(`  Wrote ${path.relative(ROOT, TEAMS_DIR)}/ — ${wrote} file(s)`);
  }

  // ── Repair dead logo URLs from the same response ─────────────────────────
  let logoWrote = 0;
  if (NO_LOGOS) {
    log('\nlogos: skipped (FT_NO_LOGOS).');
  } else {
    const keys = Object.keys(teamLogos);
    log(`\nlogos: ${keys.length} stored key(s), ${liveByOrg.size} club(s) with a live logo`);
    const planned = [];
    let sameAlready = 0, noLive = 0, unreadable = 0;
    for (const k of keys) {
      const from = teamLogos[k];
      const org = orgOfUrl(from);
      if (!org) { unreadable++; continue; }
      const urls = liveByOrg.get(org);
      if (!urls) { noLive++; continue; }
      const to = pickRendition(urls, sizeOfUrl(from));
      if (!to || to === from) { sameAlready++; continue; }
      planned.push({ key: k, from, to, org });
    }
    log(`  ${planned.length} key(s) differ, ${sameAlready} already current, ` +
      `${noLive} with no live logo${unreadable ? `, ${unreadable} unreadable URL(s)` : ''}`);

    if (planned.length) {
      const byOrg = new Map();
      for (const p of planned) {
        if (!byOrg.has(p.org)) byOrg.set(p.org, []);
        byOrg.get(p.org).push(p);
      }
      const good = [];
      for (const [org, rows] of byOrg) {
        // ⚠️ A URL IS NOT TRUSTED UNTIL IT RESOLVES. PlayHQ returning a string
        // is not evidence the image exists — a well-formed URL that 404s is the
        // exact fault being repaired.
        const vNew = NO_VERIFY ? { status: 'not checked', ok: true, checked: false } : await resolves(rows[0].to);
        const vOld = NO_VERIFY ? { status: 'not checked', ok: false, checked: false } : await resolves(rows[0].from);
        log(`    ${org}  ${rows.length} key(s)  old ${vOld.checked ? 'HTTP ' + vOld.status : vOld.status}` +
          `  new ${vNew.checked ? 'HTTP ' + vNew.status : vNew.status}`);
        if (vNew.ok) good.push(...rows);
        else log('      ⇒ SKIPPED — the replacement does not resolve, so the dead URL stays.' +
          (vNew.checked ? '' : ' It could not be checked from here, which is not the same as dead.'));
      }
      if (good.length && !DRY) {
        // ⚠️ MERGE, NEVER REPLACE. A run over a subset of seasons must not drop
        // the keys it did not see — this defect has been fixed four times in
        // four writers in this repo.
        const next = { ...teamLogos };
        for (const g of good) next[g.key] = g.to;
        const data = store.load(null, { players: false });
        data.teamLogos = next;
        store.saveCore(data);
        logoWrote = good.length;
        log(`  Wrote data/core.json — ${good.length} teamLogos entr${good.length === 1 ? 'y' : 'ies'} ` +
          `refreshed, ${Object.keys(next).length} total (unchanged keys passed through).`);
      } else if (good.length) {
        log(`  DRY RUN — ${good.length} key(s) would be refreshed.`);
      } else {
        log('  nothing verified — teamLogos untouched.');
      }
    }
  }

  if (DRY) { log('\nDRY RUN — nothing written.'); phq.logSummary(); process.exit(0); }
  phq.logSummary();
  process.exit(wrote || logoWrote ? 0 : 2);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
