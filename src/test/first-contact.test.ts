/**
 * The first contact flow, in the parts that have no screen.
 *
 * Three decisions get made the moment a contact is saved: when to follow up,
 * what the first message says, and what goes on the contact card. All three are
 * composed from recorded facts rather than generated, because the rule for this
 * flow is that it invents nothing, and a template cannot invent a portfolio
 * link or decide what your company is called.
 *
 * Every person below is invented.
 */

import { describe, expect, it } from 'vitest';

import {
  AFTER_QUESTION_DAYS, AFTER_REPLY_DAYS, AFTER_STATEMENT_DAYS, asksSomething,
  FRESH_CONTACT_DAYS, suggestAfterSend, suggestFirstFollowUp,
} from '../assistant/followUpSuggestion';
import {
  composeFirstMessage, firstName, messagesUrl, whenWeMet,
} from '../assistant/firstMessage';
import {
  buildVCard, cardFileName, cardPreview, contactSupport, escapeVCardValue, structuredName,
} from '../assistant/contactCard';
import { addDays } from '../lib/dates';

const TODAY = '2026-10-17';

/* ================================================ when to follow up === */

describe('the first follow-up after meeting somebody', () => {
  it('does what was promised, today, rather than in a month', () => {
    // The whole point of this change. Thirty days beside a promise to text
    // examples is a reminder to have already let somebody down.
    const suggestion = suggestFirstFollowUp({
      statedDate: null, promise: 'Text him examples', today: TODAY,
    });
    expect(suggestion.date).toBe(TODAY);
    expect(suggestion.basis).toBe('promise');
    expect(suggestion.suggested).toBe(true);
    expect(suggestion.reason).toContain('text him examples');
    expect(suggestion.reason).toContain('owed');
  });

  it('suggests tomorrow when nothing was promised', () => {
    const suggestion = suggestFirstFollowUp({
      statedDate: null, promise: null, today: TODAY,
    });
    expect(suggestion.date).toBe(addDays(TODAY, FRESH_CONTACT_DAYS));
    expect(suggestion.basis).toBe('fresh');
    expect(suggestion.reason).toContain('app suggesting');
  });

  it('never suggests thirty days out for somebody just met', () => {
    for (const promise of [null, 'send examples']) {
      const suggestion = suggestFirstFollowUp({ statedDate: null, promise, today: TODAY });
      const days = (Date.parse(`${suggestion.date}T00:00:00Z`)
        - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000;
      expect(days).toBeLessThanOrEqual(1);
    }
  });

  it('keeps a day the person named, and does not call it a suggestion', () => {
    const suggestion = suggestFirstFollowUp({
      statedDate: '2026-10-21', promise: 'Text him examples', today: TODAY,
    });
    expect(suggestion.date).toBe('2026-10-21');
    expect(suggestion.basis).toBe('stated');
    expect(suggestion.suggested).toBe(false);
    expect(suggestion.reason).toContain('You named this day');
  });

  it('leaves an acronym alone when it reads the promise back', () => {
    const suggestion = suggestFirstFollowUp({
      statedDate: null, promise: 'DM him the examples', today: TODAY,
    });
    expect(suggestion.reason).toContain('DM him the examples');
  });
});

/* ============================================ after a confirmed send === */

describe('the next follow-up after a send', () => {
  const SENT = '2026-10-17';

  it('chases a question sooner than a statement', () => {
    const asked = suggestAfterSend({
      sentOn: SENT, body: 'Anything in particular you want to see?',
      repliesRecorded: 0, statedDate: null,
    });
    const told = suggestAfterSend({
      sentOn: SENT, body: 'I will get those examples over to you.',
      repliesRecorded: 0, statedDate: null,
    });

    expect(asked.date).toBe(addDays(SENT, AFTER_QUESTION_DAYS));
    expect(told.date).toBe(addDays(SENT, AFTER_STATEMENT_DAYS));
    expect(AFTER_QUESTION_DAYS).toBeLessThan(AFTER_STATEMENT_DAYS);
  });

  it('never says they have not replied', () => {
    // The Cockpit knows what has been recorded. Nobody logs every reply, and
    // treating an empty log as silence chases people for answers they gave.
    for (const body of ['Did you get those?', 'Sending those over.']) {
      const suggestion = suggestAfterSend({
        sentOn: SENT, body, repliesRecorded: 0, statedDate: null,
      });
      const said = suggestion.reason.toLowerCase();
      expect(said).toContain('nothing is recorded either way');
      expect(said).toContain('not the same as them not replying');
      expect(said).not.toContain('no response');
      expect(said).not.toContain('has not replied');
      expect(said).not.toContain('did not reply');
    }
  });

  it('goes back to the ordinary rhythm for somebody who has replied before', () => {
    const suggestion = suggestAfterSend({
      sentOn: SENT, body: 'Sending those over.', repliesRecorded: 2, statedDate: null,
    });
    expect(suggestion.date).toBe(addDays(SENT, AFTER_REPLY_DAYS));
    expect(suggestion.basis).toBe('reply_on_file');
    expect(suggestion.reason).toContain('replied before');
  });

  it('still prefers a day the person named', () => {
    const suggestion = suggestAfterSend({
      sentOn: SENT, body: 'Can we talk Thursday?', repliesRecorded: 0,
      statedDate: '2026-10-22',
    });
    expect(suggestion.date).toBe('2026-10-22');
    expect(suggestion.suggested).toBe(false);
  });

  it('knows a question when it sees one', () => {
    expect(asksSomething('What do you think?')).toBe(true);
    expect(asksSomething('Here you go.')).toBe(false);
  });
});

/* ================================================== the first message === */

describe('composing the first message', () => {
  const INTRO = { name: 'Invented Sender', business: 'Invented Studios' };

  it('says who it is from, where you met and what you owe them', () => {
    const { body, gaps } = composeFirstMessage({
      contactName: 'ZZ Test Harness',
      introduction: INTRO,
      metWhere: 'the chamber mixer',
      metOn: '2026-10-16',
      today: TODAY,
      promise: 'Text him examples',
    });

    expect(body).toBe(
      "Hi ZZ, it's Invented Sender from Invented Studios. "
      + 'Good to meet you at the chamber mixer yesterday. '
      + 'I said I would text him examples, so I wanted to follow through on that.',
    );
    expect(gaps).toEqual([]);
  });

  it('invents nothing it was not given', () => {
    const { body } = composeFirstMessage({
      contactName: 'ZZ Test Harness',
      introduction: INTRO,
      metWhere: 'the chamber mixer',
      metOn: '2026-10-16',
      today: TODAY,
      promise: 'send examples',
    });

    // No link, no attachment claim, no invented portfolio, nobody else named.
    expect(body).not.toMatch(/https?:/);
    expect(body).not.toContain('[');
    expect(body.toLowerCase()).not.toContain('attached');
    expect(body.toLowerCase()).not.toContain('here they are');
    expect(body.toLowerCase()).not.toContain('my colleague');
    expect(body.toLowerCase()).not.toContain('portfolio');
  });

  it('leaves out the introduction rather than inventing one, and says so', () => {
    const { body, gaps } = composeFirstMessage({
      contactName: 'ZZ Test Harness',
      introduction: { name: null, business: null },
      metWhere: 'the mixer',
      metOn: TODAY,
      today: TODAY,
      promise: 'send examples',
    });

    expect(body).toContain('Hi ZZ,');
    // The one thing it must never do.
    expect(body).not.toContain('[Your Name]');
    expect(body).not.toContain('Your Name');
    expect(gaps.join(' ')).toContain('how you introduce yourself');
  });

  it('runs the greeting on in lower case when there is no introduction', () => {
    // "Hi ZZ, Good to meet you" reads like two half sentences stuck together.
    const { body } = composeFirstMessage({
      contactName: 'ZZ Test Harness',
      introduction: { name: null, business: null },
      metWhere: 'the chamber mixer',
      metOn: '2026-10-16',
      today: TODAY,
      promise: 'text him examples',
    });
    expect(body).toContain('Hi ZZ, good to meet you at the chamber mixer yesterday.');
    expect(body).not.toContain('Hi ZZ, Good');
  });

  it('starts a fresh sentence after an introduction, which is a whole one', () => {
    const { body } = composeFirstMessage({
      contactName: 'ZZ Test Harness',
      introduction: { name: 'Invented Sender', business: null },
      metWhere: 'the mixer',
      metOn: '2026-10-16',
      today: TODAY,
      promise: null,
    });
    expect(body).toContain('. Good to meet you at the mixer yesterday.');
  });

  it('runs on to the promise when that is the only thing after the greeting', () => {
    const { body } = composeFirstMessage({
      contactName: 'ZZ Test Harness',
      introduction: { name: null, business: null },
      metWhere: null, metOn: null, today: TODAY,
      promise: 'send examples',
    });
    expect(body).toContain('Hi ZZ, I said I would send examples');
  });

  it('drops the business from the introduction when there is not one', () => {
    const { body } = composeFirstMessage({
      contactName: 'ZZ Test Harness',
      introduction: { name: 'Invented Sender', business: null },
      metWhere: null, metOn: null, today: TODAY, promise: null,
    });
    expect(body).toContain("it's Invented Sender.");
    expect(body).not.toContain('from');
  });

  it('says today, yesterday, or the actual day, and nothing vaguer', () => {
    expect(whenWeMet(TODAY, TODAY)).toBe('today');
    expect(whenWeMet('2026-10-16', TODAY)).toBe('yesterday');
    expect(whenWeMet('2026-10-02', TODAY)).toContain('on ');
    expect(whenWeMet(null, TODAY)).toBeNull();
  });

  it('reports every gap rather than filling it', () => {
    const { body, gaps } = composeFirstMessage({
      contactName: null,
      introduction: { name: null, business: null },
      metWhere: null, metOn: null, today: TODAY, promise: null,
    });
    expect(body).toBe('Hi,');
    expect(gaps).toHaveLength(3);
    expect(gaps.join(' ')).toContain('where or when you met');
    expect(gaps.join(' ')).toContain('promised them');
  });

  it('greets a contact whose name is only a placeholder without using it', () => {
    expect(firstName('Name pending')).toBeNull();
    expect(firstName('ZZ Test Harness')).toBe('ZZ');
    const { body } = composeFirstMessage({
      contactName: 'Name pending',
      introduction: { name: 'Invented Sender', business: null },
      metWhere: null, metOn: null, today: TODAY, promise: null,
    });
    expect(body).not.toContain('Name pending');
    expect(body.startsWith('Hi, ')).toBe(true);
  });
});

/* ======================================== handing it to a phone === */

describe('the link that opens a messaging app', () => {
  const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 15)';

  it('uses the separator each platform actually wants', () => {
    expect(messagesUrl('305 555 0188', 'Hello', IOS)).toContain('&body=');
    expect(messagesUrl('305 555 0188', 'Hello', ANDROID)).toContain('?body=');
  });

  it('keeps the number dialable and the text intact', () => {
    const url = messagesUrl('+1 (305) 555-0188', 'Hi ZZ, good to meet you', ANDROID);
    expect(url).toContain('sms:+13055550188');
    expect(url).toContain(encodeURIComponent('Hi ZZ, good to meet you'));
  });

  it('refuses a number too short to be one', () => {
    expect(messagesUrl('123', 'Hello', ANDROID)).toBeNull();
    expect(messagesUrl('', 'Hello', ANDROID)).toBeNull();
  });
});

/* ============================================= the contact card === */

describe('the contact card', () => {
  const INPUT = {
    name: 'ZZ Test Harness',
    organization: 'ZZ Test Taqueria',
    phone: '305 555 0188',
    email: null,
    notes: ['Met at the chamber mixer', 'Wants a one page site'],
  };

  it('is a vCard a phone will open', () => {
    const card = buildVCard(INPUT)!;
    expect(card.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true);
    expect(card).toContain('FN:ZZ Test Harness');
    expect(card).toContain('N:Harness;ZZ Test;;;');
    expect(card).toContain('ORG:ZZ Test Taqueria');
    expect(card).toContain('TEL;TYPE=CELL:305 555 0188');
    expect(card).toContain('NOTE:Met at the chamber mixer\\nWants a one page site');
    expect(card.endsWith('END:VCARD\r\n')).toBe(true);
  });

  it('escapes the characters that are structural in the format', () => {
    // A business called "Smith, Jones and Co" splits a field in two without this.
    expect(escapeVCardValue('Smith, Jones; and Co')).toBe('Smith\\, Jones\\; and Co');
    expect(escapeVCardValue('a\\b')).toBe('a\\\\b');
    expect(escapeVCardValue('one\ntwo')).toBe('one\\ntwo');

    const card = buildVCard({ ...INPUT, organization: 'Smith, Jones and Co' })!;
    expect(card).toContain('ORG:Smith\\, Jones and Co');
  });

  it('carries only the notes that were chosen', () => {
    const card = buildVCard({ ...INPUT, notes: ['Wants a one page site'] })!;
    expect(card).toContain('NOTE:Wants a one page site');
    expect(card).not.toContain('chamber mixer');
  });

  it('leaves out every field there is nothing for', () => {
    const card = buildVCard({
      name: 'ZZ Test Harness', organization: null, phone: null, email: null, notes: [],
    })!;
    expect(card).not.toContain('ORG:');
    expect(card).not.toContain('TEL');
    expect(card).not.toContain('NOTE');
  });

  it('refuses to build a card for nobody', () => {
    expect(buildVCard({
      name: null, organization: null, phone: '305 555 0188', email: null, notes: [],
    })).toBeNull();
  });

  it('splits a name the way the format wants, and copes with one word', () => {
    expect(structuredName('ZZ Test Harness')).toEqual({ family: 'Harness', given: 'ZZ Test' });
    expect(structuredName('Harness')).toEqual({ family: '', given: 'Harness' });
  });

  it('previews exactly what the file will hold', () => {
    const preview = cardPreview(INPUT);
    expect(preview.map((f) => f.label)).toEqual(['Name', 'Business', 'Phone', 'Note', 'Note']);
    expect(preview[2].value).toBe('305 555 0188');
  });

  it('names the file something findable', () => {
    expect(cardFileName(INPUT)).toBe('ZZ-Test-Harness.vcf');
    expect(cardFileName({ ...INPUT, name: null })).toBe('ZZ-Test-Taqueria.vcf');
  });
});

describe('what this browser can do with contacts', () => {
  it('reports exporting separately from reading, because they are not the same', () => {
    const android = contactSupport(
      { userAgent: 'Mozilla/5.0 (Linux; Android 15)', contacts: {} }, true,
    );
    expect(android.canExport).toBe(true);
    expect(android.canRead).toBe(true);
    expect(android.looksLikePhone).toBe(true);
  });

  it('knows a desktop browser has no contact picker', () => {
    const desktop = contactSupport({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }, true);
    expect(desktop.canRead).toBe(false);
    expect(desktop.looksLikePhone).toBe(false);
    // Exporting still works: a .vcf download is not a platform feature.
    expect(desktop.canExport).toBe(true);
  });

  it('says it cannot export when the browser cannot make a file url', () => {
    expect(contactSupport({ userAgent: 'anything' }, false).canExport).toBe(false);
  });
});
