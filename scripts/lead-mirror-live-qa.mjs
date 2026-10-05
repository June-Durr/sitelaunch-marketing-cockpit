/**
 * One capture of Data & Import against the real project, signed in.
 *
 * Everything else about the lead mirror panel is covered by jsdom tests, which
 * drive it from a stubbed repository state. The one thing those cannot show is
 * that the real Supabase wiring works: that loadLeadMirror reaches the real
 * tables, that an unapplied migration or a missing row is handled, and that what
 * the server actually recorded is what appears on screen.
 *
 * The session is read from a file rather than typed in, and it is a session for
 * the project's own single user. Nothing here writes anything.
 *
 *   node scripts/lead-mirror-live-qa.mjs <baseUrl> <sessionJsonPath> <projectRef> [idThatMustNotAppear]
 *
 * The last argument is optional: a value the page must not contain, such as the
 * spreadsheet id, so the capture doubles as a check that nothing configuration-
 * shaped leaked onto the screen. It is an argument rather than a literal here for
 * the same reason it is an Edge Function secret rather than a constant in src.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const [BASE, SESSION_PATH, REF, FORBIDDEN] = process.argv.slice(2);
if (!BASE || !SESSION_PATH || !REF) {
  console.error(
    'usage: node scripts/lead-mirror-live-qa.mjs <baseUrl> <session.json> <ref> [forbiddenString]',
  );
  process.exit(2);
}

const OUT = 'screenshots/lead-mirror-live';
const session = JSON.parse(await readFile(SESSION_PATH, 'utf8'));

const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'phone-390x844', width: 390, height: 844 },
];

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

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([ref, value]) => {
      localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(value));
    },
    [REF, session],
  );

  for (const [name, path] of [['1-data-and-import', '/data'], ['2-pipeline', '/pipeline']]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1', { timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    // The panel reads its state after the page settles.
    await page.waitForTimeout(2500);

    const dir = `${OUT}/${viewport.name}`;
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });

    const body = (await page.textContent('body')) ?? '';
    report.push({
      viewport: viewport.name,
      screen: name,
      heading: (await page.textContent('h1'))?.trim(),
      signedIn: !body.includes('Sign in'),
      hasMirrorPanel: body.includes('Google Sheet lead mirror'),
      // The panel must never put configuration or a credential on screen.
      leaksForbidden: FORBIDDEN ? body.includes(FORBIDDEN) : false,
      leaksServiceAccount: body.includes('gserviceaccount.com'),
      leaksPrivateKey: body.includes('BEGIN PRIVATE KEY'),
      consoleErrors: [...consoleErrors],
    });
    consoleErrors.length = 0;
  }

  await context.close();
}

await browser.close();
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));

for (const row of report) {
  console.log(
    `${row.viewport.padEnd(18)} ${row.screen.padEnd(18)} ${(row.heading ?? '').padEnd(16)} ` +
      `signedIn=${row.signedIn} panel=${row.hasMirrorPanel} ` +
      `leaks=${row.leaksForbidden || row.leaksServiceAccount || row.leaksPrivateKey} ` +
      `consoleErrors=${row.consoleErrors.length}`,
  );
  for (const e of row.consoleErrors) console.log('    console:', e.slice(0, 160));
}
