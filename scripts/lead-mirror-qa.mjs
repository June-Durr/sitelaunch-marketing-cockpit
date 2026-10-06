/**
 * Visual QA for the relationship follow-up screens, at desktop and phone width.
 *
 * WHY THIS EXISTS SEPARATELY FROM scripts/screenshots.mjs
 *
 * That script captures every screen against whatever the app is holding. The seed
 * dataset has no leads in it at all, so it would photograph an empty Pipeline and
 * an empty Today and prove nothing about the columns this sprint added. This one
 * puts a deterministic set of invented relationships into browser-local storage
 * first, chosen to cover every follow-up state the screens can render: overdue,
 * due today, due soon, scheduled, deliberately not scheduled, on hold, archived
 * and closed, plus a last touch that came from an activity, one that was only
 * reported by an import, and one that was never recorded at all.
 *
 * NO PRODUCTION DATA. Every person below is invented and every date is fixed, so
 * the same run produces the same screenshots whenever it is run.
 *
 * MIRROR_DATASET=<path> swaps the fixtures for a dataset read out of a real
 * database, which is how the imported records are checked on the real screens
 * without signing anybody in. The components, the follow-up configuration and the
 * rendering are identical either way; only the adapter underneath differs.
 *
 *   node scripts/lead-mirror-qa.mjs [baseUrl]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4173';
const OUT = 'screenshots/lead-mirror';

const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'phone-390x844', width: 390, height: 844 },
];

const T = '2026-10-05T09:00:00.000Z';

/** Fields every lead carries, so each fixture below only states what it varies. */
const LEAD = {
  content_item_id: null, organization: null, email: null, phone: null,
  project: null, source: null, related_campaign: null,
  next_action: null, next_action_date: null, proposed_value: null,
  closed_value: null, attribution_note: null, notes: null,
  external_source: 'google_sheets', external_key: null, relationship: null,
  current_status: null, preferred_channel: null, record_confidence: null,
  follow_up_mode: 'auto', reported_last_touch_at: null,
  is_seed: false, first_contact_at: null, closed_at: null,
  created_at: T, updated_at: T,
};

const ACTIVITY = {
  details: null, source: 'import', external_id: null, external_source: 'google_sheets',
  channel: null, evidence_source: null, content_item_id: null, task_id: null,
  external_calendar_id: null, external_event_id: null,
  calendar_sync_status: 'not_synced', last_synced_at: null, sync_error: null,
  is_seed: false, created_at: T, updated_at: T,
};

const leads = [
  {
    ...LEAD, id: 'l-overdue', external_key: 'ernesto-gil', prospect_name: 'Ernesto Gil',
    organization: 'Independent / restaurant design', relationship: 'Networking prospect',
    stage: 'follow_up', current_status: 'Message sent; prior follow-up date passed',
    source: 'LinkedIn', preferred_channel: 'LinkedIn',
    next_action: 'Send a concise follow-up or archive', next_action_date: '2026-09-15',
    first_contact_at: '2026-09-08', record_confidence: 'Confirmed',
  },
  {
    ...LEAD, id: 'l-today', external_key: 'ariel-demolition', prospect_name: 'Ariel',
    organization: 'Ariel Demolition', relationship: 'Prospect', stage: 'follow_up',
    current_status: 'Awaiting reply and any branding materials',
    source: 'Flyer / cold call', preferred_channel: 'Phone + text (Spanish)',
    next_action: 'Send short follow-up asking whether he wants the free mockup',
    next_action_date: '2026-10-05', first_contact_at: '2026-09-19',
    record_confidence: 'Confirmed',
  },
  {
    ...LEAD, id: 'l-soon', external_key: 'taylor-handyman', prospect_name: 'Taylor',
    organization: 'Your Local Handyman', relationship: 'Prospect', stage: 'follow_up',
    current_status: 'Awaiting website, logo or project materials',
    source: 'Flyer / cold call', preferred_channel: 'Phone + email',
    email: 'taylor@example.com',
    next_action: 'Send one concise final follow-up; archive if no response',
    next_action_date: '2026-10-06', first_contact_at: '2026-09-19',
    record_confidence: 'Confirmed',
  },
  {
    ...LEAD, id: 'l-soon2', external_key: 'carlos-sweet-stax',
    prospect_name: 'Carlos Flores Iselo', organization: 'Sweet Stax',
    relationship: 'Existing client / upsell', stage: 'waiting',
    current_status: 'Brand board delivered; pilot proposed; awaiting response',
    source: 'Existing client', preferred_channel: 'Email',
    email: 'carlos@example.com', phone: '555-0132', proposed_value: 150,
    next_action: 'Send a brief check-in about the pilot', next_action_date: '2026-10-07',
    first_contact_at: '2026-05-18', reported_last_touch_at: '2026-09-12',
    record_confidence: 'Confirmed',
  },
  {
    ...LEAD, id: 'l-scheduled', external_key: 'moth-to-flame',
    prospect_name: 'Tyson Harvey and Ivo Lorenz', organization: 'Moth to Flame',
    relationship: 'Existing client / upsell', stage: 'waiting',
    current_status: 'November upgrade conversation requested',
    source: 'Existing client', preferred_channel: 'Instagram + email',
    email: 'tyson@example.com',
    next_action: 'Prepare upgrade options and request a joint November call',
    next_action_date: '2026-11-09', reported_last_touch_at: '2026-09-13',
    record_confidence: 'Confirmed',
  },
  {
    ...LEAD, id: 'l-none', external_key: 'olde-capital', prospect_name: 'Name pending',
    organization: 'Olde Capital Investments', relationship: 'Prospect', stage: 'waiting',
    current_status: 'No second chase requested', source: 'Prior outreach',
    next_action: 'No action unless they re-engage', follow_up_mode: 'none',
    notes: 'Kept for history so the relationship is not lost.',
    record_confidence: 'Incomplete',
  },
  {
    ...LEAD, id: 'l-hold', external_key: 'onthebrew',
    prospect_name: 'Jonathan and Cecilia Villeda', organization: 'On The Brew',
    relationship: 'Existing client', stage: 'waiting',
    current_status: 'Website complete; still waiting for promised information',
    source: 'Existing client', follow_up_mode: 'hold',
    next_action: 'Hold outreach until they respond',
    record_confidence: 'Confirmed relationship; dates incomplete',
  },
  {
    ...LEAD, id: 'l-archived', external_key: 'moha-alec', prospect_name: 'Moha Alec',
    relationship: 'Audit lead', stage: 'waiting', follow_up_mode: 'archived',
    current_status: 'No response after audit follow-ups',
    source: 'Inbound website audit', email: 'moha@example.com',
    first_contact_at: '2026-03-02', reported_last_touch_at: '2026-03-07',
    record_confidence: 'Confirmed',
  },
  {
    ...LEAD, id: 'l-won', external_key: 'cedar-stone', prospect_name: 'Yaritza Kwan',
    organization: 'Cedar Stone', relationship: 'Existing client', stage: 'won',
    source: 'Networking event', closed_value: 2400, closed_at: '2026-09-30',
    first_contact_at: '2026-09-17', record_confidence: 'Confirmed',
  },
  {
    ...LEAD, id: 'l-nothing', external_key: 'dj-4the-win', prospect_name: 'Name pending',
    organization: 'DJ 4THE WIN', relationship: 'Relationship to confirm',
    stage: 'new_contact',
    current_status: 'Known prior relationship; details not reconstructed',
    source: 'Prior conversation', next_action_date: '2026-10-12',
    notes: 'Placeholder prevents the relationship from disappearing.',
    record_confidence: 'Incomplete',
  },
];

const activityEvents = [
  {
    ...ACTIVITY, id: 'a-1', lead_id: 'l-soon', activity_type: 'follow_up_sent',
    title: 'Follow-up sent', occurred_at: '2026-09-24T12:00:00.000Z',
    channel: 'Email', details: 'Second attempt', evidence_source: 'Gmail',
  },
  {
    ...ACTIVITY, id: 'a-2', lead_id: 'l-soon', activity_type: 'conversation',
    title: 'Discovery conversation', occurred_at: '2026-09-19T12:00:00.000Z',
    channel: 'Phone', evidence_source: 'User report',
  },
  {
    ...ACTIVITY, id: 'a-3', lead_id: 'l-overdue', activity_type: 'follow_up_sent',
    title: 'Follow-up sent', occurred_at: '2026-09-08T12:00:00.000Z',
    channel: 'LinkedIn',
  },
  {
    ...ACTIVITY, id: 'a-4', lead_id: 'l-today', activity_type: 'conversation',
    title: 'Discovery conversation', occurred_at: '2026-09-19T12:00:00.000Z',
    channel: 'Phone',
  },
  // Deliberately not a touch: it must not move anybody's last-touch date.
  {
    ...ACTIVITY, id: 'a-5', lead_id: 'l-archived', activity_type: 'analytics_check',
    title: 'Checked the numbers', occurred_at: '2026-10-04T12:00:00.000Z',
  },
];

const tasks = [
  {
    id: 't-1', content_item_id: null, lead_id: 'l-soon',
    title: 'Follow up with Taylor', task_type: 'follow_up', status: 'open',
    due_date: '2026-10-06', window_type: null,
    notes: 'Scheduled 7 days after the contact, which is the rhythm for this stage.',
    completed_at: null, external_calendar_id: null, external_event_id: null,
    calendar_sync_status: 'not_synced', last_synced_at: null, sync_error: null,
    is_seed: false, created_at: T, updated_at: T,
  },
];

const FIXTURES = {
  accounts: [], contentItems: [], snapshots: [], traffic: [],
  leads, tasks, recommendations: [], activityEvents,
};

/** Real records when one is supplied, invented ones otherwise. */
const DATASET = process.env.MIRROR_DATASET
  ? JSON.parse(await readFile(process.env.MIRROR_DATASET, 'utf8'))
  : FIXTURES;

const USING_REAL = Boolean(process.env.MIRROR_DATASET);
if (USING_REAL) {
  console.log(
    `Rendering a supplied dataset: ${DATASET.leads.length} leads, ` +
      `${DATASET.activityEvents.length} activities, ${DATASET.tasks.length} tasks.\n`,
  );
}

const SCREENS = [
  { name: '1-pipeline-board', path: '/pipeline', view: 'board' },
  { name: '2-pipeline-table', path: '/pipeline', view: 'table' },
  { name: '3-today', path: '/' },
  { name: '4-data-and-import', path: '/data' },
];

/** Elements sticking out past the viewport, and the page's own scroll width. */
async function findOverflow(page, limit) {
  return page.evaluate((width) => {
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      // A table that scrolls inside its own wrapper is fine, and is how the
      // Pipeline table is meant to behave on a phone.
      let scrollable = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll') { scrollable = true; break; }
      }
      if (scrollable) continue;
      const overhang = Math.round(rect.right - width);
      if (overhang > 1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className?.toString() ?? '').slice(0, 50),
          overhang,
          text: (el.textContent ?? '').trim().slice(0, 40),
        });
      }
    }
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      offenders: offenders.slice(0, 10),
    };
  }, limit);
}

const browser = await chromium.launch();
const report = [];

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // Seed before the app boots, so the first render already has the data.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate((dataset) => {
    localStorage.setItem('slmc.dataset.v1', JSON.stringify(dataset));
  }, DATASET);

  for (const screen of SCREENS) {
    await page.goto(`${BASE}${screen.path}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1', { timeout: 15_000 });

    if (screen.view) {
      const label = screen.view === 'board' ? 'Board' : 'Table';
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(150);
    }

    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);

    const dir = `${OUT}/${viewport.name}`;
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${screen.name}.png`, fullPage: true });

    const overflow = await findOverflow(page, viewport.width);
    const heading = (await page.textContent('h1'))?.trim();

    // A few things worth asserting while a real browser is open.
    const body = (await page.textContent('body')) ?? '';
    const checks = {};
    if (screen.path === '/pipeline') {
      // textContent runs adjacent nodes together, so a word boundary before
      // "Days" would be looking for one between "touch" and "Days".
      checks.showsDueToday = body.includes('Due today');
      checks.showsNotScheduled = body.includes('Not scheduled');
      checks.noRawUuid = !/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/i.test(body);
      if (!USING_REAL) {
        checks.showsOverdue = body.includes('Overdue');
        checks.showsOnHold = body.includes('On hold');
      }
    }
    if (screen.name === '2-pipeline-table') {
      checks.hasDaysSinceColumn = body.includes('Days since');
      checks.hasLastTouchColumn = body.includes('Last touch');
      checks.hasFollowUpStatusColumn = body.includes('Follow-up status');
      // A date that came from an import with no event behind it says so.
      checks.labelsReportedTouch = body.includes('Reported, no activity logged');
      // And a lead with nothing recorded says so rather than showing a zero.
      checks.saysNotKnown = body.includes('Not known');
      if (!USING_REAL) {
        // The fixture lead whose last touch is a logged activity.
        checks.showsDerivedLastTouch = body.includes('Sep 24, 2026');
      }
    }
    if (screen.path === '/' && !USING_REAL) {
      checks.listsOverdueLead = body.includes('Ernesto Gil');
      checks.listsDueTodayLead = body.includes('Ariel');
      checks.hidesHeldLead = !body.includes('On The Brew');
      checks.hidesArchivedLead = !body.includes('Moha Alec');
      checks.hidesScheduledLead = !body.includes('Tyson Harvey');
      checks.showsDaysWaiting = body.includes('days since the last touch');
    }
    if (screen.path === '/data') {
      checks.hasMirrorPanel = body.includes('Google Sheet lead mirror');
    }

    report.push({
      viewport: viewport.name,
      screen: screen.name,
      heading,
      horizontalScroll: overflow.documentScrollWidth > viewport.width + 1,
      scrollWidth: overflow.documentScrollWidth,
      offenders: overflow.offenders,
      checks,
      consoleErrors: [...consoleErrors],
    });
    consoleErrors.length = 0;
  }

  await context.close();
}

await browser.close();
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));

let problems = 0;
for (const row of report) {
  const flags = [];
  if (row.horizontalScroll) flags.push(`H-SCROLL ${row.scrollWidth}`);
  if (row.offenders.length) {
    flags.push(
      `OVERFLOW ${row.offenders.map((o) => `${o.tag}.${o.cls.split(' ')[0]}+${o.overhang}px`).join(', ')}`,
    );
  }
  if (row.consoleErrors.length) flags.push(`CONSOLE ${row.consoleErrors.length}`);
  for (const [name, ok] of Object.entries(row.checks)) {
    if (!ok) flags.push(`CHECK-FAILED ${name}`);
  }
  if (flags.length) problems += 1;
  console.log(
    `${row.viewport.padEnd(18)} ${row.screen.padEnd(20)} ${(row.heading ?? '').padEnd(18)} ${
      flags.length ? flags.join(' | ') : 'ok'
    }`,
  );
}
console.log(`\n${report.length} captures, ${problems} with flags.`);
if (problems > 0) process.exitCode = 1;
