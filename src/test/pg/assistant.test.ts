/**
 * The records the assistant is allowed to write, and what it cannot collapse.
 *
 * No model is involved in any of this. These are the rules that have to hold
 * before an extraction is worth anything: that a guess cannot become a fact,
 * that writing a message is not sending one, and that one instruction produces
 * the linked updates without producing them twice.
 *
 * Every person, draft and date below is invented.
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
    delete from ai_usage;
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

async function seedLead(owner: string, over: Record<string, unknown> = {}) {
  return seedRow(t, owner, 'leads', {
    prospect_name: 'Invented Person',
    organization: 'Invented Trades',
    stage: 'follow_up',
    preferred_channel: 'Text',
    next_action: 'Send the brand board',
    next_action_date: '2026-10-20',
    ...over,
  });
}

/* ================================ a guess cannot become a fact === */

describe('a fact has to say who is claiming it', () => {
  it('refuses a fact with no provenance at all', async () => {
    const leadId = await seedLead(USER_A);
    await expect(
      rows(
        `insert into extracted_facts (owner_id, lead_id, kind, value)
         values ($1, $2, 'interest', 'wants a booking form')`,
        [USER_A, leadId],
      ),
    ).rejects.toThrow(/provenance/i);
  });

  it('keeps the three kinds of claim apart', async () => {
    const leadId = await seedLead(USER_A);
    for (const [provenance, value] of [
      ['contact_stated', 'I need online booking'],
      ['user_impression', 'friendly but not interested'],
      ['assistant_inferred', 'probably price sensitive'],
    ]) {
      await rows(
        `insert into extracted_facts
           (owner_id, lead_id, kind, value, provenance, source_excerpt)
         values ($1, $2, 'other', $3, $4, 'from the pasted conversation')`,
        [USER_A, leadId, value, provenance],
      );
    }
    const stored = await rows<{ provenance: string }>(
      'select provenance from extracted_facts order by provenance',
    );
    expect(stored.map((r) => r.provenance)).toEqual([
      'assistant_inferred', 'contact_stated', 'user_impression',
    ]);
  });

  it('makes an inferred fact show its working', async () => {
    // Something a model decided, with nothing to check it against, is not a
    // record worth keeping.
    const leadId = await seedLead(USER_A);
    await expect(
      rows(
        `insert into extracted_facts (owner_id, lead_id, kind, value, provenance)
         values ($1, $2, 'concern', 'worried about cost', 'assistant_inferred')`,
        [USER_A, leadId],
      ),
    ).rejects.toThrow(/inferred_facts_show_their_source/);
  });

  it('lets a stated fact stand without an excerpt', async () => {
    // The person said it. There is nothing to quote back at them.
    const leadId = await seedLead(USER_A);
    await rows(
      `insert into extracted_facts (owner_id, lead_id, kind, value, provenance)
       values ($1, $2, 'reply', 'said they would look at it', 'contact_stated')`,
      [USER_A, leadId],
    );
    expect(await rows('select id from extracted_facts')).toHaveLength(1);
  });

  it('does not rewrite provenance when somebody accepts the fact', async () => {
    /**
     * Accepting an inferred fact says "I agree with this guess". It does not
     * turn it into something the contact said, and three weeks later the
     * difference is the whole point.
     */
    const leadId = await seedLead(USER_A);
    await rows(
      `insert into extracted_facts
         (owner_id, lead_id, kind, value, provenance, source_excerpt)
       values ($1, $2, 'concern', 'price sensitive', 'assistant_inferred', 'said it was a lot')`,
      [USER_A, leadId],
    );
    await rows("update extracted_facts set accepted_at = now(), applied_to = 'leads.notes'");

    const [fact] = await rows<Record<string, string | null>>(
      'select provenance, accepted_at, applied_to from extracted_facts',
    );
    expect(fact.provenance).toBe('assistant_inferred');
    expect(fact.accepted_at).not.toBeNull();
    expect(fact.applied_to).toBe('leads.notes');
  });

  it('will not hold a fact that is both accepted and rejected', async () => {
    const leadId = await seedLead(USER_A);
    await rows(
      `insert into extracted_facts (owner_id, lead_id, kind, value, provenance)
       values ($1, $2, 'other', 'something', 'contact_stated')`,
      [USER_A, leadId],
    );
    await expect(
      rows('update extracted_facts set accepted_at = now(), rejected_at = now()'),
    ).rejects.toThrow(/fact_is_not_both_accepted_and_rejected/);
  });

  it('leaves the day null rather than guessing one', async () => {
    // "They replied at some point" is a different fact from "they replied on
    // the eighth", and inventing the second is what this column prevents.
    const leadId = await seedLead(USER_A);
    await rows(
      `insert into extracted_facts (owner_id, lead_id, kind, value, provenance)
       values ($1, $2, 'reply', 'replied at some point', 'contact_stated')`,
      [USER_A, leadId],
    );
    const [fact] = await rows<Record<string, string | null>>(
      'select occurred_on from extracted_facts',
    );
    expect(fact.occurred_on).toBeNull();
  });

  it('keeps one person facts away from another', async () => {
    const mine = await seedLead(USER_A);
    await rows(
      `insert into extracted_facts (owner_id, lead_id, kind, value, provenance)
       values ($1, $2, 'other', 'mine', 'contact_stated')`,
      [USER_A, mine],
    );
    const seen = await t.asUser(USER_B, () => rows('select id from extracted_facts'));
    expect(seen).toEqual([]);
  });
});

/* ================================ writing is not sending === */

describe('a draft is not a sent message', () => {
  async function seedDraft(owner: string, leadId: string, over: Record<string, unknown> = {}) {
    const [row] = await rows<{ id: string }>(
      `insert into message_drafts (owner_id, lead_id, channel, body)
       values ($1, $2, $3, $4) returning id`,
      [owner, leadId, over.channel ?? 'Text', over.body ?? 'Hello, following up.'],
    );
    return row.id;
  }

  it('records a copy without recording a send', async () => {
    const leadId = await seedLead(USER_A);
    const draftId = await seedDraft(USER_A, leadId);

    const [result] = await t.asUser(USER_A, () =>
      rows<{ mark_draft_copied: Record<string, unknown> }>(
        'select mark_draft_copied($1)', [draftId],
      ),
    );
    expect(result.mark_draft_copied.status).toBe('copied');
    // Said out loud in the return value, because this is the exact place the
    // mistake would be made.
    expect(result.mark_draft_copied.sent).toBe(false);

    const [draft] = await rows<Record<string, string | null>>(
      'select status, copied_at, sent_at from message_drafts where id = $1', [draftId],
    );
    expect(draft.status).toBe('copied');
    expect(draft.copied_at).not.toBeNull();
    expect(draft.sent_at).toBeNull();

    // And nothing was written to the activity log.
    expect(await rows('select id from activity_events')).toHaveLength(0);
  });

  it('refuses to carry a sent timestamp on an unsent draft', async () => {
    const leadId = await seedLead(USER_A);
    const draftId = await seedDraft(USER_A, leadId);
    await expect(
      rows('update message_drafts set sent_at = now() where id = $1', [draftId]),
    ).rejects.toThrow(/only_sent_drafts_are_sent/);
  });

  it('keeps one open draft per channel, so I sent it has one answer', async () => {
    /**
     * With two open drafts for the same person on the same channel there is no
     * way to know which was sent, and guessing attaches the wrong wording to a
     * real contact.
     */
    const leadId = await seedLead(USER_A);
    await seedDraft(USER_A, leadId, { channel: 'Text' });
    await expect(seedDraft(USER_A, leadId, { channel: 'Text' }))
      .rejects.toThrow(/message_drafts_one_open_per_channel/);

    // A different channel is a different message, and is allowed.
    await expect(seedDraft(USER_A, leadId, { channel: 'Email' })).resolves.toBeTruthy();
  });

  it('allows a new draft once the previous one is sent or discarded', async () => {
    const leadId = await seedLead(USER_A);
    const first = await seedDraft(USER_A, leadId, { channel: 'Text' });
    await rows("update message_drafts set status = 'discarded' where id = $1", [first]);
    await expect(seedDraft(USER_A, leadId, { channel: 'Text' })).resolves.toBeTruthy();
  });

  it('turns a confirmed send into a real contact, with the final wording', async () => {
    const leadId = await seedLead(USER_A);
    const draftId = await seedDraft(USER_A, leadId, { channel: 'Text' });

    const [result] = await t.asUser(USER_A, () =>
      rows<{ mark_draft_sent: Record<string, unknown> }>(
        `select mark_draft_sent($1, 'tok-send', '2026-10-12'::date,
                                'Hola, lo edite antes de enviarlo.')`,
        [draftId],
      ),
    );
    expect(result.mark_draft_sent.status).toBe('sent');

    const [draft] = await rows<Record<string, string | null>>(
      'select status, sent_on::text as sent_on, body, activity_id'
      + ' from message_drafts where id = $1',
      [draftId],
    );
    expect(draft.status).toBe('sent');
    // The day it was actually sent, not the day it was recorded.
    expect(draft.sent_on).toBe('2026-10-12');
    // The wording that really went, which differed from the draft.
    expect(draft.body).toContain('lo edite antes de enviarlo');
    expect(draft.activity_id).not.toBeNull();

    const [activity] = await rows<Record<string, string>>(
      `select activity_type, channel, approved_message, evidence_source,
              occurred_at::date::text as on_date
         from activity_events`,
    );
    expect(activity.activity_type).toBe('follow_up_sent');
    expect(activity.channel).toBe('Text');
    expect(activity.approved_message).toContain('lo edite antes de enviarlo');
    expect(activity.evidence_source).toBe('User confirmed send');
    expect(activity.on_date).toBe('2026-10-12');
  });

  it('says not_found rather than inventing a send for a draft already sent', async () => {
    const leadId = await seedLead(USER_A);
    const draftId = await seedDraft(USER_A, leadId);
    await t.asUser(USER_A, () =>
      rows("select mark_draft_sent($1, 'tok-1', '2026-10-12'::date, null)", [draftId]));

    const [again] = await t.asUser(USER_A, () =>
      rows<{ mark_draft_sent: Record<string, unknown> }>(
        "select mark_draft_sent($1, 'tok-2', '2026-10-12'::date, null)", [draftId],
      ),
    );
    expect(again.mark_draft_sent.status).toBe('not_found');
    expect(await rows('select id from activity_events')).toHaveLength(1);
  });
});

/* ================= one instruction, all the linked updates === */

describe('recording a conversation moves everything that follows from it', () => {
  it('writes the activity, moves the lead and queues both syncs', async () => {
    const leadId = await seedLead(USER_A, { next_action: null, next_action_date: null });

    await t.asUser(USER_A, () =>
      rows(
        `select record_conversation($1, 'conv-1', '2026-10-11'::date,
           'Met at the chamber breakfast. Wants online booking.',
           'WhatsApp', 'conversation'::activity_type, null, null,
           '2026-10-18'::date, 'Send the brand board', 'User report')`,
        [leadId],
      ),
    );

    const [activity] = await rows<Record<string, string>>(
      `select activity_type, channel, evidence_source, details,
              occurred_at::date::text as on_date, calendar_history_wanted::text as history
         from activity_events`,
    );
    expect(activity.activity_type).toBe('conversation');
    expect(activity.channel).toBe('WhatsApp');
    expect(activity.on_date).toBe('2026-10-11');
    expect(activity.details).toContain('chamber breakfast');
    expect(activity.history).toBe('true');

    const [lead] = await rows<Record<string, string>>(
      `select preferred_channel, next_action, next_action_date::text as next_date,
              reported_last_touch_at::text as last_touch
         from leads where id = $1`,
      [leadId],
    );
    expect(lead.preferred_channel).toBe('WhatsApp');
    expect(lead.next_action).toBe('Send the brand board');
    expect(lead.next_date).toBe('2026-10-18');
    expect(lead.last_touch).toBe('2026-10-11');

    const jobs = await rows<{ kind: string }>('select kind from sync_jobs order by kind');
    expect(jobs.map((j) => j.kind)).toEqual(['calendar', 'lead_mirror']);
  });

  it('writes once however many times it is asked', async () => {
    const leadId = await seedLead(USER_A);
    for (let i = 0; i < 3; i += 1) {
      await t.asUser(USER_A, () =>
        rows(
          `select record_conversation($1, 'same-token', '2026-10-11'::date, 'Spoke',
             null, 'conversation'::activity_type, null, null, null, null, 'User report')`,
          [leadId],
        ),
      );
    }
    expect(await rows('select id from activity_events')).toHaveLength(1);
  });

  it('never blanks a channel or next action somebody set by hand', async () => {
    /**
     * The assistant passing null means "I have nothing to say about this", not
     * "clear it". Overwriting a confirmed channel with a null is how a
     * carefully recorded preference disappears.
     */
    const leadId = await seedLead(USER_A, {
      preferred_channel: 'Phone + text (Spanish)',
      next_action: 'Wait for her reply',
    });

    await t.asUser(USER_A, () =>
      rows(
        `select record_conversation($1, 'conv-2', '2026-10-11'::date, 'Spoke briefly',
           null, 'conversation'::activity_type, null, null, null, null, 'User report')`,
        [leadId],
      ),
    );

    const [lead] = await rows<Record<string, string>>(
      'select preferred_channel, next_action from leads where id = $1', [leadId],
    );
    expect(lead.preferred_channel).toBe('Phone + text (Spanish)');
    expect(lead.next_action).toBe('Wait for her reply');
  });

  it('uses the day it was told, not the day it was recorded', async () => {
    const leadId = await seedLead(USER_A);
    await t.asUser(USER_A, () =>
      rows(
        `select record_conversation($1, 'conv-3', '2026-09-08'::date, 'Followed up',
           null, 'follow_up_sent'::activity_type, null, null, null, null, 'User screenshot')`,
        [leadId],
      ),
    );
    const [activity] = await rows<Record<string, string>>(
      'select occurred_at::date::text as on_date, evidence_source from activity_events',
    );
    expect(activity.on_date).toBe('2026-09-08');
    expect(activity.evidence_source).toBe('User screenshot');
  });

  it('refuses a lead that is not this person', async () => {
    const theirs = await seedLead(USER_B);
    await expect(
      t.asUser(USER_A, () =>
        rows(
          `select record_conversation($1, 'trespass', '2026-10-11'::date, 'Spoke',
             null, 'conversation'::activity_type, null, null, null, null, 'User report')`,
          [theirs],
        ),
      ),
    ).rejects.toThrow();
    expect(await rows('select id from activity_events')).toHaveLength(0);
  });
});

/* =============================== what it cost === */

describe('what the assistant costs is recorded from the start', () => {
  it('records tokens and cost per operation', async () => {
    await rows(
      `insert into ai_usage (owner_id, operation, model, input_tokens, output_tokens, cost_micros)
       values ($1, 'extract_facts', 'claude-opus-5', 1200, 340, 8250)`,
      [USER_A],
    );
    const [usage] = await rows<Record<string, string>>(
      'select operation, model, input_tokens::text, cost_micros::text from ai_usage',
    );
    expect(usage.operation).toBe('extract_facts');
    // Integer millionths, so thousands of rows cannot drift the way floats do.
    expect(usage.cost_micros).toBe('8250');
  });

  it('records a failed call, because a failed call is still billed', async () => {
    await rows(
      `insert into ai_usage (owner_id, operation, model, input_tokens, cost_micros, error)
       values ($1, 'extract_facts', 'claude-opus-5', 900, 4100, 'upstream timeout')`,
      [USER_A],
    );
    const [usage] = await rows<Record<string, string | null>>(
      'select error, cost_micros::text from ai_usage',
    );
    expect(usage.error).toBe('upstream timeout');
    expect(usage.cost_micros).toBe('4100');
  });

  it('cannot be written from a browser, only read', async () => {
    // A browser that could write usage rows could understate what it spent.
    await expect(
      t.asUser(USER_A, () =>
        rows(
          `insert into ai_usage (owner_id, operation, model) values ($1, 'x', 'y')`,
          [USER_A],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('shows one person their own spend and no other', async () => {
    await rows(
      `insert into ai_usage (owner_id, operation, model, cost_micros)
       values ($1, 'a', 'm', 10), ($2, 'b', 'm', 20)`,
      [USER_A, USER_B],
    );
    const seen = await t.asUser(USER_A, () =>
      rows<{ cost_micros: string }>('select cost_micros::text from ai_usage'),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].cost_micros).toBe('10');
  });
});
