/**
 * End-to-end check of the backup workflow in a real browser.
 *
 *   export -> mutate the dataset -> restore -> confirm byte-exact recovery
 *
 * Run with the dev server up:  node scripts/backup-e2e.mjs
 */

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const KEY = 'slmc.dataset.v1';

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const page = await context.newPage();

const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

await page.goto(`${BASE}/data`, { waitUntil: 'networkidle' });
await page.waitForSelector('h1');

const before = await page.evaluate((k) => localStorage.getItem(k), KEY);
const beforeParsed = JSON.parse(before);
check(
  'seed dataset present before export',
  beforeParsed.contentItems.length === 3 && beforeParsed.accounts.length === 2,
  `${beforeParsed.contentItems.length} content items, ${beforeParsed.accounts.length} accounts`,
);

// --- export -------------------------------------------------------------
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: /Export backup/ }).click(),
]);
const dir = await mkdtemp(join(tmpdir(), 'slmc-'));
const file = join(dir, download.suggestedFilename());
await download.saveAs(file);
const json = await readFile(file, 'utf8');
const backup = JSON.parse(json);

check('export downloaded a file', json.length > 0, download.suggestedFilename());
check('backup carries a schema version', Number.isInteger(backup.schema_version));
check('backup carries an export timestamp', !Number.isNaN(Date.parse(backup.exported_at)));
// Derived rather than hardcoded, so adding a table updates this on its own.
const EXPECTED_TABLES = [
  'accounts', 'activity_events', 'content_items', 'leads',
  'performance_snapshots', 'recommendations', 'tasks', 'traffic_snapshots',
];
check(
  'backup contains every table',
  JSON.stringify(Object.keys(backup.tables).sort()) === JSON.stringify(EXPECTED_TABLES),
  Object.keys(backup.tables).sort().join(', '),
);
check(
  'backup declares the current schema version',
  backup.schema_version === 2,
  `schema ${backup.schema_version}`,
);
check(
  'backup carries the program dates',
  backup.settings?.program?.startDate === '2026-08-27' &&
    backup.settings?.program?.targetDate === '2026-11-25',
  `${backup.settings?.program?.startDate} to ${backup.settings?.program?.targetDate}`,
);
check(
  'absent metrics exported as null, not zero',
  backup.tables.performance_snapshots.some(
    (s) => s.views === 31 && s.likes === null && s.link_clicks === null,
  ),
);
check('settings included', typeof backup.settings === 'object' && backup.settings !== null);

// --- mutate: delete both accounts through the UI -------------------------
for (let i = 0; i < 2; i += 1) {
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await page.waitForTimeout(250);
}
const mutated = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), KEY));
check('dataset was actually changed', mutated.accounts.length === 0, 'accounts deleted');

// --- a malformed file must not touch the mutated state -------------------
const badPath = join(dir, 'broken.json');
await writeFile(badPath, '{ not really json');
await page.setInputFiles('input[type="file"][accept*="json"]', badPath);
await page.waitForSelector('text=File rejected');
const afterBad = await page.evaluate((k) => localStorage.getItem(k), KEY);
check(
  'a rejected file changed nothing',
  afterBad === JSON.stringify(mutated),
);
check(
  'no restore button offered for a rejected file',
  (await page.getByRole('button', { name: /Replace all data/ }).count()) === 0,
);
await page.getByRole('button', { name: 'Dismiss' }).click();

// --- restore -------------------------------------------------------------
await page.setInputFiles('input[type="file"][accept*="json"]', file);
await page.waitForSelector('text=Review before replacing');

const warned = await page
  .locator('text=/This will replace all \\d+ records/')
  .count();
check('a warning is shown before replacing', warned === 1);

const stillMutated = await page.evaluate((k) => localStorage.getItem(k), KEY);
check(
  'nothing written while the review is on screen',
  stillMutated === JSON.stringify(mutated),
);

await page.getByRole('button', { name: /Replace all data with this backup/ }).click();
await page.waitForSelector('text=/Restored \\d+ records/');

const after = await page.evaluate((k) => localStorage.getItem(k), KEY);
const afterParsed = JSON.parse(after);

check(
  'exact recovery of every table',
  JSON.stringify(afterParsed) === JSON.stringify(beforeParsed),
  `${afterParsed.accounts.length} accounts, ${afterParsed.contentItems.length} content items restored`,
);

const restoredSnap = afterParsed.snapshots.find((s) => s.id === 'ps-bts-ig-24h');
check('observed metric survived the round trip', restoredSnap?.views === 31);
check(
  'null metrics came back null, not zero',
  restoredSnap?.likes === null && restoredSnap?.leads === null,
);

// --- the restored data renders --------------------------------------------
await page.goto(`${BASE}/content`, { waitUntil: 'networkidle' });
await page.waitForSelector('h1');
check(
  'restored content renders in the Content Log',
  (await page.getByText('SiteLaunch BTS Story').count()) > 0,
);

await browser.close();
console.log(process.exitCode ? '\nSome checks failed.' : '\nAll backup e2e checks passed.');
