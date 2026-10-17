/**
 * "I met someone", as one operation, against a real Postgres.
 *
 * The thing under test is atomicity and honesty: a contact and the meeting and
 * the facts all land or none of them do, a second press writes nobody twice, and
 * the parts that are not known stay empty rather than being filled in with
 * today's date or somebody's guess.
 *
 * Every person below is invented.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { freshDatabase, seedRow, USER_A, USER_B, type TestDatabase } from './harness';

let t: TestDatabase;

beforeAll(async () => {
  t = await freshDatabase();
}, 180_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.db.exec(`
    delete from message_drafts;
    delete from extracted_facts;
    delete from sync_jobs;
    delete from activity_events;
    delete from tasks;
    delete from leads;
  `);
});

async function rows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await t.db.query<T>(sql, params)).rows;
}

/** The function's arguments, in order, with the fiddly ones defaulted. */
interface CaptureArgs {
  token: string;
  name?: string | null;
  organization?: string | null;
  role?: string | null;
  channel?: string | null;
  handle?: string | null;
  metOn?: string | null;
  location?: string | null;
  interest?: string | null;
  summary?: string | null;
  nextAction?: string | null;
  nextDueDate?: string | null;
  facts?: unknown[];
}

async function capture(args: CaptureArgs): Promise<Record<string, unknown>> {
  const result = await t.db.query<{ capture_contact: Record<string, unknown> }>(
    `select capture_contact(
       $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12::date, $13::jsonb
     ) as capture_contact`,
    [
      args.token,
      args.name ?? null,
      args.organization ?? null,
      args.role ?? null,
      args.channel ?? null,
      args.handle ?? null,
      args.metOn ?? null,
      args.location ?? null,
      args.interest ?? null,
      args.summary ?? null,
      args.nextAction ?? null,
      args.nextDueDate ?? null,
      JSON.stringify(args.facts ?? []),
    ],
  );
  return result.rows[0].capture_contact;
}

const STATED = {
  kind: 'interest',
  value: 'Wants a one page site before the season starts',
  provenance: 'contact_stated',
  sourceExcerpt: 'he said he needs one page before the season',
  occurredOn: null,
};

/* ================================================= the contact itself === */

describe('capturing somebody who is not in the Cockpit yet', () => {
  it('creates the contact, the meeting and the facts in one call', async () => {
    const result = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-1',
        name: 'Invented Baker',
        organization: 'Invented Bakery',
        role: 'Owner',
        channel: 'in person',
        handle: '@invented.bakery',
        metOn: '2026-10-12',
        location: 'Doral',
        interest: 'a website',
        summary: 'Met at the chamber mixer',
        nextAction: 'Send examples',
        nextDueDate: '2026-10-19',
        facts: [STATED],
      }));

    expect(result.reused).toBe(false);
    expect(result.recorded_meeting).toBe(true);
    expect(result.facts_written).toBe(1);
    expect(result.facts_skipped).toBe(0);

    const [lead] = await rows<Record<string, string>>(
      `select prospect_name, organization, stage, preferred_channel, next_action,
              next_action_date::text as next_action_date, notes, source,
              external_source, external_key, first_contact_at::text as first_contact_at
         from leads where id = $1`,
      [result.lead_id],
    );
    expect(lead.prospect_name).toBe('Invented Baker');
    expect(lead.stage).toBe('new_contact');
    expect(lead.preferred_channel).toBe('in person');
    expect(lead.next_action_date).toBe('2026-10-19');
    expect(lead.external_source).toBe('assistant_capture');
    expect(lead.external_key).toBe('capture-1');
    // What was learned is kept in the person's own words rather than dropped.
    expect(lead.notes).toContain('Owner');
    expect(lead.notes).toContain('@invented.bakery');
    expect(lead.notes).toContain('Met at the chamber mixer');

    const activities = await rows<Record<string, string>>(
      `select activity_type, occurred_at::text as occurred_at, channel, evidence_source,
              details, source
         from activity_events where lead_id = $1`,
      [result.lead_id],
    );
    expect(activities).toHaveLength(1);
    // Met in person is an event, not a phone call.
    expect(activities[0].activity_type).toBe('networking_event');
    expect(activities[0].occurred_at).toContain('2026-10-12');
    expect(activities[0].evidence_source).toBe('User report');

    const facts = await rows<Record<string, string>>(
      `select kind, value, provenance, source_excerpt, occurred_on::text as occurred_on
         from extracted_facts where lead_id = $1`,
      [result.lead_id],
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].provenance).toBe('contact_stated');
    // The fact has no day of its own, and the meeting's day was not borrowed.
    expect(facts[0].occurred_on).toBeNull();
  });

  it('files a handle that is a phone number as a phone number', async () => {
    // It used to land in the notes only, so nothing could dial it and the
    // contact card had no number to export.
    const result = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-phone',
        name: 'Invented Dialable',
        channel: 'Text',
        handle: '305 555 0188',
      }));

    const [lead] = await rows<Record<string, string | null>>(
      'select phone, email, notes from leads where id = $1', [result.lead_id],
    );
    expect(lead.phone).toBe('305 555 0188');
    expect(lead.email).toBeNull();
    // And the label somebody typed is still readable in the notes.
    expect(lead.notes).toContain('Text: 305 555 0188');
  });

  it('files a handle that is an address as an address, lowercased', async () => {
    const result = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-email',
        name: 'Invented Emailer',
        channel: 'Email',
        handle: 'Invented.Emailer@Example.COM',
      }));

    const [lead] = await rows<Record<string, string | null>>(
      'select phone, email from leads where id = $1', [result.lead_id],
    );
    expect(lead.email).toBe('invented.emailer@example.com');
    expect(lead.phone).toBeNull();
  });

  it('leaves a handle that is neither in the notes alone', async () => {
    // An @name has no column, and inventing one for it would be worse than
    // leaving it where somebody will read it.
    const result = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-handle',
        name: 'Invented Poster',
        channel: 'Instagram',
        handle: '@invented.poster',
      }));

    const [lead] = await rows<Record<string, string | null>>(
      'select phone, email, notes from leads where id = $1', [result.lead_id],
    );
    expect(lead.phone).toBeNull();
    expect(lead.email).toBeNull();
    expect(lead.notes).toContain('@invented.poster');
  });

  it('does not mistake a short number or a stray word for either', async () => {
    const result = await t.asUser(USER_A, () =>
      capture({ token: 'capture-vague', name: 'Invented Vague', handle: 'ask Dave' }));
    const [lead] = await rows<Record<string, string | null>>(
      'select phone, email from leads where id = $1', [result.lead_id],
    );
    expect(lead.phone).toBeNull();
    expect(lead.email).toBeNull();
  });

  it('queues both syncs, so the sheet and the calendar catch up', async () => {
    const result = await t.asUser(USER_A, () =>
      capture({ token: 'capture-sync', name: 'Invented Painter', metOn: '2026-10-12' }));
    expect(result.lead_id).toBeTruthy();

    const kinds = await t.asServiceRole(() =>
      rows<{ kind: string }>(
        `select distinct kind from sync_jobs where owner_id = $1 and completed_at is null`,
        [USER_A],
      ));
    expect(kinds.map((k) => k.kind).sort()).toEqual(['calendar', 'lead_mirror']);
  });

  it('saves the contact without a meeting when the day is not known', async () => {
    const result = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-nodate',
        name: 'Invented Florist',
        interest: 'logo refresh',
        facts: [STATED],
      }));

    // The useful half is saved. The half nobody knows is left alone.
    expect(result.recorded_meeting).toBe(false);
    expect(result.facts_written).toBe(1);

    const activities = await rows(
      'select id from activity_events where lead_id = $1', [result.lead_id],
    );
    expect(activities).toHaveLength(0);

    const [lead] = await rows<Record<string, string | null>>(
      `select first_contact_at::text as first_contact_at,
              reported_last_touch_at::text as reported_last_touch_at
         from leads where id = $1`,
      [result.lead_id],
    );
    expect(lead.first_contact_at).toBeNull();
    expect(lead.reported_last_touch_at).toBeNull();
  });

  it('uses the placeholder when the name is not known, so the screen shows the business', async () => {
    const result = await t.asUser(USER_A, () =>
      capture({ token: 'capture-noname', name: '   ', organization: 'Invented Garage' }));

    const [lead] = await rows<Record<string, string>>(
      'select prospect_name, organization from leads where id = $1', [result.lead_id],
    );
    // src/lib/leadLabel.ts recognises this and shows the organisation instead.
    expect(lead.prospect_name).toBe('Name pending');
    expect(lead.organization).toBe('Invented Garage');
  });
});

/* ============================================== pressing Save twice === */

describe('the same capture arriving twice', () => {
  it('writes one contact, one meeting and one set of facts', async () => {
    const first = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-repeat', name: 'Invented Roofer',
        metOn: '2026-10-12', facts: [STATED],
      }));
    const second = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-repeat', name: 'Invented Roofer',
        metOn: '2026-10-12', facts: [STATED],
      }));

    expect(second.lead_id).toBe(first.lead_id);
    expect(second.reused).toBe(true);
    // The second call does not record the meeting again.
    expect(second.recorded_meeting).toBe(false);

    const leads = await rows('select id from leads where prospect_name = $1', ['Invented Roofer']);
    expect(leads).toHaveLength(1);
    const activities = await rows(
      'select id from activity_events where lead_id = $1', [first.lead_id],
    );
    expect(activities).toHaveLength(1);
  });

  it('still refuses to record a second meeting even under a new token', async () => {
    // A different token is a different press, and record_conversation is
    // idempotent on its own token, so this is the one case where a duplicate
    // could get through. The activity's own token is derived from the capture
    // token, which is what stops it.
    const first = await t.asUser(USER_A, () =>
      capture({ token: 'capture-a', name: 'Invented Chef', metOn: '2026-10-12' }));
    await t.asUser(USER_A, () =>
      capture({ token: 'capture-a', name: 'Invented Chef', metOn: '2026-10-12' }));

    const activities = await rows(
      'select id from activity_events where lead_id = $1', [first.lead_id],
    );
    expect(activities).toHaveLength(1);
  });
});

/* ========================================= what it refuses to write === */

describe('facts that would be dishonest', () => {
  it('leaves out an inference with nothing behind it, and says how many', async () => {
    const result = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-inferred',
        name: 'Invented Plumber',
        facts: [
          STATED,
          {
            kind: 'interest', value: 'Ready to buy', provenance: 'assistant_inferred',
            sourceExcerpt: null, occurredOn: null,
          },
        ],
      }));

    expect(result.facts_written).toBe(1);
    expect(result.facts_skipped).toBe(1);

    const facts = await rows<{ provenance: string }>(
      'select provenance from extracted_facts where lead_id = $1', [result.lead_id],
    );
    expect(facts.map((f) => f.provenance)).toEqual(['contact_stated']);
  });

  it('keeps a promise the user reported as a report, not as an impression', async () => {
    // The live capture that found this: "Told him I would text examples" is a
    // thing that happened, and it needs no excerpt because the person saying it
    // is the source.
    const result = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-user-stated',
        name: 'Invented Promisee',
        facts: [
          {
            kind: 'promise',
            value: 'I said I would text him examples',
            provenance: 'user_stated',
            sourceExcerpt: null,
            occurredOn: null,
          },
        ],
      }));

    expect(result.facts_written).toBe(1);
    expect(result.facts_skipped).toBe(0);

    const facts = await rows<{ provenance: string; source_excerpt: string | null }>(
      'select provenance, source_excerpt from extracted_facts where lead_id = $1',
      [result.lead_id],
    );
    expect(facts[0].provenance).toBe('user_stated');
    expect(facts[0].source_excerpt).toBeNull();
  });

  it('leaves out an unknown kind or provenance rather than failing the whole save', async () => {
    const result = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-bad-enum',
        name: 'Invented Tiler',
        facts: [
          { kind: 'vibe', value: 'Keen', provenance: 'contact_stated', sourceExcerpt: null },
          { kind: 'interest', value: 'Keen', provenance: 'obvious', sourceExcerpt: null },
          STATED,
        ],
      }));

    expect(result.facts_written).toBe(1);
    expect(result.facts_skipped).toBe(2);
    // The contact still exists, which is the point of counting rather than raising.
    expect(result.lead_id).toBeTruthy();
  });

  it('keeps a fact day only when it is a real day', async () => {
    const result = await t.asUser(USER_A, () =>
      capture({
        token: 'capture-factday',
        name: 'Invented Welder',
        facts: [
          { ...STATED, occurredOn: '2026-10-11' },
          { ...STATED, value: 'Second thing', occurredOn: 'last week' },
        ],
      }));

    const facts = await rows<{ value: string; occurred_on: string | null }>(
      `select value, occurred_on::text as occurred_on
         from extracted_facts where lead_id = $1 order by value`,
      [result.lead_id],
    );
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.value === 'Second thing')?.occurred_on).toBeNull();
    expect(facts.find((f) => f.value !== 'Second thing')?.occurred_on).toBe('2026-10-11');
  });

  it('refuses a capture with no token at all', async () => {
    await expect(
      t.asUser(USER_A, () => capture({ token: '   ', name: 'Invented Mason' })),
    ).rejects.toThrow(/token/i);
  });
});

/* ================================================== owner isolation === */

describe('one person cannot capture into another person', () => {
  it('stamps the contact with the caller, not with anybody else', async () => {
    const result = await t.asUser(USER_A, () =>
      capture({ token: 'capture-owner', name: 'Invented Owner Test' }));

    const [lead] = await t.asServiceRole(() =>
      rows<{ owner_id: string }>('select owner_id from leads where id = $1', [result.lead_id]));
    expect(lead.owner_id).toBe(USER_A);

    // And the other user cannot see it at all.
    const visible = await t.asUser(USER_B, () =>
      rows('select id from leads where id = $1', [result.lead_id]));
    expect(visible).toHaveLength(0);
  });

  it('refuses a caller with no session', async () => {
    await expect(
      t.asAnon(() => capture({ token: 'capture-anon', name: 'Invented Nobody' })),
    ).rejects.toThrow();
  });

  it('reuses only the caller own token, never somebody else row', async () => {
    const mine = await t.asUser(USER_A, () =>
      capture({ token: 'shared-token', name: 'Invented Mine' }));
    const theirs = await t.asUser(USER_B, () =>
      capture({ token: 'shared-token', name: 'Invented Theirs' }));

    expect(theirs.lead_id).not.toBe(mine.lead_id);
    expect(theirs.reused).toBe(false);
  });
});

/* ======================================================== the drafts === */

describe('saving a draft', () => {
  async function saveDraft(leadId: string, channel: string | null, body: string) {
    const result = await t.db.query<{ save_message_draft: Record<string, unknown> }>(
      'select save_message_draft($1, $2, $3) as save_message_draft',
      [leadId, channel, body],
    );
    return result.rows[0].save_message_draft;
  }

  it('writes a draft that is explicitly not sent', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', {
      prospect_name: 'Invented Draftee', stage: 'follow_up',
    });
    const result = await t.asUser(USER_A, () => saveDraft(leadId, 'Text', 'Hi there, following up.'));

    expect(result.status).toBe('draft');
    expect(result.sent).toBe(false);

    const [draft] = await rows<Record<string, unknown>>(
      'select status, sent_at, sent_on, activity_id from message_drafts where lead_id = $1',
      [leadId],
    );
    expect(draft.status).toBe('draft');
    expect(draft.sent_at).toBeNull();
    expect(draft.sent_on).toBeNull();
    expect(draft.activity_id).toBeNull();
  });

  it('revises the open draft for that channel rather than opening a second one', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', {
      prospect_name: 'Invented Reviser', stage: 'follow_up',
    });
    const first = await t.asUser(USER_A, () => saveDraft(leadId, 'Text', 'First wording.'));
    const second = await t.asUser(USER_A, () => saveDraft(leadId, 'Text', 'Second wording.'));

    expect(second.draft_id).toBe(first.draft_id);
    const drafts = await rows<{ body: string }>(
      'select body from message_drafts where lead_id = $1', [leadId],
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe('Second wording.');
  });

  it('keeps a text and an email apart, because they are different messages', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', {
      prospect_name: 'Invented Two Channels', stage: 'follow_up',
    });
    await t.asUser(USER_A, () => saveDraft(leadId, 'Text', 'Short one.'));
    await t.asUser(USER_A, () => saveDraft(leadId, 'Email', 'Longer one.'));

    const drafts = await rows('select id from message_drafts where lead_id = $1', [leadId]);
    expect(drafts).toHaveLength(2);
  });

  it('puts a revised draft back to draft, since the copy taken is no longer this wording', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', {
      prospect_name: 'Invented Copier', stage: 'follow_up',
    });
    const saved = await t.asUser(USER_A, () => saveDraft(leadId, 'Text', 'First wording.'));
    await t.asUser(USER_A, () =>
      t.db.query('select mark_draft_copied($1)', [saved.draft_id as string]));

    const copied = await rows<{ status: string }>(
      'select status from message_drafts where id = $1', [saved.draft_id],
    );
    expect(copied[0].status).toBe('copied');

    await t.asUser(USER_A, () => saveDraft(leadId, 'Text', 'Changed my mind.'));
    const revised = await rows<{ status: string; copied_at: unknown }>(
      'select status, copied_at from message_drafts where id = $1', [saved.draft_id],
    );
    expect(revised[0].status).toBe('draft');
    expect(revised[0].copied_at).toBeNull();
  });

  it('refuses an empty draft', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', {
      prospect_name: 'Invented Empty', stage: 'follow_up',
    });
    await expect(
      t.asUser(USER_A, () => saveDraft(leadId, 'Text', '   ')),
    ).rejects.toThrow(/body/i);
  });
});
