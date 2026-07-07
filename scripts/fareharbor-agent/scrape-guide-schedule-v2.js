#!/usr/bin/env node
/**
 * FareHarbor Guide Schedule Sync (v2 — JSON API interception)
 *
 * Logs into the FareHarbor dashboard once, loads the calendar month view
 * for the current and next month, and intercepts the internal JSON API
 * responses which contain EVERY availability with dates, times, booking
 * counts, and crew assignments (guide name lives in the crew note field,
 * or the user's real name for guides with their own FareHarbor account).
 *
 * Replaces the old per-availability page scraper: 2 page loads instead
 * of ~260, ~30 seconds instead of ~40 minutes.
 *
 * Cron (single entry, every hour is fine at this speed):
 *   0 * * * * cd /var/www/becopenhagen-fleet/scripts/fareharbor-agent && node scrape-guide-schedule.js >> /var/log/bc-schedule-scraper.log 2>&1
 */

const { chromium } = require('playwright');
const { getDb, isNotifEnabled } = require('../../src/db/schema');
const { sendEmail, EMAIL_FOOTER } = require('../../src/email');
const { guideMatches } = require('../../src/guide-name-match');
const { logTourChange } = require('../../src/tour-change-log');

const COMPANY_SLUG = 'becopenhagen';

// Item PK → feed config. Only these tour items are synced.
const TOUR_ITEMS = {
  707493: { feed_id: 'L3',  label: 'Liveable City Tour (3h)' },
  709131: { feed_id: 'A3',  label: 'Architecture Tour (3h)' },
  729348: { feed_id: 'F3',  label: 'Food Tour (3h)' },
  741878: { feed_id: 'H3',  label: 'History Tour (3h)' },
  713560: { feed_id: 'L3P', label: 'Private Liveable City (3h)' },
  713563: { feed_id: 'A3P', label: 'Private Architecture (3h)' },
  730640: { feed_id: 'F3P', label: 'Private Food Tour (3h)' },
  712177: { feed_id: 'L2P', label: 'Private Liveable City (2h)' },
  650858: { feed_id: 'CUSTOM', label: 'Custom Tour' },
};

// Map crew user names to guide names. 'Crew 1' means the real guide name
// is in the crew note. Guides with their own accounts map directly.
function resolveGuideName(crewMember) {
  let userName = crewMember?.user?.name || '';
  // Abbreviated user objects only have a uri like /users/federico/ — extract
  // the slug and title-case it for display (e.g. "federico" -> "Federico")
  if (!userName && crewMember?.user?.uri) {
    const m = crewMember.user.uri.match(/\/users\/([^/]+)\//);
    if (m) userName = m[1].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  const note = (crewMember?.note || '').trim();
  if (/^crew\s*\d*$/i.test(userName)) {
    return note || null; // generic crew account — real name is the note
  }
  return userName || note || null;
}

async function login(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto('https://fareharbor.com/login/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  if (await page.locator('text="Shortname"').count() > 0) {
    await page.locator('text="Shortname"').locator('xpath=following::input[1]').first().fill(COMPANY_SLUG);
    await page.locator('button:has-text("Next")').first().click();
    await page.waitForTimeout(2000);
  }

  await page.locator('input[type="email"],input[name="email"]').first().fill(process.env.FAREHARBOR_EMAIL);
  await page.locator('input[type="password"]').first().fill(process.env.FAREHARBOR_PASSWORD);
  await page.locator('button:has-text("Log in"),button[type="submit"]').first().click();
  await page.waitForTimeout(5000);

  return page;
}

// All item IDs from the discovered API URL (tours + rentals; harmless to request all)
const ALL_ITEM_IDS = '712177,707493,713560,709131,713563,729348,730640,650858,190975,190977,190978,190980,651114,651124,190983,651812,652669,652693,652695,652697,652699,652703,190987,702701,706960,583653,190971,201570,201571';

// Fetch one calendar month by calling the internal API directly (authenticated
// via the logged-in page's cookies). Deterministic — no response interception.
async function fetchMonth(page, year, month) {
  const results = [];
  for (let week = 1; week <= 6; week++) {
    const url = `https://fareharbor.com/api/v1/companies/${COMPANY_SLUG}/items/${ALL_ITEM_IDS}/calendar/${year}/${String(month).padStart(2, '0')}/?allow_grouped=yes&include_resource_use_summaries=yes&path=2&week_number=${week}`;
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        const resp = await page.request.get(url, { timeout: 60000 });
        if (!resp.ok()) { console.log(`  week ${week} attempt ${attempt}: HTTP ${resp.status()}`); continue; }
        const json = await resp.json();
        results.push(json);
        ok = true;
      } catch (e) {
        console.log(`  week ${week} attempt ${attempt} failed: ${e.message.substring(0, 60)}`);
      }
    }
  }
  if (results.length === 0) throw new Error(`No calendar data for ${year}-${month}`);
  console.log(`  (${results.length}/6 week responses fetched)`);
  return results;
}

// Map a resource name (from resource_use_summaries) to a bike category.
// Falls back to 'A' (adult bike) for generic/pooled resources like
// "Guided Tour Bikes" where FareHarbor doesn't track a finer breakdown.
function categorizeBikeResource(name) {
  const n = (name || '').toLowerCase();
  if (/electric|e-bike/.test(n)) return 'E';
  if (/toddler/.test(n)) return 'AT';
  if (/child.*seat|\+.*child/.test(n)) return 'AC';
  if (/kid|child/.test(n)) return 'B';
  return 'A';
}

// Extract real bike counts from resource_use_summaries, excluding
// guide-blocking resources (named "GuideName (feed, codes)" — these exist
// purely to prevent double-booking a guide, they aren't bikes).
function extractBikesFromResources(av, activeGuideNames) {
  const bikesNeeded = { A: 0, E: 0, B: 0, AC: 0, AT: 0 };
  let total = 0;
  for (const entry of av.resource_use_summaries || []) {
    const rawName = entry.resource?.name || '';
    const baseName = rawName.replace(/\s*\(.*\)\s*$/, '').trim();
    const isGuideResource = activeGuideNames.some(gn => guideMatches(baseName, gn));
    if (isGuideResource) continue;
    const count = entry.total_use_count || 0;
    if (count <= 0) continue;
    const cat = categorizeBikeResource(rawName);
    bikesNeeded[cat] += count;
    total += count;
  }
  return { bikesNeeded, total };
}

function extractAvailabilities(calendarJson, activeGuideNames) {
  const out = [];
  const weeks = calendarJson?.calendar?.weeks || [];
  for (const week of weeks) {
    for (const day of week.days || []) {
      for (const av of day.availabilities || []) {
        // FareHarbor abbreviates repeated objects: item may be {cls, uri} only.
        // Parse the item pk from the availability URI: /items/709131/availabilities/...
        let itemPk = av.item?.pk;
        if (!itemPk) {
          const m = (av.uri || av.item?.uri || '').match(/\/items\/(\d+)\//);
          itemPk = m ? parseInt(m[1], 10) : null;
        }
        if (!TOUR_ITEMS[itemPk]) continue; // skip rentals, gift certs, etc.

        // Skip slots that are closed for online booking AND have no bookings —
        // they will never run, guides don't need to see them
        if ((av.booking_count ?? 0) === 0 && av.is_bookable === false) continue;

        // Extract guide from crew members (first Guide-role crew member).
        // NOTE: group.role is often abbreviated to just {cls, uri} by FareHarbor's
        // payload deduplication (roles repeat across hundreds of availabilities),
        // so group.role.short_name/unicode is frequently missing. crewMember.unicode
        // (e.g. "Guide: federico") is reliable and per-entry, so use that instead.
        let guide = null;
        for (const group of av.grouped_crew_members || []) {
          for (const cm of group.crew_members || []) {
            const roleFromUnicode = (cm.unicode || '').split(':')[0].trim().toLowerCase();
            if (!roleFromUnicode.startsWith('guide')) continue;
            const name = resolveGuideName(cm);
            if (name) { guide = name; break; }
          }
          if (guide) break;
        }

        const { bikesNeeded, total: totalBikes } = extractBikesFromResources(av, activeGuideNames);

        out.push({
          availability_id: String(av.pk),
          item: TOUR_ITEMS[itemPk],
          start_at: av.utc_start_at ? new Date(av.utc_start_at).toISOString() : av.start_at,
          end_at: av.utc_end_at ? new Date(av.utc_end_at).toISOString() : av.end_at,
          start_date: day.at,
          booking_count: av.booking_count ?? 0,
          customer_count: av.customer_count ?? 0,
          bikes_needed: bikesNeeded,
          total_bikes: totalBikes,
          guide,
          _raw: JSON.stringify(av).substring(0, 4000), // capped — full record for forensic logging
        });
      }
    }
  }
  return out;
}

function hhmm(iso) {
  // Convert ISO datetime to local Copenhagen HH:MM
  try {
    return new Date(iso).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' });
  } catch (e) { return null; }
}

async function main() {
  if (!process.env.FAREHARBOR_EMAIL || !process.env.FAREHARBOR_PASSWORD) {
    throw new Error('FAREHARBOR_EMAIL and FAREHARBOR_PASSWORD env vars required');
  }

  const db = getDb();
  const activeGuideNames = db.prepare(`SELECT name FROM team_members WHERE active=1`).all().map(r => r.name);
  const browser = await chromium.launch({ headless: true });

  try {
    console.log(new Date().toISOString(), '— logging in...');
    const page = await login(browser);

    // Current month + next month covers 30+ days ahead
    const now = new Date();
    const months = [
      [now.getFullYear(), now.getMonth() + 1],
      [now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear(), (now.getMonth() + 1) % 12 + 1],
    ];

    let all = [];
    for (const [y, m] of months) {
      console.log(`Fetching calendar ${y}-${String(m).padStart(2, '0')}...`);
      const jsonResponses = await fetchMonth(page, y, m);
      let monthCount = 0;
      for (const json of jsonResponses) {
        const avs = extractAvailabilities(json, activeGuideNames);
        monthCount += avs.length;
        all = all.concat(avs);
      }
      console.log(`  ${monthCount} tour availabilities found (before dedup)`);
    }

    // Dedupe (overlapping weeks between months)
    const seen = new Set();
    all = all.filter(a => { if (seen.has(a.availability_id)) return false; seen.add(a.availability_id); return true; });

    const todayStr = new Date().toISOString().substring(0, 10);
    let upserted = 0;
    const assignmentDigest = new Map(); // member.id -> { member, items: [...] }

    for (const av of all) {
      if (av.start_date < todayStr) continue; // skip past

      const startTime = hhmm(av.start_at);
      const endTime = hhmm(av.end_at);
      const durationMinutes = av.start_at && av.end_at
        ? Math.round((new Date(av.end_at) - new Date(av.start_at)) / 60000) + 30
        : 210;

      // Previous state for notification triggers
      const prevRow = db.prepare('SELECT guide, booking_count, total_bikes FROM tour_availabilities WHERE availability_id=?').get(av.availability_id);
      const prev = prevRow; // keep existing variable name usage below
      const isNewAssignment = av.guide && (!prev || !prev.guide);
      // Use fuzzy matching, not raw string equality — our own extraction fixes
      // can change how the same person's name is represented (e.g. "federico"
      // -> "Federico"), which would otherwise look like a false reassignment
      const isReassignment = av.guide && prev?.guide && !guideMatches(prev.guide, av.guide);

      logTourChange(db, { availability_id: av.availability_id, feed_id: av.item.feed_id, start_date: av.start_date, field: 'guide', old_value: prev?.guide, new_value: av.guide, source: 'v2', raw_data: av._raw });
      logTourChange(db, { availability_id: av.availability_id, feed_id: av.item.feed_id, start_date: av.start_date, field: 'booking_count', old_value: prev?.booking_count, new_value: av.booking_count, source: 'v2', raw_data: av._raw });
      if (av.total_bikes > 0) {
        logTourChange(db, { availability_id: av.availability_id, feed_id: av.item.feed_id, start_date: av.start_date, field: 'total_bikes', old_value: prev?.total_bikes, new_value: av.total_bikes, source: 'v2', raw_data: av._raw });
      }

      db.prepare(`
        INSERT INTO tour_availabilities
          (availability_id, feed_id, feed_label, feed_type, guide, start_at, end_at,
           start_date, start_time, end_time, booking_count, bikes_needed, total_bikes, last_synced)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(availability_id) DO UPDATE SET
          guide=excluded.guide,
          start_at=excluded.start_at, end_at=excluded.end_at,
          start_date=excluded.start_date, start_time=excluded.start_time, end_time=excluded.end_time,
          booking_count=excluded.booking_count, last_synced=excluded.last_synced,
          bikes_needed=CASE WHEN excluded.total_bikes > 0 THEN excluded.bikes_needed ELSE bikes_needed END,
          total_bikes=CASE WHEN excluded.total_bikes > 0 THEN excluded.total_bikes ELSE total_bikes END
      `).run(av.availability_id, av.item.feed_id, av.item.label, 'tour',
             av.guide, av.start_at, av.end_at, av.start_date, startTime, endTime, av.booking_count,
             JSON.stringify(av.bikes_needed), av.total_bikes);

      if (av.guide) {
        db.prepare(`
          INSERT INTO guide_tour_hours
            (availability_id, guide, feed_id, feed_label, start_at, end_at, start_date, duration_minutes, last_synced)
          VALUES (?,?,?,?,?,?,?,?,datetime('now'))
          ON CONFLICT(availability_id) DO UPDATE SET
            guide=excluded.guide, start_at=excluded.start_at, end_at=excluded.end_at,
            start_date=excluded.start_date, duration_minutes=excluded.duration_minutes,
            last_synced=excluded.last_synced
        `).run(av.availability_id, av.guide, av.item.feed_id, av.item.label, av.start_at, av.end_at, av.start_date, durationMinutes);
      }

      // Collect assignment for batched digest email (sent once per guide at the end)
      if (isNewAssignment || isReassignment) {
        const allMembers = db.prepare(`SELECT id, name, email FROM team_members WHERE active=1`).all();
        const member = allMembers.find(m => guideMatches(av.guide, m.name));
        if (member?.email && isNotifEnabled(member.id, 'tour_assigned')) {
          if (!assignmentDigest.has(member.id)) {
            assignmentDigest.set(member.id, { member, items: [] });
          }
          assignmentDigest.get(member.id).items.push({
            feed_id: av.item.feed_id,
            feed_label: av.item.label,
            start_date: av.start_date,
            startTime, endTime,
            booking_count: av.booking_count,
            isReassignment,
          });
        }
      }

      console.log(`✓ ${av.start_date} ${startTime} ${av.item.feed_id} guide=${av.guide || 'unassigned'} bookings=${av.booking_count}`);
      upserted++;
    }

    console.log(`\nDone. ${upserted} availabilities synced in one pass.`);

    // Send one digest email per guide with all their new/updated assignments
    for (const { member, items } of assignmentDigest.values()) {
      items.sort((a, b) => (a.start_date + a.startTime).localeCompare(b.start_date + b.startTime));
      const newCount = items.filter(i => !i.isReassignment).length;
      const updateCount = items.filter(i => i.isReassignment).length;

      let subjectParts = [];
      if (newCount > 0) subjectParts.push(`${newCount} new tour${newCount !== 1 ? 's' : ''}`);
      if (updateCount > 0) subjectParts.push(`${updateCount} update${updateCount !== 1 ? 's' : ''}`);
      const subject = items.length === 1
        ? `Tour ${items[0].isReassignment ? 'updated' : 'assigned'} — ${items[0].feed_id} on ${new Date(items[0].start_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
        : `${subjectParts.join(' and ')} for you`;

      const rows = items.map(i => {
        const dateLabel = new Date(i.start_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        const tag = i.isReassignment
          ? `<span style="font-size:0.7rem;font-weight:600;color:#B8860B;background:#FFF6E0;padding:2px 8px;border-radius:10px">updated</span>`
          : `<span style="font-size:0.7rem;font-weight:600;color:#2E7D32;background:#E8F5E9;padding:2px 8px;border-radius:10px">new</span>`;
        return `<tr>
          <td style="padding:7px 14px 7px 0;color:#888;font-size:0.88rem">${dateLabel}</td>
          <td style="padding:7px 14px 7px 0;font-weight:700;font-size:0.9rem">${i.feed_id}</td>
          <td style="padding:7px 14px 7px 0;font-size:0.88rem">${i.startTime}${i.endTime ? ' – ' + i.endTime : ''}</td>
          <td style="padding:7px 14px 7px 0;color:#888;font-size:0.82rem">${i.booking_count} booking${i.booking_count !== 1 ? 's' : ''}</td>
          <td style="padding:7px 0">${tag}</td>
        </tr>`;
      }).join('');

      const intro = items.length === 1
        ? (items[0].isReassignment
            ? `One of your tour assignments has been updated:`
            : `You've been assigned to a new tour:`)
        : `You've been assigned to ${items.length} tours:`;

      const htmlContent = `
        <p>Hi ${member.name},</p>
        <p>${intro}</p>
        <table style="border-collapse:collapse;margin:0.75rem 0">
          ${rows}
        </table>
        <p>You can see all your upcoming tours in the app.</p>
        ${EMAIL_FOOTER}`;

      await sendEmail({ to: member.email, toName: member.name, subject, htmlContent, category: 'tour_assigned' })
        .catch(e => console.error(`Digest email failed for ${member.name}:`, e.message));
      console.log(`📧 Digest email → ${member.name}: ${items.length} tour(s) (${newCount} new, ${updateCount} updated)`);
    }

    // Deletion pass: any future tour slot in the DB that is NOT in the calendar
    // anymore has been cancelled/closed in FareHarbor. Delete + notify guide.
    const seenIds = new Set(all.map(a => a.availability_id));
    const lastSyncedDate = all.map(a => a.start_date).sort().pop() || todayStr;
    const dbFuture = db.prepare(`
      SELECT * FROM tour_availabilities
      WHERE feed_type='tour' AND start_date > ? AND start_date <= ?
    `).all(todayStr, lastSyncedDate);

    for (const row of dbFuture) {
      if (seenIds.has(row.availability_id)) continue;
      console.log(`✗ Removing cancelled slot: ${row.start_date} ${row.start_time} ${row.feed_id} (guide=${row.guide || 'none'})`);
      logTourChange(db, { availability_id: row.availability_id, feed_id: row.feed_id, start_date: row.start_date, field: 'status', old_value: 'active', new_value: 'cancelled', source: 'v2', raw_data: JSON.stringify(row).substring(0, 4000) });

      if (row.guide) {
        const allMembers = db.prepare(`SELECT id, name, email FROM team_members WHERE active=1`).all();
        const member = allMembers.find(m => guideMatches(row.guide, m.name));
        if (member?.email && isNotifEnabled(member.id, 'tour_cancelled')) {
          const dateLabel = new Date(row.start_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
          const htmlContent = `
            <p>Hi ${member.name},</p>
            <p>The following tour has been cancelled:</p>
            <table style="border-collapse:collapse;margin:0.5rem 0">
              <tr><td style="padding:3px 12px 3px 0;color:#888">Tour</td><td>${row.feed_label || row.feed_id}</td></tr>
              <tr><td style="padding:3px 12px 3px 0;color:#888">Date</td><td>${dateLabel}</td></tr>
              <tr><td style="padding:3px 12px 3px 0;color:#888">Time</td><td>${row.start_time}${row.end_time ? ' – ' + row.end_time : ''}</td></tr>
            </table>
            ${EMAIL_FOOTER}`;
          await sendEmail({ to: member.email, toName: member.name, subject: `Tour cancelled — ${row.feed_id} on ${dateLabel}`, htmlContent, category: 'tour_cancelled' })
            .catch(e => console.error(`Cancel email failed:`, e.message));
        }
      }
      db.prepare('DELETE FROM tour_availabilities WHERE availability_id=?').run(row.availability_id);
      db.prepare('DELETE FROM guide_tour_hours WHERE availability_id=? AND start_at > datetime(\'now\')').run(row.availability_id);
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
