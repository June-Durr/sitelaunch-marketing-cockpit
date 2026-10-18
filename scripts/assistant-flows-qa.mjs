/**
 * Both contact flows, in a real browser, at a desktop size and a phone size.
 *
 * What this adds over the vitest suite: layout. jsdom has no box model, so it
 * cannot tell us that the message box fits a 390 pixel screen, that the panel
 * scrolls rather than clipping its buttons, or that nothing spills sideways.
 * This drives the real components in Chromium against the stubbed context in
 * qa/assistant-flows.tsx, so nothing it does can reach a model or a database.
 *
 *   node scripts/assistant-flows-qa.mjs
 *
 * Expects the dev server on 5173. Writes screenshots to qa-screens/.
 */

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.QA_BASE ?? 'http://localhost:5173';
const OUT = 'qa-screens';
mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch();

for (const flow of ['new', 'matched']) {
  for (const size of SIZES) {
    const label = `${flow} contact, ${size.name}`;
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      // A touch device for the phone run, so anything that reads the user agent
      // is reading a plausible one.
      userAgent: size.name === 'phone'
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
        : undefined,
      hasTouch: size.name === 'phone',
    });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto(`${BASE}/qa/assistant-flows.html?flow=${flow}`, {
      waitUntil: 'networkidle',
    });

    /* --------------------------------------------------- one ask, one plan --- */

    await page.getByRole('button', { name: 'Open the assistant' }).click();
    await page.getByLabel('What you want to say').fill(
      'Met ZZ Test Harness at the chamber mixer last night, said I would text examples',
    );
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    const message = page.getByLabel('The first message');
    await message.waitFor({ state: 'visible', timeout: 10_000 });

    const asks = await page.evaluate(() => window.__qa.asks);
    check(`${label}: one model request for the whole plan`, asks === 1, `asks=${asks}`);

    const firstBody = await message.inputValue();
    check(
      `${label}: the message is written and specific`,
      firstBody.includes('the chamber mixer') && firstBody.includes('examples'),
      firstBody.slice(0, 70),
    );

    const dateField = page.locator('input[type="date"]').first();
    const dateValue = await dateField.inputValue();
    check(`${label}: an initial action date is offered`, dateValue !== '', dateValue);

    const trackingVisible = await page
      .getByText(/Calendar and tracking: pending your save/)
      .isVisible();
    check(`${label}: tracking state is shown before saving`, trackingVisible);

    const writesBeforeSaving = await page.evaluate(
      () => window.__qa.capture.length + window.__qa.touch.length
        + window.__qa.draft.length + window.__qa.sent.length,
    );
    check(`${label}: showing the plan writes nothing`, writesBeforeSaving === 0);

    /* ------------------------------------------------ the layout, actually --- */

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${label}: nothing spills sideways`, overflow <= 0, `overflow=${overflow}px`);

    const box = await message.boundingBox();
    check(
      `${label}: the message box fits the viewport`,
      Boolean(box) && box.x >= 0 && box.x + box.width <= size.width + 1,
      box ? `x=${Math.round(box.x)} w=${Math.round(box.width)}` : 'no box',
    );

    await page.screenshot({ path: `${OUT}/${flow}-${size.name}-review.png`, fullPage: true });

    /* ------------------------------------- edits survive, and then one save --- */

    const edit = 'Hi ZZ, as promised I will text you examples after lunch.';
    await message.fill(edit);

    const saveButton = page.getByRole('button', { name: /^(Save this contact|Record this)$/ });
    await saveButton.click();

    const savedHead = page.getByText(/^(Contact saved\.|Contact recorded\.)$/);
    await savedHead.waitFor({ state: 'visible', timeout: 10_000 });

    const keptBody = await page.getByLabel('The first message').inputValue();
    check(`${label}: the edited wording survives the save`, keptBody === edit, keptBody.slice(0, 50));

    const afterSave = await page.evaluate(() => ({
      capture: window.__qa.capture.length,
      touch: window.__qa.touch.length,
      draft: window.__qa.draft.length,
      asks: window.__qa.asks,
      sent: window.__qa.sent.length,
    }));
    check(
      `${label}: saving wrote one record and kept one draft`,
      (flow === 'new' ? afterSave.capture === 1 && afterSave.touch === 0
        : afterSave.touch === 1 && afterSave.capture === 0) && afterSave.draft === 1,
      JSON.stringify(afterSave),
    );
    check(`${label}: no second model request after saving`, afterSave.asks === 1);
    check(`${label}: saving records no send`, afterSave.sent === 0);

    /* ------------------------------- copying is not sending, and then it is --- */

    /*
     * Copying, and whichever of the two honest outcomes this browser allows.
     *
     * Headless Chromium usually refuses clipboard writes, and the refusal path
     * is deliberately not recorded as a copy: text that never reached the
     * clipboard was not copied. Either branch is correct, and neither may
     * record a send, so the check names which one it took rather than passing
     * on a count of zero without noticing.
     */
    await page.getByRole('button', { name: 'Copy, not sent' }).click();
    await page.waitForTimeout(400);
    const afterCopy = await page.evaluate(() => ({
      copied: window.__qa.copied.length,
      sent: window.__qa.sent.length,
    }));
    const refused = await page.getByText(/Clipboard unavailable/).count() > 0;
    const copyNoted = await page.getByText(/Noted as copied/).count() > 0;
    check(
      `${label}: copying either copies or says it could not, and never sends`,
      afterCopy.sent === 0
      && ((refused && afterCopy.copied === 0) || (copyNoted && afterCopy.copied === 1)),
      `${refused ? 'clipboard refused' : 'clipboard worked'}, ${JSON.stringify(afterCopy)}`,
    );

    const messagesButton = page.getByRole('button', { name: 'Open in Messages' });
    check(`${label}: Messages is offered for a number`, await messagesButton.count() > 0);

    await page.getByRole('button', { name: 'Add to phone contacts' }).click();
    const dedupeNote = page.getByText(/does not deduplicate anything/);
    check(`${label}: the contact card refuses to claim deduplication`, await dedupeNote.isVisible());
    await page.getByRole('button', { name: 'Hide the contact card' }).click();

    await page.screenshot({ path: `${OUT}/${flow}-${size.name}-saved.png`, fullPage: true });

    const confirm = page.getByRole('button', { name: 'I sent this' });
    await confirm.scrollIntoViewIfNeeded();
    // Twice, quickly. One send is the whole point of the token.
    await confirm.click();
    await confirm.click({ force: true }).catch(() => {});
    await page.getByText('Recorded as sent.').waitFor({ state: 'visible', timeout: 10_000 });

    const afterSend = await page.evaluate(() => ({
      sent: window.__qa.sent.length,
      updates: window.__qa.updates.length,
    }));
    check(`${label}: a double press records one send`, afterSend.sent === 1, JSON.stringify(afterSend));
    check(`${label}: the reviewed reminder is scheduled by the same press`, afterSend.updates >= 1);

    const silence = await page.getByText(/not the same as them not replying/).count();
    check(`${label}: it never claims they did not reply`, silence > 0);

    await page.screenshot({ path: `${OUT}/${flow}-${size.name}-sent.png`, fullPage: true });

    check(`${label}: no console or page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));

    await context.close();
  }
}

await browser.close();
console.log(failures === 0 ? '\nALL BROWSER CHECKS PASSED' : `\n${failures} browser check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
