#!/usr/bin/env node
// scripts/fetch-career-stats.js
//
// One shard of the career walk — career_stats_design.md revision 3.
//
//   node scripts/fetch-career-stats.js --shard=00 [--force] [--limit=N]
//
// Reads players/<shard>/*.json, fetches publicProfileStatistics for the ones
// that are due, writes each player's file back, and writes ONE summary file that
// the aggregator reads. It does NOT touch git and it does NOT read any other
// shard, so 256 of these run in parallel with disjoint write sets.
//
// TWO RATE MECHANISMS, and they are different things (§3):
//   * a per-session JWT quota on this operation, ~30-35 calls, which a SESSION
//     REFRESH RESETS. That is what the batch of 30 is for.
//   * the CloudFront WAF behind it, which a refresh does NOT reset. That is what
//     ends the job. A fresh runner has been observed doing anywhere between
//     ~1,230 calls and ~26 depending on how long the account had been sweeping,
//     so nothing here assumes a fixed allowance — it fires until blocked.
//
// ⚠️ lib/playhq.js ABSORBS A WAF BLOCK. gqlPost detects the HTML 403, sleeps 80s
// and retries, up to four attempts. So a block does not surface as an error and
// cannot be caught. It IS counted, so this watches summary().blocked across each
// batch and stops after the batch in which it rises. Some calls in that batch
// will have succeeded after the wait; their results are kept.
//
// ⚠️ DEDUPLICATE BY game.id BEFORE COUNTING ANYTHING. The same game comes back
// under several gradeStatistics entries — measured on basketball-victoria
// 2026-08-04, where a mid-season regrade produced two grade entries under one
// team carrying IDENTICAL season-cumulative statistics. Both `lines` and the
// single-game records are wrong without this.
//
// ⚠️ NEVER WRITE OUTSIDE players/<shard>/. The workflow uses a narrow sparse
// checkout, and any path outside the sparse set carries skip-worktree, so
// `git add` silently drops it with no error.
//
// Exit codes: 0 = ran (blocked or not — a block is not a failure). 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');
const playhq = require('./lib/playhq');
const { gqlPost, sleep, refreshSession } = playhq;

const VERSION = 'fetch-career-stats v6 2026-09-11 held-needs-compname';
const FILE_VERSION = 1;

const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'data', 'core.json');

const BATCH = Math.max(1, Number(process.env.CAREER_BATCH || 30));
const MAX_AGE_DAYS = Math.max(1, Number(process.env.CAREER_MAX_AGE_DAYS || 150));
const BATCH_GAP_MS = Math.max(0, Number(process.env.CAREER_BATCH_GAP_MS || 1000));
const TIME_BUDGET_MS = Math.max(1, Number(process.env.CAREER_TIME_BUDGET_MS || 45 * 60 * 1000));
const DAY_MS = 86400000;

const log = (...a) => console.log(...a);

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const SHARD = argOf('shard');
const FORCE = argv.includes('--force');
const LIMIT = Number(argOf('limit') || 0);

// ── The query — the measured base plus the round fields ──────────────────────
// `season { … competition { id name } }` is MEASURED accepted and populated on
// every registration including outside leagues (2026-09-10); it is the only
// source of a league name, because both name fields are bare years.
//
// `careerStatistics { totalStatistics … }` is MEASURED accepted and populated.
// ⚠️ It INCLUDES FORFEITS. Decided 2026-09-10: take PlayHQ's policy.
//
// ⚠️ `round { number isFinalsRound }` are carried from sports-players-stats,
// whose deployed query asks for them and has never had a validation error — so
// the FIELDS EXIST. That project never reads them, so whether they are
// POPULATED here is unknown. The round number falls back to a regex on `name`,
// and the first ten rounds seen are logged raw so the first run answers it.
const Q = `
query publicProfileStatistics($profileID: ID!) {
  publicProfileStatistics(profileID: $profileID) {
    careerStatistics { totalStatistics { count details { value } } }
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
                round { name number isFinalsRound abbreviatedName }
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
}`;

// The public profile page for a uuid. Printed beside every negative so a claim
// that PlayHQ has nothing for a player can be checked in a browser in one click,
// rather than taken on trust from a log. `?tenant=afl` is what makes it resolve.
const profileUrl = (uuid) => `https://www.playhq.com/public/profile/${uuid}/statistics?tenant=afl`;

const statOf = (arr, value) => {
  for (const s of (arr || [])) if (s && s.details && s.details.value === value) return s.count || 0;
  return 0;
};

// ── Parse one profile answer into the stored shape ───────────────────────────
// heldIds decides `held`; everything else comes from the response.
function parseProfile(json, heldIds, roundSamples) {
  const block = json && json.data ? json.data.publicProfileStatistics : null;
  if (!block) return null;

  const seasons = [];
  // ONE Set across the whole player, not per registration: the duplicate form
  // measured elsewhere is two grade entries under one team, and a per-grade Set
  // would not catch it.
  const seenGames = new Set();
  let bestHeld = null, bestAny = null;
  let earliest = null;

  for (const b of (block.seasonStatistics || [])) {
    const year = b.name || null;
    if (year && (!earliest || String(year) < String(earliest))) earliest = year;
    for (const reg of (b.statistics || [])) {
      const s = reg.season || {};
      const sid = s.id || null;
      const held = !!(sid && heldIds.has(sid));
      const grades = [];
      let lines = 0;

      for (const t of (reg.teamStatistics || [])) {
        for (const gs of (t.gradeStatistics || [])) {
          if (gs.grade && gs.grade.name) grades.push(gs.grade.name);
          for (const line of (gs.gameStatistics || [])) {
            const g = line.game || {};
            if (!g.id || seenGames.has(g.id)) continue;   // ⚠️ the dedup
            seenGames.add(g.id);
            lines++;
            if (roundSamples.length < 10 && g.round) roundSamples.push(g.round);
            const goals = statOf(line.statistics, 'GOAL_COUNT');
            const rec = { v: goals, gameId: g.id, sid };
            if (!bestAny || goals > bestAny.v) bestAny = rec;
            if (held && (!bestHeld || goals > bestHeld.v)) bestHeld = rec;
          }
        }
      }

      seasons.push({
        year,
        sid,
        league: s.competition ? s.competition.name : null,
        leagueId: s.competition ? s.competition.id : null,
        club: reg.club ? reg.club.name : null,
        clubId: reg.club ? reg.club.id : null,
        grade: grades.length ? grades[0] : null,
        grades: grades.length > 1 ? grades : undefined,
        status: s.status ? s.status.value : null,
        gp: statOf(reg.totalStatistics, 'APPEARANCE'),
        goals: statOf(reg.totalStatistics, 'GOAL_COUNT'),
        best: statOf(reg.totalStatistics, 'BEST_PLAYER'),
        held,
        lines,
      });
    }
  }

  const ct = block.careerStatistics ? block.careerStatistics.totalStatistics : null;
  const career = {
    gp: statOf(ct, 'APPEARANCE'),
    goals: statOf(ct, 'GOAL_COUNT'),
    best: statOf(ct, 'BEST_PLAYER'),
    from: earliest,
  };

  // §9 step 1, folded in rather than given its own dispatch: does the sum of the
  // per-registration totals equal PlayHQ's own career total? A disagreement means
  // either a season PlayHQ counts and does not list, or the regrade double-count
  // reaching the registration level. Stored so the first sweep measures it across
  // 70,000 people instead of twenty.
  const summed = seasons.reduce((a, s) => a + (s.gp || 0), 0);
  const drift = summed - career.gp;

  const records = {};
  if (bestHeld) records.goalsHeld = bestHeld;
  if (bestAny) records.goalsAny = bestAny;

  return { seasons, career, records, drift, games: seenGames.size };
}

// ── Which players in this shard are due ──────────────────────────────────────
function dueFiles(dir, nowMs) {
  const out = [];
  let total = 0, missingStub = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    total++;
    const p = path.join(dir, name);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { missingStub++; continue; }          // corrupt: leave it, do not fetch blindly
    const uuid = rec.uuid || name.replace(/\.json$/, '');
    if (FORCE) { out.push({ uuid, p, rec, why: 'force' }); continue; }
    if (rec.refetch) { out.push({ uuid, p, rec, why: 'flagged' }); continue; }
    if (!rec.statsChecked) { out.push({ uuid, p, rec, why: 'never' }); continue; }
    const at = Date.parse(rec.statsChecked);
    if (!Number.isFinite(at) || nowMs - at > MAX_AGE_DAYS * DAY_MS) {
      out.push({ uuid, p, rec, why: 'stale' });
    }
  }
  // Never checked first, then flagged, then oldest — so a truncated run always
  // makes progress on the players that have nothing at all.
  const rank = { never: 0, flagged: 1, force: 2, stale: 3 };
  out.sort((a, b) => (rank[a.why] - rank[b.why])
    || String(a.rec.statsChecked || '').localeCompare(String(b.rec.statsChecked || '')));
  return { due: out, total, unreadable: missingStub };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const startMs = Date.now();
  log(`=== ${VERSION} ===`);

  if (!SHARD || !/^[0-9a-f]{2}$/.test(SHARD)) {
    console.error('Usage: node scripts/fetch-career-stats.js --shard=<00-ff> [--force] [--limit=N]');
    process.exit(1);
  }
  const dir = path.join(ROOT, 'players', SHARD);
  const summaryPath = path.join(ROOT, `career-summary-${SHARD}.json`);

  // ⚠️ A SHARD WITH NOTHING TO DO MUST STILL WRITE A SUMMARY. The aggregator
  // treats a missing summary as a crashed job and carries the shard forward for
  // ever; silence and success must not look the same.
  const summary = {
    version: FILE_VERSION, script: VERSION, shard: SHARD,
    players: 0, due: 0, checked: 0, written: 0, notFound: 0, noStats: 0, errors: 0, serverErrors: 0,
    remaining: 0, blocked: false, batches_completed: 0, blocked_at_call: null,
    drifted: 0, ranAt: new Date().toISOString(),
    // Up to five uuids per negative kind. The counts alone ask to be taken on
    // trust; these let the aggregator print one checkable list for the whole
    // sweep rather than a person opening 256 jobs to find them.
    samples: {},
  };
  const writeSummary = () => fs.writeFileSync(summaryPath, JSON.stringify(summary));

  if (!fs.existsSync(dir)) {
    log(`players/${SHARD}/ does not exist — nothing to walk.`);
    writeSummary();
    process.exit(0);
  }

  let heldIds = new Set();
  try {
    const core = JSON.parse(fs.readFileSync(CORE_PATH, 'utf8'));
    // ⚠️ A MANIFEST ENTRY IS NOT A SEASON WE STORE.
    // discover-seasons records seasons for all 17 organisations, tracked and
    // watched, so the manifest holds 65 season ids while only 18 have data on
    // disk. Filtering on seasonId alone marked a VAFA or Frankston season `held`,
    // which made it bright and CLICKABLE on the career table — opening a season
    // this dashboard has never fetched. build-player-index.js already filters on
    // both fields for the same reason. Measured 2026-09-11: 18 competitions came
    // back as held instead of 5.
    heldIds = new Set((core.manifest || []).filter(m => m.seasonId && m.compName).map(m => m.seasonId));
  } catch (e) {
    log(`⚠️ could not read data/core.json (${e.message}) — every season will read as NOT held`);
  }
  log(`shard ${SHARD}  manifest seasons: ${heldIds.size}  batch ${BATCH}  max age ${MAX_AGE_DAYS}d`);

  const { due, total, unreadable } = dueFiles(dir, startMs);
  summary.players = total;
  summary.due = due.length;
  if (unreadable) log(`⚠️ ${unreadable} unreadable file(s) skipped — not fetched, not counted`);
  const plan = LIMIT > 0 ? due.slice(0, LIMIT) : due;
  log(`players ${total}, due ${due.length}${LIMIT ? ` (limited to ${plan.length})` : ''}`);
  if (!plan.length) {
    log('Nothing due. Summary written with remaining 0.');
    writeSummary();
    process.exit(0);
  }

  if (!await refreshSession()) {
    log('⚠️ no session at start — recording the shard as blocked so the chain retries it');
    summary.blocked = true;
    summary.remaining = plan.length;
    writeSummary();
    process.exit(0);
  }

  const roundSamples = [];
  // uuid samples per negative kind, so the closing report can print a link for
  // each. Capped — five is enough to check a pattern and short enough to read.
  const samples = { noStats: [], serverError: [], missing: [], private: [], transport: [] };
  const sample = (kind, uuid) => { if (samples[kind].length < 5) samples[kind].push(uuid); };
  let call = 0;
  let blocked = false;

  // A private or deleted profile is an ANSWER. Stamp it so it is not re-fetched
  // until the max-age window comes round, and keep the marker so the panel can
  // tell "no data" from "not walked yet". No career or seasons key is written.
  function stampNegative(item, kind, detail) {
    if (!item) return;
    const next = { uuid: item.uuid, name: item.rec.name || null,
                   statsChecked: new Date().toISOString(), [kind]: detail || true };
    fs.writeFileSync(item.p, JSON.stringify(next));
    summary.written++;
  }

  for (let start = 0; start < plan.length && !blocked; start += BATCH) {
    if (Date.now() - startMs > TIME_BUDGET_MS) {
      log(`time budget reached after ${summary.batches_completed} batch(es)`);
      break;
    }
    const batch = plan.slice(start, start + BATCH);
    // A refresh resets the per-session JWT quota. Not before the first batch —
    // main() has just acquired one.
    if (start > 0) {
      log(`  session refresh before batch ${summary.batches_completed + 1}`);
      await refreshSession();
    }
    const blockedBefore = playhq.summary().blocked;

    const results = await Promise.allSettled(batch.map(async (item) => {
      try {
        const json = await gqlPost(Q, { profileID: item.uuid }, 'publicProfileStatistics');
        return { item, json };
      } catch (e) {
        e.item = item;          // the rejected branch cannot identify the player without it
        throw e;
      }
    }));

    for (const r of results) {
      call++;
      if (r.status === 'rejected') {
        // A 403 on this operation is DATA, not an expired session — lib/playhq.js
        // holds publicProfileStatistics in AUTH_403_IS_DATA and throws.
        const msg = String(r.reason && r.reason.message ? r.reason.message : r.reason);
        // ⚠️ A 403 on this operation is DATA — the profile is private. It is an
        // ANSWER, so it must be stamped. Left unstamped the player has no
        // statsChecked, is due again on the next run for ever, and `remaining`
        // never reaches zero, so the chain carries the shard indefinitely.
        if (/403 not accessible/.test(msg)) {
          summary.notFound++;
          sample('private', r.reason.item && r.reason.item.uuid);
          stampNegative(r.reason.item, 'private');
        }
        else {
          // A THROW is the transport giving up after its retries — a network
          // fault, not a verdict on this player. Left UNSTAMPED so the next run
          // tries again; the chain's three-zero-write stop is what catches it if
          // it never clears. The first stack frame is printed because a crash in
          // OUR code arrives here looking exactly like a transport failure.
          summary.errors++;
          sample('transport', r.reason.item && r.reason.item.uuid);
          if (summary.errors <= 5) {
            const frame = String(r.reason && r.reason.stack || '').split('\n')[1] || '';
            log(`  transport error: ${msg.slice(0, 160)}${frame ? '\n    ' + frame.trim() : ''}`);
          }
        }
        continue;
      }
      const { item, json } = r.value;
      if (json && json.errors && json.errors.length) {
        const msg = String(json.errors[0].message || '');
        if (/NOT_FOUND|failed to find profile/i.test(msg)) {
          summary.notFound++;
          sample('missing', item.uuid);
          stampNegative(item, 'missing');
        }
        else {
          // ⚠️ A 200 CARRYING A GraphQL `errors` ARRAY IS PLAYHQ'S ANSWER, AND
          // FOR THESE PROFILES IT IS THEIR SERVER CRASHING IN OUR WORDS-BACK:
          // "Cannot read properties of undefined (reading '0')" is a JavaScript
          // TypeError from PlayHQ's own resolver, not from this script.
          // Measured 2026-09-10: 11 of 70,933 players, identical on every retry
          // across three chained runs.
          //
          // It is therefore a VERDICT, not a fault to retry for ever. Stamped
          // like the other definitive negatives so `remaining` can reach zero and
          // the shard is released, with the message kept in the file so it is
          // visible without reading a log, and re-checked when the max-age window
          // comes round in case PlayHQ fixes it.
          summary.serverErrors++;
          sample('serverError', item.uuid);
          if (summary.serverErrors <= 5) log(`  PlayHQ server error for ${item.uuid}: ${msg.slice(0, 200)}`);
          stampNegative(item, 'serverError', msg.slice(0, 200));
        }
        continue;
      }
      const parsed = parseProfile(json, heldIds, roundSamples);
      // ⚠️ A 200 WITH `publicProfileStatistics: null` AND NO errors ARRAY IS AN
      // ANSWER, NOT A FAILURE. Measured on shard 00, 2026-09-10: two of 274
      // players came back this way, and v1 counted them as errors, printed
      // NOTHING about them, and left them unstamped — so they were due again on
      // the next run, `remaining` never reached 0, and the chain would carry the
      // shard for ever. The sibling project records the likely cause: a
      // spectator-namespace id fed to this operation returns 200 with null data,
      // which reads as "private or missing" but is a namespace mismatch.
      //
      // Stamped like any other definitive negative, so it comes round again with
      // the max-age window rather than never or every run. And the uuids are
      // PRINTED: a tool that reports something is absent must show what it found.
      if (!parsed) {
        summary.noStats++;
        sample('noStats', item.uuid);
        stampNegative(item, 'noStats');
        continue;
      }
      summary.checked++;
      if (parsed.drift !== 0) summary.drifted++;

      const next = {
        uuid: item.uuid,
        name: item.rec.name || null,
        statsChecked: new Date().toISOString(),
        career: parsed.career,
        seasons: parsed.seasons,
        records: parsed.records,
      };
      if (parsed.drift !== 0) next.drift = parsed.drift;
      fs.writeFileSync(item.p, JSON.stringify(next));
      summary.written++;
    }

    summary.batches_completed++;
    // ⚠️ The block is invisible as an error because gqlPost absorbs it. The
    // counter is the only signal.
    if (playhq.summary().blocked > blockedBefore) {
      blocked = true;
      summary.blocked = true;
      summary.blocked_at_call = call;
      log(`  ⛔ CloudFront block in batch ${summary.batches_completed} at call ${call} — stopping, ` +
          `${summary.written} written. The chain re-dispatches this shard on a fresh runner.`);
      break;
    }
    if (BATCH_GAP_MS) await sleep(BATCH_GAP_MS);
  }

  // `remaining` is what is still UNANSWERED, so a private profile does not keep
  // the shard alive in the chain for ever.
  summary.remaining = Math.max(0, due.length - summary.checked - summary.notFound - summary.noStats - summary.serverErrors);

  log(`\n--- shard ${SHARD} ---`);
  log(`players ${summary.players}  due ${summary.due}  checked ${summary.checked}  written ${summary.written}`);
  log(`batches ${summary.batches_completed}  blocked ${summary.blocked}` +
      (summary.blocked_at_call ? ` at call ${summary.blocked_at_call}` : '') +
      `  remaining ${summary.remaining}`);
  log(`not found ${summary.notFound}  no stats ${summary.noStats}  ` +
      `PlayHQ server errors ${summary.serverErrors}  transport errors ${summary.errors}`);
  const NEGATIVE_LABEL = {
    serverError: "PlayHQ's own resolver threw — a 200 carrying a JavaScript TypeError",
    noStats: 'returned 200 with null data — private profile, or no statistics',
    private: 'returned 403 — private profile',
    missing: 'returned NOT_FOUND — no such profile',
    transport: 'the transport gave up after its retries — NOT stamped, retried next run',
  };
  const anyNegative = Object.values(samples).some(a => a.length);
  if (anyNegative) {
    log(`\n── players with no career record, and where to check them ──`);
    for (const kind of Object.keys(samples)) {
      if (!samples[kind].length) continue;
      const total = kind === 'transport' ? summary.errors
        : kind === 'serverError' ? summary.serverErrors
        : kind === 'noStats' ? summary.noStats : null;
      log(`  ${kind}${total !== null ? ` (${total} this run)` : ''} — ${NEGATIVE_LABEL[kind]}`);
      for (const u of samples[kind]) log(`    ${profileUrl(u)}`);
    }
    log('  Open one: if the page shows statistics, this script is wrong about that player.');
  }
  // The §9 step 1 check, reported every run rather than probed once.
  log(`career total vs summed registrations — disagreed for ${summary.drifted} of ${summary.checked}`);
  if (roundSamples.length) {
    log(`first ${roundSamples.length} round object(s) RAW — are number and isFinalsRound populated?`);
    for (const r of roundSamples) log('  ' + JSON.stringify(r));
  }
  for (const kind of Object.keys(samples)) {
    if (samples[kind].length) summary.samples[kind] = samples[kind];
  }
  playhq.logSummary(`career-${SHARD}`);
  writeSummary();
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
