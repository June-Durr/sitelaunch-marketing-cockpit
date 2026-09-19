/**
 * Capture every screen at desktop and phone width.
 *
 * Also reports layout faults the eye would catch: horizontal overflow of the page
 * body, and any element whose box extends past the viewport.
 *
 *   node scripts/screenshots.mjs [baseUrl]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = 'screenshots';

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
];

const SCREENS = [
  { name: '1-today', path: '/' },
  { name: '2-content-log', path: '/content' },
  { name: '3-website-outcomes', path: '/website' },
  { name: '4-pipeline', path: '/pipeline' },
  { name: '5-tasks', path: '/tasks' },
  { name: '5b-activity', path: '/activity' },
  { name: '6-recommendations', path: '/recommendations' },
  { name: '7-data-and-import', path: '/data' },
];

/** Elements that stick out past the viewport, and the page's own scroll width. */
async function findOverflow(page, viewportWidth) {
  return page.evaluate((limit) => {
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const overhang = Math.round(rect.right - limit);
      if (overhang > 1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className?.toString().slice(0, 60) ?? '',
          overhang,
          text: (el.textContent ?? '').trim().slice(0, 40),
        });
      }
    }
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders: offenders.slice(0, 12),
    };
  }, viewportWidth);
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

  for (const screen of SCREENS) {
    await page.goto(`${BASE}${screen.path}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1', { timeout: 10_000 });
    // Let fonts settle so text metrics in the screenshot are real.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);

    const dir = `${OUT}/${viewport.name}`;
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${screen.name}.png`, fullPage: true });

    const overflow = await findOverflow(page, viewport.width);
    const heading = await page.textContent('h1');

    report.push({
      viewport: viewport.name,
      screen: screen.name,
      heading: heading?.trim(),
      horizontalScroll: overflow.documentScrollWidth > viewport.width,
      scrollWidth: overflow.documentScrollWidth,
      offenders: overflow.offenders,
      consoleErrors: [...consoleErrors],
    });
    consoleErrors.length = 0;
  }

  await context.close();
}

await browser.close();
await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));

let problems = 0;
for (const row of report) {
  const flags = [];
  if (row.horizontalScroll) {
    flags.push(`H-SCROLL scrollWidth=${row.scrollWidth}`);
  }
  if (row.offenders.length) {
    flags.push(
      `OVERFLOW ${row.offenders
        .map((o) => `${o.tag}.${o.cls.split(' ')[0]}+${o.overhang}px`)
        .join(', ')}`,
    );
  }
  if (row.consoleErrors.length) flags.push(`CONSOLE ${row.consoleErrors.length}`);
  if (flags.length) problems += 1;
  console.log(
    `${row.viewport.padEnd(9)} ${row.screen.padEnd(22)} ${row.heading?.padEnd(20)} ${
      flags.length ? flags.join(' | ') : 'ok'
    }`,
  );
}
console.log(`\n${report.length} captures, ${problems} with layout flags.`);
