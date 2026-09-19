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
                    const overdue =
                      lead.next_action_date !== null &&
                      lead.next_action_date <= now &&
                      !['won', 'lost'].includes(lead.stage);
                    return (
                      <button
                        className="board-card"
                        key={lead.id}
                        onClick={() => setEditing({ lead })}
                      >
                        <div className="board-card-name">{lead.prospect_name}</div>
                        <div className="board-card-meta">
                          {lead.project ?? 'No project named'}
                        </div>
                        {lead.next_action_date ? (
                          <div className={overdue ? 'board-card-meta due-overdue' : 'board-card-meta'}>
                            {relativeDue(lead.next_action_date, now)}
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
                <th>Related content</th>
                <th>Next action</th>
                <th>Follow-up</th>
                <th className="num">Proposed</th>
                <th className="num">Closed</th>
              </tr>
            </thead>
            <tbody>
              {data.leads.map((lead) => {
                const content = data.contentItems.find((c) => c.id === lead.content_item_id);
                const overdue =
                  lead.next_action_date !== null &&
                  lead.next_action_date <= now &&
                  !['won', 'lost'].includes(lead.stage);
                return (
                  <tr key={lead.id}>
                    <td data-label="Prospect">
                      <button className="row-button" onClick={() => setEditing({ lead })}>
                        {lead.prospect_name}
                      </button>
                    </td>
                    <td data-label="Project">{lead.project ?? 'Not set'}</td>
                    <td data-label="Stage">
                      <Tag tone={lead.stage === 'won' ? 'violet' : 'quiet'}>
                        {STAGE_LABELS[lead.stage]}
                      </Tag>
                    </td>
                    <td data-label="Source">{lead.source ?? <Unknown />}</td>
                    <td data-label="Related content">
                      {content ? content.title : <Unknown note="No content linked" />}
                    </td>
                    <td data-label="Next action">{lead.next_action ?? 'Nothing planned'}</td>
                    <td data-label="Follow-up" className={overdue ? 'due-overdue' : undefined}>
                      {formatDay(lead.next_action_date)}
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

      {editing ? <LeadForm lead={editing.lead} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
