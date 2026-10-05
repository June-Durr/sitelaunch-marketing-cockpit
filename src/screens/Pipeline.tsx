import { useMemo, useState } from 'react';
import { useData } from '../data/context';
import { Empty, Observed, PageHead, Stat, Tag, Unknown } from '../components/primitives';
import { LeadForm } from './LeadForm';
import { readSettings, writeSettings } from '../data/settings';
import { formatCurrency } from '../lib/format';
import { formatDay, relativeDue, today } from '../lib/dates';
import { aggregate } from '../lib/metrics';
import type { Lead } from '../types/domain';
import { STAGE_LABELS, STAGE_ORDER } from '../types/domain';
import {
  FOLLOW_UP_STATUS_EXPLANATIONS, FOLLOW_UP_STATUS_LABELS, FOLLOW_UP_STATUS_TONES,
  LAST_TOUCH_BASIS_LABELS, NEEDS_ACTION_STATUSES, followUpStates,
} from '../config/followUp';

const OPEN_STAGES = STAGE_ORDER.filter((s) => s !== 'won' && s !== 'lost');

export function Pipeline() {
  const { data } = useData();
  // Persisted, so it survives a reload and travels in a backup.
  const [view, setView] = useState<'board' | 'table'>(() => readSettings().pipelineView);
  const [editing, setEditing] = useState<{ lead: Lead | null } | null>(null);

  const now = today();

  const byStage = useMemo(() => {
    const map = new Map<string, Lead[]>();
    for (const stage of STAGE_ORDER) map.set(stage, []);
    for (const lead of data.leads) map.get(lead.stage)?.push(lead);
    return map;
  }, [data.leads]);

  /**
   * Every lead's follow-up state, worked out once.
   *
   * All of it comes from src/config/followUp.ts, which is the only place in the
   * app that does this arithmetic. The last touch is derived from the activity
   * log rather than stored on the lead, so logging a contact changes this screen
   * without anybody having to remember to update a date.
   */
  const states = useMemo(
    () => followUpStates(data.leads, data.activityEvents, now),
    [data.leads, data.activityEvents, now],
  );
  const stateById = useMemo(
    () => new Map(states.map((state) => [state.lead.id, state])),
    [states],
  );

  const needingAction = states.filter((s) => NEEDS_ACTION_STATUSES.includes(s.status));
  const neverTouched = states.filter((s) => s.lastTouch.basis === 'none');

  const open = data.leads.filter((l) => l.stage !== 'won' && l.stage !== 'lost');
  const won = data.leads.filter((l) => l.stage === 'won');
  const proposals = data.leads.filter((l) => l.stage === 'proposal');
  const openValue = aggregate(open.map((l) => l.proposed_value));
  const wonValue = aggregate(won.map((l) => l.closed_value));

  return (
    <>
      <PageHead
        kicker="What followed"
        title="Pipeline"
        lede="Everyone who has got in touch, and how far along they are. This is the only screen where actual money shows up, which is why the app treats one enquiry here as worth more than thousands of views anywhere else."
        action={
          <button className="btn btn-primary" onClick={() => setEditing({ lead: null })}>
            New lead
          </button>
        }
      />

      <div className="stat-strip">
        <Stat value={open.length} label="Open leads" />
        <Stat value={proposals.length} label="At proposal" />
        <Stat
          value={openValue.sum === null ? 'None yet' : formatCurrency(openValue.sum)}
          label="Proposed value"
          note={`${openValue.n} of ${open.length} have a figure`}
        />
        <Stat
          value={wonValue.sum === null ? 'None yet' : formatCurrency(wonValue.sum)}
          label="Closed won"
          note={`${won.length} won`}
        />
        <Stat
          value={needingAction.length}
          label="Need chasing"
          note="follow-up today or already past"
        />
        <Stat
          value={neverTouched.length}
          label="No contact on record"
          note="nothing logged, and nothing claimed"
        />
      </div>

      <div className="btn-row" style={{ margin: '1.75rem 0 1rem' }}>
        <button
          className={view === 'board' ? 'btn btn-primary' : 'btn'}
          onClick={() => {
            setView('board');
            writeSettings({ ...readSettings(), pipelineView: 'board' });
          }}
        >
          Board
        </button>
        <button
          className={view === 'table' ? 'btn btn-primary' : 'btn'}
          onClick={() => {
            setView('table');
            writeSettings({ ...readSettings(), pipelineView: 'table' });
          }}
        >
          Table
        </button>
      </div>

      {data.leads.length === 0 ? (
        <Empty title="Nobody in the pipeline yet">
          Once someone gets in touch, add them here. Until then the app has no way to
          connect anything you post to actual work coming in.
        </Empty>
      ) : view === 'board' ? (
        <div className="board">
          {STAGE_ORDER.map((stage) => {
            const leads = byStage.get(stage) ?? [];
            return (
              <div className="board-col" key={stage}>
                <div className="board-col-head">
                  <span>{STAGE_LABELS[stage]}</span>
                  <span>{leads.length}</span>
                </div>
                {leads.length === 0 ? (
                  <p className="field-hint">Nobody here yet</p>
                ) : (
                  leads.map((lead) => {
                    const state = stateById.get(lead.id);
                    const overdue = state?.status === 'overdue';
                    return (
                      <button
                        className="board-card"
                        key={lead.id}
                        onClick={() => setEditing({ lead })}
                      >
                        <div className="board-card-name">{lead.prospect_name}</div>
                        <div className="board-card-meta">
                          {lead.project ?? lead.organization ?? 'No project named'}
                        </div>
                        <div className="board-card-meta">
                          {state && state.daysSince !== null
                            ? `${state.daysSince} ${state.daysSince === 1 ? 'day' : 'days'} since last touch`
                            : 'No contact on record'}
                        </div>
                        {state && state.status !== 'closed' ? (
                          <div className={overdue ? 'board-card-meta due-overdue' : 'board-card-meta'}>
                            {lead.next_action_date
                              ? `${FOLLOW_UP_STATUS_LABELS[state.status]} · ${relativeDue(lead.next_action_date, now)}`
                              : FOLLOW_UP_STATUS_LABELS[state.status]}
                          </div>
                        ) : null}
                        {lead.proposed_value !== null ? (
                          <div className="board-card-meta">
                            {formatCurrency(lead.proposed_value)}
                          </div>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Prospect</th>
                <th>Project</th>
                <th>Stage</th>
                <th>Source</th>
                <th>Last touch</th>
                <th className="num">Days since</th>
                <th>Next action</th>
                <th>Next follow-up</th>
                <th>Follow-up status</th>
                <th className="num">Proposed</th>
                <th className="num">Closed</th>
              </tr>
            </thead>
            <tbody>
              {/* Worst first, so the table reads as the order to work it in. */}
              {states.map(({ lead, lastTouch, daysSince, status }) => {
                const overdue = status === 'overdue';
                return (
                  <tr key={lead.id}>
                    <td data-label="Prospect">
                      <button className="row-button" onClick={() => setEditing({ lead })}>
                        {lead.prospect_name}
                      </button>
                      {lead.organization ? (
                        <div className="row-note">{lead.organization}</div>
                      ) : null}
                    </td>
                    <td data-label="Project">
                      {lead.project ?? lead.relationship ?? 'Not set'}
                    </td>
                    <td data-label="Stage">
                      <Tag tone={lead.stage === 'won' ? 'violet' : 'quiet'}>
                        {STAGE_LABELS[lead.stage]}
                      </Tag>
                    </td>
                    <td data-label="Source">{lead.source ?? <Unknown />}</td>
                    <td data-label="Last touch">
                      {lastTouch.effectiveOn === null ? (
                        <Unknown note="Nothing logged" />
                      ) : (
                        <>
                          {formatDay(lastTouch.effectiveOn)}
                          {/* Says which it is, so a spreadsheet's claim is never shown
                              as though somebody had logged it. */}
                          {lastTouch.basis === 'reported' ? (
                            <div
                              className="row-note"
                              title={LAST_TOUCH_BASIS_LABELS.reported}
                            >
                              Reported, no activity logged
                            </div>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="num" data-label="Days since">
                      {daysSince === null ? <Unknown /> : daysSince}
                    </td>
                    <td data-label="Next action">{lead.next_action ?? 'Nothing planned'}</td>
                    <td
                      data-label="Next follow-up"
                      className={overdue ? 'due-overdue' : undefined}
                    >
                      {lead.next_action_date === null
                        ? 'None set'
                        : formatDay(lead.next_action_date)}
                    </td>
                    <td data-label="Follow-up status">
                      <Tag
                        tone={FOLLOW_UP_STATUS_TONES[status]}
                        title={FOLLOW_UP_STATUS_EXPLANATIONS[status]}
                      >
                        {FOLLOW_UP_STATUS_LABELS[status]}
                      </Tag>
                    </td>
                    <td className="num" data-label="Proposed">
                      <Observed value={lead.proposed_value} format="currency" />
                    </td>
                    <td className="num" data-label="Closed">
                      <Observed value={lead.closed_value} format="currency" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="notice">
        There are {OPEN_STAGES.length} stages before someone is won or lost. If you do not
        know which post brought someone in, leave it blank. The app will say it does not
        know, rather than crediting whatever you happened to publish that week.
      </p>

      <p className="notice">
        Last touch comes from the activity log rather than a date somebody keeps up by
        hand, so it moves when you record that something happened. A row marked reported
        arrived from the imported mirror with a date but no record of what took place,
        and it says so rather than pretending otherwise. Follow-up dates move themselves
        when you log a contact, and the rules behind them are in one place, so this
        screen, Today and the Google Sheet mirror can never disagree.
      </p>

      {editing ? <LeadForm lead={editing.lead} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
