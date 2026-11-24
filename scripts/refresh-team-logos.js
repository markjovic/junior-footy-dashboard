#!/usr/bin/env node
// scripts/refresh-team-logos.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'refresh-team-logos v1 2026-11-25';

//
// Rewrites the dead Cloudinary URLs in core.json's `teamLogos`, for clubs that
// have replaced their logo file since the season those URLs came from.
//
// ⚠️ WHY THE EXISTING MACHINERY CANNOT DO THIS — all measured, 2026-11-24/25.
//
// Logos only enter `teamLogos` from `hLogo`/`aLogo` on match records, harvested
// by results-engine.js during a results fetch. store.fetchTargets() drops a
// retired season on its FIRST test:
//
//   if (!m.compName || !m.seasonId || m.retired) continue;
//
// Every 2026 season is retired, so no results run will ever read them again —
// `ignore_season_gate` only adds non-retired COMPLETE seasons, and a dispatch
// with it set (run #533) fetched the 2027 seasons, which have no games and
// therefore no logos. The map is frozen, and the 2027 fetch in April will write
// keys for 2027 team names, not for `Norwood U12 Purple`.
//
// Norwood replaced its file. Stored:   /1696902165682/logo.png  → HTTP 404
//                             Live:    /1792369430765/logo.jpg  → HTTP 200
// A new version stamp AND a new extension, so nothing about the old string can
// be patched into the new one. 27 keys held the dead URL.
//
// ⚠️ discoverTeams REACHES A RETIRED SEASON. 969 teams for EFNL 2026, 447 for
// YJFL 2026 — exactly the seasons fetchTargets refuses. That is what makes this
// buildable at all. (playhq_api_reference.md §8 measured the same on COMPLETED
// seasons in August.)
//
// ⚠️ THE LOGO IS ON THE ORGANISATION, NOT THE TEAM, and its shape is:
//     organisation { id logo { sizes { url } } }
//   `logo` is type `Image`; `Image.sizes` is `[ImageSource!]!`; `ImageSource`
//   has `url` and nothing else useful — width, height, src, path and key are
//   all rejected on it. Six renditions come back: h_32, h_48, h_64, h_96,
//   h_128, h_256.
//
// ── HOW IT MATCHES, AND WHY NOT BY NAME ──────────────────────────────────────
//
// ⚠️ IT REWRITES BY ORGANISATION, NEVER BY TEAM NAME. `teamLogos` is keyed by
// the MATCH team name — `Norwood Purple`, `Norwood`, `Norwood Gold/Heathmont` —
// while discoverTeams returns PlayHQ's own team names — `Norwood U8 Purple`.
// Keying off the API name would add new keys nothing looks up and leave every
// dead key exactly where it is. So:
//
//   1. the organisation's UUID is already IN the stored URL, under
//      /production/afl/<uuid>/<version>/logo.<ext>, and its first eight hex
//      characters are the 8-character organisation code (README, club index).
//   2. discoverTeams gives organisation.id — that same 8-character code — with
//      the CURRENT url.
//   3. so every stored key whose URL belongs to an organisation we now have a
//      live URL for is rewritten in place. Same keys, same count, fresh URLs.
//
// ⚠️ THE RENDITION IS PRESERVED. Keys currently hold a mix of h_64 and h_96,
// and the page sizes its crests from whichever it gets. The replacement picks
// the rendition matching the size already in that key's URL, falling back to
// h_96. Rewriting everything to one size would silently change crest sharpness
// across the dashboard for no reason anybody asked for.
//
// ⚠️ IT MERGES, IT NEVER REPLACES THE MAP. A run over a subset of seasons must
// not drop the team names it did not see — that defect has been fixed four
// times in four writers in this repo. Only keys with a confirmed live
// replacement are touched; every other key is passed through untouched.
//
// ⚠️ A URL IS NOT TRUSTED UNTIL IT RESOLVES. PlayHQ returning a string is not
// evidence the image exists — the whole fault being repaired is a well-formed
// URL that 404s. Each candidate is fetched once and only a 200 is written.
// RL_NO_VERIFY=true skips that, and says so loudly.
//
// Env: RL_SEASONS   comma-separated seasonIDs. Default: every season in the
//                   manifest with a compName, which is one call each.
//      RL_DRY       true = print the plan and write nothing.
//      RL_NO_VERIFY true = write a URL without checking it resolves. Don't.
//      RL_PACE_MS   gap between calls, default 800 (the walk's safe value).
//
// Exit codes: 0 = changed and written, 2 = nothing to change, 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const SEASONS = (process.env.RL_SEASONS || '').split(',').map(s => s.trim()).filter(Boolean);
const DRY = /^(1|true|yes)$/i.test(process.env.RL_DRY || '');
const NO_VERIFY = /^(1|true|yes)$/i.test(process.env.RL_NO_VERIFY || '');
const PACE_MS = Math.max(0, Number(process.env.RL_PACE_MS || 800));

const log = (...a) => console.log(...a);
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);

const Q_TEAMS = `query TeamLogos($seasonID: ID!) {
  discoverTeams(filter: { seasonID: $seasonID }) {
    id
    organisation { id logo { sizes { url } } }
  }
}`;

// /production/afl/<uuid>/<version>/logo.<ext> — the first eight hex characters
// of that uuid are the organisation code. Anchored on the path segment rather
// than "the first 8 hex in the string", because the host and the transform
// contain hex-ish text too.
function orgOfUrl(u) {
  const m = /\/production\/[^/]+\/([0-9a-f]{8})[0-9a-f-]*\//i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : null;
}

// The pixel size baked into a Cloudinary transform, e.g. h_96,w_96 → 96.
const sizeOfUrl = (u) => {
  const m = /\/h_(\d+),w_\1\//.exec(String(u || ''));
  return m ? Number(m[1]) : null;
};

// Pick the rendition that matches the size the stored URL already used.
function pickRendition(urls, wantSize) {
  if (!urls.length) return null;
  if (wantSize) {
    const exact = urls.find(u => sizeOfUrl(u) === wantSize);
    if (exact) return exact;
  }
  const byNinetySix = urls.find(u => sizeOfUrl(u) === 96);
  if (byNinetySix) return byNinetySix;
  // Largest available, so a fallback is never a thumbnail behind a crest.
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
  if (NO_VERIFY) {
    log('⚠️ RL_NO_VERIFY IS SET. URLs will be written WITHOUT checking they');
    log('   resolve, which is how the dead URLs this script exists to fix got');
    log('   there. Use it only to isolate a network problem.');
  }
  log('');

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  if (!manifest.length) { console.error('FATAL: no seasons in the manifest.'); process.exit(1); }
  const teamLogos = core.teamLogos || {};
  const keys = Object.keys(teamLogos);
  if (!keys.length) {
    log('core.json holds no teamLogos. Nothing to refresh — this script repairs');
    log('existing entries and deliberately does not invent new ones.');
    process.exit(2);
  }

  // Which organisations are represented in the stored map, and at what sizes.
  const storedByOrg = new Map();   // org8 -> [keys]
  let unparsed = 0;
  for (const k of keys) {
    const o = orgOfUrl(teamLogos[k]);
    if (!o) { unparsed++; continue; }
    if (!storedByOrg.has(o)) storedByOrg.set(o, []);
    storedByOrg.get(o).push(k);
  }
  log(`stored: ${keys.length} key(s) across ${storedByOrg.size} organisation(s)` +
    (unparsed ? `; ${unparsed} key(s) have a URL this cannot read an organisation from` : ''));

  const targets = SEASONS.length
    ? manifest.filter(m => SEASONS.includes(m.seasonId))
    : manifest;
  if (!targets.length) { console.error('FATAL: RL_SEASONS matched no manifest entry.'); process.exit(1); }
  log(`seasons to ask: ${targets.length} (one call each)\n`);

  await phq.ensureSession();

  // ── Collect the current URL per organisation ─────────────────────────────
  const liveByOrg = new Map();     // org8 -> [urls]
  let asked = 0, teamsSeen = 0, failed = 0;
  for (const m of targets) {
    let json;
    try { json = await phq.gqlPost(Q_TEAMS, { seasonID: m.seasonId }, 'TeamLogos'); }
    catch (e) { log(`  ${pad(m.compName, 14)} call failed — ${e.message}`); failed++; continue; }
    asked++;
    if (PACE_MS) await phq.sleep(PACE_MS);
    if (json && json.errors && json.errors.length) {
      log(`  ${pad(m.compName, 14)} rejected — ${String(json.errors[0].message).slice(0, 110)}`);
      failed++;
      continue;
    }
    const teams = (json && json.data && json.data.discoverTeams) || [];
    teamsSeen += teams.length;
    let gained = 0;
    for (const t of teams) {
      const o = t.organisation;
      if (!o || !o.id) continue;
      const urls = ((o.logo && o.logo.sizes) || []).map(s => s && s.url).filter(Boolean);
      if (!urls.length) continue;
      const id = String(o.id).toLowerCase();
      if (!liveByOrg.has(id)) { liveByOrg.set(id, urls); gained++; }
    }
    log(`  ${pad(m.compName, 14)} ${String(teams.length).padStart(4)} team(s), ` +
      `${gained} new organisation(s) with a logo`);
  }

  log(`\nasked ${asked} season(s), ${teamsSeen} team record(s), ` +
    `${liveByOrg.size} organisation(s) with a live logo` +
    (failed ? `; ${failed} season(s) FAILED` : ''));

  // ⚠️ A COLLECTION FAILURE MUST NOT LOOK LIKE "NOTHING CHANGED". If every
  // season failed there is no evidence of anything, and writing on that basis
  // would be writing a fiction.
  if (!liveByOrg.size) {
    log('\n⚠️ NO ORGANISATION RETURNED A LOGO. That is a collection failure, not a');
    log('   clean bill of health — nothing is written and this exits 1 so the run');
    log('   shows red rather than passing quietly.');
    phq.logSummary();
    process.exit(1);
  }

  // ── Work out the replacements ────────────────────────────────────────────
  const planned = [];      // { key, from, to, org }
  const deadNoFix = [];    // stored URL dead, no live replacement found
  let sameAlready = 0, noLive = 0;
  for (const k of keys) {
    const from = teamLogos[k];
    const org = orgOfUrl(from);
    if (!org) continue;
    const urls = liveByOrg.get(org);
    if (!urls) { noLive++; continue; }
    const to = pickRendition(urls, sizeOfUrl(from));
    if (!to) { noLive++; continue; }
    if (to === from) { sameAlready++; continue; }
    planned.push({ key: k, from, to, org });
  }

  log(`\n${planned.length} key(s) would change, ${sameAlready} already current, ` +
    `${noLive} with no live logo to compare against.`);

  if (!planned.length) {
    log('Nothing to do.');
    phq.logSummary();
    process.exit(2);
  }

  // ── Verify every replacement actually resolves ───────────────────────────
  const byOrg = new Map();
  for (const p of planned) {
    if (!byOrg.has(p.org)) byOrg.set(p.org, []);
    byOrg.get(p.org).push(p);
  }
  log(`\n── the ${byOrg.size} organisation(s) whose logo has moved ──`);
  const good = [];
  for (const [org, rows] of byOrg) {
    const to = rows[0].to;
    const vNew = NO_VERIFY ? { status: 'not checked', ok: true, checked: false } : await resolves(to);
    const vOld = NO_VERIFY ? { status: 'not checked', ok: false, checked: false } : await resolves(rows[0].from);
    log(`  ${org}  ${rows.length} key(s)`);
    log(`    old ${vOld.checked ? 'HTTP ' + vOld.status : vOld.status}  ${rows[0].from}`);
    log(`    new ${vNew.checked ? 'HTTP ' + vNew.status : vNew.status}  ${to}`);
    if (vNew.ok) good.push(...rows);
    else log('    ⇒ SKIPPED — the replacement does not resolve, so the dead URL stays.' +
      (vNew.checked ? '' : ' It could not be checked from here, which is not the same as dead.'));
  }

  log(`\n${good.length} key(s) across ${new Set(good.map(g => g.org)).size} organisation(s) ` +
    `have a verified live replacement.`);
  const skipped = planned.length - good.length;
  if (skipped) log(`${skipped} key(s) were NOT updated because the new URL did not resolve.`);

  if (!good.length) { log('Nothing verified — nothing written.'); phq.logSummary(); process.exit(2); }

  // Show a sample of the keys, so a wrong match is visible before it is written.
  log('\nkeys to be rewritten (first 12):');
  for (const g of good.slice(0, 12)) log(`  ${g.key}`);
  if (good.length > 12) log(`  … and ${good.length - 12} more`);

  if (DRY) { log('\nDRY RUN — not written.'); phq.logSummary(); process.exit(0); }

  // ── Write, through store.saveCore, merging into the existing map ─────────
  // ⚠️ store.saveCore WRITES ONLY CORE_KEYS and passes the manifest through
  // untouched. teamLogos is a CORE_KEY. The map handed to it is the stored one
  // with individual values replaced — never a freshly built object, which is
  // how a partial run would silently drop every key it did not see.
  const next = { ...teamLogos };
  for (const g of good) next[g.key] = g.to;
  const data = store.load(null, { players: false });
  data.teamLogos = next;
  const res = store.saveCore(data);
  log(`\nWrote ${res.written.join(', ')} — ${good.length} teamLogos entr${good.length === 1 ? 'y' : 'ies'} refreshed, ` +
    `${Object.keys(next).length} total (unchanged keys passed through).`);
  phq.logSummary();
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
