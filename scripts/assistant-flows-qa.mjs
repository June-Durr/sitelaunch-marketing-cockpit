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

for (const flow of ['new', 'matched', 'thin']) {
  for (const profile of ['missing', 'saved']) {
  for (const size of SIZES) {
    const label = `${flow} contact, ${profile} profile, ${size.name}`;
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

    await page.goto(`${BASE}/qa/assistant-flows.html?flow=${flow}&profile=${profile}`, {
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
      `${label}: the message is written`,
      flow === 'thin'
        // Nothing was promised and no place was recorded, so the message is
        // short and says so through its gaps rather than inventing either.
        ? firstBody.trim().length > 0
        : firstBody.includes('the chamber mixer') && firstBody.includes('examples'),
      firstBody.slice(0, 70),
    );

    /*
     * The follow-up field, by its label rather than by position.
     *
     * The first date input on these cards is the day the meeting happened, so
     * taking .first() was checking that the meeting had a date, which it always
     * does. The label is the only thing that identifies the right field, and it
     * carries the answer too: suggested, from what you said, or neither.
     */
    const dateField = page.getByLabel(/^Next follow-up/);
    const dateValue = await dateField.inputValue();
    const dateLabel = await dateField.evaluate((node) => node.closest('label')?.innerText ?? '');

    if (flow === 'thin') {
      // Nothing promised and no day named, so the Cockpit's own rhythm decides
      // rather than this card dragging a date to today.
      check(
        `${label}: no date is invented when nothing is owed`,
        dateValue === '' && /usual rhythm/.test(dateLabel),
        `value=${JSON.stringify(dateValue)}`,
      );
    } else {
      check(
        `${label}: an initial action date is offered, and says where it came from`,
        dateValue !== '' && /suggested|from what you said/.test(dateLabel),
        `${dateValue} :: ${dateLabel.split(String.fromCharCode(10))[0]}`,
      );
    }

    const trackingVisible = await page
      .getByText(/Calendar and tracking: pending your save/)
      .isVisible();
    check(`${label}: tracking state is shown before saving`, trackingVisible);

    /*
     * The profile, and the one thing that must be true either way: no
     * placeholder in a message somebody can copy.
     */
    const profileLink = page.getByRole('link', { name: 'Complete your profile' });
    const nameBoxes = await page.getByLabel(/^Your name/).count();
    if (profile === 'missing') {
      check(
        `${label}: one link asks for the profile, and no form does`,
        await profileLink.count() === 1 && nameBoxes === 0,
        `links=${await profileLink.count()} boxes=${nameBoxes}`,
      );
      check(
        `${label}: the unsigned message carries no placeholder`,
        !/\[|Your Name|your name here/i.test(firstBody),
        firstBody.slice(0, 60),
      );
    } else {
      check(
        `${label}: the message signs itself and nothing asks again`,
        firstBody.includes('Invented Sender from Invented Studios')
        && await profileLink.count() === 0,
        firstBody.slice(0, 70),
      );
    }

    /* The details are summarised, with the inputs a press away. */
    const toggle = page.getByRole('button', { name: 'Edit details' });
    // Next step, because it is a field both cards have: a new contact has no
    // "what happened" and a recorded conversation has no business name.
    const inputsBefore = await page.getByLabel(/^Next step/).count();
    await toggle.click();
    const inputsAfter = await page.getByLabel(/^Next step/).count();
    await page.getByRole('button', { name: 'Done editing' }).click();
    check(
      `${label}: details are summarised until asked for`,
      inputsBefore === 0 && inputsAfter === 1,
      `before=${inputsBefore} after=${inputsAfter}`,
    );

    /* The message leads: it comes before the details control in the document. */
    const messageFirst = await page.evaluate(() => {
      const box = document.querySelector('textarea[aria-label="The first message"]');
      const details = [...document.querySelectorAll('button')]
        .find((node) => node.textContent?.trim().startsWith('Edit details'));
      if (!box || !details) return false;
      return (box.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    check(`${label}: the message comes before the details control`, messageFirst);

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

    await page.screenshot({ path: `${OUT}/${flow}-${profile}-${size.name}-review.png`, fullPage: true });

    /* ------------------------------------- edits survive, and then one save --- */

    const edit = 'Hi ZZ, as promised I will text you examples after lunch.';
    await message.fill(edit);

    const saveButton = page.getByRole('button', { name: /^(Save this contact|Record this)$/ });
    await saveButton.click();

    const savedHead = page.getByText(/^(Contact saved\.|Conversation recorded\.)$/);
    await savedHead.waitFor({ state: 'visible', timeout: 10_000 });

    /*
     * The transition itself, which is what somebody could not read.
     *
     * The review has to be gone, the statement has to be announced, and nothing
     * may still be telling them to record what is already recorded.
     */
    check(
      `${label}: the saved statement is announced`,
      (await savedHead.getAttribute('role')) === 'status',
      await savedHead.textContent(),
    );
    check(
      `${label}: the review it replaces is gone`,
      await page.getByRole('button', { name: /^(Save this contact|Record this)$/ }).count() === 0
      && await page.getByText(/Next: (save them|record it)/).count() === 0,
    );
    check(
      `${label}: the next action is the one that is actually next`,
      await page.getByText(/Next: copy the message or open Messages/).count() > 0,
    );
    check(
      `${label}: the edit control is named for what it does`,
      await page.getByRole('button', { name: 'Edit saved details' }).count() === 1
      && await page.getByText(/Something is wrong/).count() === 0,
    );
    check(
      `${label}: the sync state is stated rather than implied`,
      await page.getByText(/Saved and synced\.|are syncing|did not go through|queue will retry/)
        .count() > 0,
      (await page.locator('.asst-sync').first().textContent() ?? '').slice(0, 60),
    );

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

    await page.screenshot({ path: `${OUT}/${flow}-${profile}-${size.name}-saved.png`, fullPage: true });

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

    await page.screenshot({ path: `${OUT}/${flow}-${profile}-${size.name}-sent.png`, fullPage: true });

    check(`${label}: no console or page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));

    await context.close();
  }
  }
}

await browser.close();
console.log(failures === 0 ? '\nALL BROWSER CHECKS PASSED' : `\n${failures} browser check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
