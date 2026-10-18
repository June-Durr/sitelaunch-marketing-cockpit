/**
 * The first message to somebody you just met, composed rather than generated.
 *
 * WHY NO MODEL TOUCHES THIS
 *
 * The rule for this message is "never invent examples, links, introductions or
 * details about another person", and the cheapest way to guarantee that is to
 * build the sentence out of facts that are already on file. A template cannot
 * hallucinate a portfolio link or decide what your company is called. It also
 * costs nothing and appears instantly, which matters for something shown the
 * moment a contact is saved.
 *
 * WHAT IT LEAVES OUT
 *
 * Anything it does not know. There is no filler, no bracketed placeholder and
 * no cheerful invention: a missing introduction becomes a gap the screen asks
 * you to fill, not "[Your Name]" and not a guess. Every sentence below traces
 * to something the person typed or saved.
 */

import { formatDay } from '../lib/dates';
import { isPlaceholderName } from '../lib/leadLabel';

export interface Introduction {
  /** What you are called. Null until somebody has said. */
  name: string | null;
  /** The business you are from. Null is fine; the line just gets shorter. */
  business: string | null;
}

export interface FirstMessageInput {
  /** Their name as saved, which may be the placeholder. */
  contactName: string | null;
  introduction: Introduction;
  /** Where you met, in the words from the capture. */
  metWhere: string | null;
  metOn: string | null;
  today: string;
  /** What you said you would do, in your words. */
  promise: string | null;
}

export interface FirstMessageDraft {
  body: string;
  /**
   * What the message could not say, and why, in words for the screen.
   *
   * Shown rather than papered over. A message that goes out without saying who
   * it is from is worse than one that waits a minute while you say.
   */
  gaps: string[];
}

/** The part of a name you would start a text message with. */
export function firstName(name: string | null): string | null {
  if (isPlaceholderName(name)) return null;
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first === '' ? null : first;
}

/** "today", "yesterday", or the day itself. Never a vaguer word than is true. */
export function whenWeMet(metOn: string | null, today: string): string | null {
  if (!metOn) return null;
  if (metOn === today) return 'today';
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (metOn === yesterday) return 'yesterday';
  return `on ${formatDay(metOn)}`;
}

/**
 * Compose the message.
 *
 * Four sentences at most, in the order somebody actually says them: who this
 * is, where we met, what I owe you. Nothing else. It is a text message, so it
 * is one paragraph rather than a letter.
 */
export function composeFirstMessage(input: FirstMessageInput): FirstMessageDraft {
  const gaps: string[] = [];
  const sentences: string[] = [];

  const first = firstName(input.contactName);
  const who = (input.introduction.name ?? '').trim();
  const where = (input.introduction.business ?? '').trim();

  /*
   * Who this is from.
   *
   * No introduction on file means the sentence is left out and the gap is
   * reported. Inventing a name is the one thing this must never do, and
   * "[Your Name]" going out in a real text message is worse than inventing one.
   */
  /*
   * Whether the greeting is still waiting for the rest of its sentence.
   *
   * With an introduction, "Hi ZZ, it's Alberto from SiteLaunch." is a complete
   * sentence and what follows starts a new one. Without one the greeting ends
   * on a comma, and the next line has to continue it in lower case: "Hi ZZ,
   * Good to meet you" reads like two half sentences stuck together.
   */
  let greetingOpen = false;

  if (who !== '') {
    const intro = where === '' ? `it's ${who}` : `it's ${who} from ${where}`;
    sentences.push(first ? `Hi ${first}, ${intro}.` : `Hi, ${intro}.`);
  } else {
    sentences.push(first ? `Hi ${first},` : 'Hi,');
    greetingOpen = true;
    gaps.push(
      'This does not say who it is from, because the Cockpit has not been told '
      + 'how you introduce yourself. Add it below and the line writes itself.',
    );
  }

  /** Continue the greeting in lower case, or start a sentence of its own. */
  const add = (sentence: string) => {
    sentences.push(greetingOpen ? lowerFirst(sentence) : sentence);
    greetingOpen = false;
  };

  const when = whenWeMet(input.metOn, input.today);
  const place = (input.metWhere ?? '').trim();
  if (place !== '' && when !== null) {
    add(`Good to meet you at ${place} ${when}.`);
  } else if (place !== '') {
    add(`Good to meet you at ${place}.`);
  } else if (when !== null) {
    add(`Good to meet you ${when}.`);
  } else {
    gaps.push(
      'It does not say where or when you met, because neither was recorded. '
      + 'Adding either makes this much harder to ignore.',
    );
  }

  /*
   * The thing you owe them.
   *
   * Restated as the commitment it was, with no claim that it has been done and
   * nothing attached. "Here they are" would be a lie the moment this is sent
   * without anything attached, and attaching something is not this app's job.
   */
  const promise = (input.promise ?? '').trim().replace(/\.$/, '');
  if (promise !== '') {
    add(`I said I would ${lowerFirst(promise)}, so I wanted to follow through on that.`);
  } else {
    gaps.push(
      'Nothing was recorded that you promised them, so this message asks for '
      + 'nothing and offers nothing. Worth adding a line before you send it.',
    );
  }

  return { body: sentences.join(' '), gaps };
}

function lowerFirst(text: string): string {
  if (text === '') return text;
  if (text.slice(0, 2) === text.slice(0, 2).toUpperCase() && text.length > 1) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/* --------------------------------------------------- handing it to a phone --- */

/**
 * A link that opens the device's messaging app with the text already in it.
 *
 * iOS and Android disagree about the separator, and have since the scheme was
 * first used: Apple's software wants `&body=`, everything else wants `?body=`.
 * There is no feature detection for a URL scheme, so the platform is read off
 * the user agent, which is the one thing it is still reliable for.
 *
 * On a desktop with no messaging app registered, following this link does
 * nothing at all. The screen says so rather than leaving somebody clicking.
 */
export function messagesUrl(phone: string, body: string, userAgent: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 7) return null;
  const apple = /iphone|ipad|ipod|macintosh/i.test(userAgent);
  const separator = apple ? '&' : '?';
  return `sms:${digits}${separator}body=${encodeURIComponent(body)}`;
}
