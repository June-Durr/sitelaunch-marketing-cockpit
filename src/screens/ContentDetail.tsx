import { useState } from 'react';
import { useData } from '../data/context';
import { Drawer } from '../components/Drawer';
import {
  AmplifiedTag, Empty, Observed, Section, Tag, Unknown,
} from '../components/primitives';
import { SnapshotForm } from './SnapshotForm';
import { formatDateTime, formatDay } from '../lib/dates';
import { snapshotsFor } from '../lib/metrics';
import type { ContentItem, PerformanceSnapshot, SnapshotWindow } from '../types/domain';
import {
  FORMAT_LABELS, METRIC_GROUPS, METRIC_GUIDE, METRIC_KEYS, METRIC_LABELS,
  PLATFORM_LABELS, STAGE_LABELS, STATUS_LABELS, WINDOW_LABELS,
} from '../types/domain';

export function ContentDetail({
  item,
  onClose,
  onEdit,
}: {
  item: ContentItem;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { data, remove } = useData();
  const [snapshotTarget, setSnapshotTarget] = useState<
    { snapshot: PerformanceSnapshot | null; window?: SnapshotWindow } | null
  >(null);

  const account = data.accounts.find((a) => a.id === item.account_id);
  const snapshots = snapshotsFor(data.snapshots, item.id);
  const traffic = data.traffic.filter((t) => t.content_item_id === item.id);
  const leads = data.leads.filter((l) => l.content_item_id === item.id);
  const crossPosts = item.cross_post_group_id
    ? data.contentItems.filter(
        (c) => c.cross_post_group_id === item.cross_post_group_id && c.id !== item.id,
      )
    : [];

  return (
    <>
      <Drawer title={item.title} onClose={onClose}>
        <div className="tag-row" style={{ marginBottom: '1.25rem' }}>
          <Tag>{account ? PLATFORM_LABELS[account.platform] : 'No account'}</Tag>
          <Tag>{FORMAT_LABELS[item.format]}</Tag>
          <Tag tone={item.status === 'measured' ? 'violet' : 'quiet'}>
            {STATUS_LABELS[item.status]}
          </Tag>
          {item.is_externally_amplified ? (
            <AmplifiedTag amplifier={item.amplifier_name} />
          ) : null}
          {item.is_seed ? <Tag tone="quiet">Seed record</Tag> : null}
        </div>

        {item.is_externally_amplified ? (
          <p className="notice notice-amber">
            Boosted by {item.amplifier_name ?? 'another account'}.{' '}
            {item.amplification_note ??
              'Its reach came from someone elses audience, so it is kept out of the averages.'}
          </p>
        ) : null}

        <dl className="kv">
          <dt>Account</dt>
          <dd>{account ? `${account.handle} · ${account.display_name ?? ''}` : <Unknown />}</dd>
          <dt>Published</dt>
          <dd>
            {item.published_at ? (
              formatDateTime(item.published_at)
            ) : (
              <Unknown label="Not published yet" note="This is still a draft or scheduled." />
            )}
          </dd>
          <dt>Theme</dt>
          <dd>{item.pillar ?? <Unknown />}</dd>
          <dt>Who it was for</dt>
          <dd>{item.target_audience ?? <Unknown />}</dd>
          <dt>Opening line</dt>
          <dd>{item.hook ?? <Unknown />}</dd>
          <dt>What you asked people to do</dt>
          <dd>{item.cta ?? <Unknown />}</dd>
          <dt>Link you shared</dt>
          <dd>
            {item.destination_url ? (
              <a href={item.destination_url} target="_blank" rel="noreferrer">
                {item.destination_url}
              </a>
            ) : (
              <Unknown />
            )}
          </dd>
          <dt>Tracking tags</dt>
          <dd>
            {item.utm_source || item.utm_medium || item.utm_campaign ? (
              `${item.utm_source ?? 'not set'} / ${item.utm_medium ?? 'not set'} / ${item.utm_campaign ?? 'not set'}`
            ) : (
              <Unknown
                label="No tracking on this link"
                note="Without tracking tags you cannot tell later which post sent someone to your site."
              />
            )}
          </dd>
          {item.screenshot_url ? (
            <>
              <dt>Screenshot</dt>
              <dd>
                <a href={item.screenshot_url} target="_blank" rel="noreferrer">
                  Open screenshot
                </a>
              </dd>
            </>
          ) : null}
          {item.notes ? (
            <>
              <dt>Notes</dt>
              <dd>{item.notes}</dd>
            </>
          ) : null}
          {crossPosts.length ? (
            <>
              <dt>Cross-posted</dt>
              <dd>
                {crossPosts.map((c) => c.title).join('; ')}
                <br />
                <span className="field-hint">
                  Kept as separate records on purpose. Each platform counts differently,
                  so adding their numbers together would invent a figure neither one
                  reported.
                </span>
              </dd>
            </>
          ) : null}
        </dl>

        <Section
          title="The numbers, and when you took them"
          action={
            <button
              className="btn btn-quiet"
              onClick={() => setSnapshotTarget({ snapshot: null })}
            >
              + Write down numbers
            </button>
          }
        >
          {snapshots.length === 0 ? (
            <Empty title="No numbers recorded yet">
              Nothing here can be compared with anything else until you write down at
              least one set of numbers.
            </Empty>
          ) : (
            snapshots.map((s) => {
              const present = METRIC_KEYS.filter((k) => s[k] !== null);
              return (
                <div key={s.id} style={{ marginBottom: '1.75rem' }}>
                  <div className="section-head" style={{ borderBottomColor: 'var(--rule)' }}>
                    <span className="section-title">
                      {WINDOW_LABELS[s.window_type]} · {formatDateTime(s.captured_at)}
                    </span>
                    <span className="btn-row">
                      <Tag tone="quiet">
                        {s.ingest_source === 'manual' ? 'Typed in by hand' : s.ingest_source}
                      </Tag>
                      <button
                        className="btn btn-quiet"
                        onClick={() => setSnapshotTarget({ snapshot: s })}
                      >
                        Edit
                      </button>
                    </span>
                  </div>

                  {s.metrics_unavailable ? (
                    <p className="notice notice-amber">
                      {s.unavailable_reason ??
                        'The platform does not give you any numbers for this one.'}{' '}
                      There is nothing to go and look at, so the app will stop asking.
                    </p>
                  ) : (
                    <>
                      <p className="field-hint" style={{ marginBottom: '1rem' }}>
                        {present.length === 0
                          ? 'Nothing has been filled in for this reading yet.'
                          : `${present.length} of ${METRIC_KEYS.length} filled in. The rest say not checked, which keeps them out of every average instead of counting them as zero.`}
                      </p>
                      {METRIC_GROUPS.map((group) => (
                        <div key={group.title} style={{ marginBottom: '1.25rem' }}>
                          <div className="metric-group-head">{group.title}</div>
                          <div className="metric-grid">
                            {group.keys.map((key) => (
                              <div className="metric-cell" key={key}>
                                <div className="metric-cell-value">
                                  <Observed value={s[key]} />
                                </div>
                                <div className="metric-cell-label">
                                  {METRIC_LABELS[key]}
                                </div>
                                <div className="metric-cell-help">
                                  {METRIC_GUIDE[key].what}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                  {s.notes ? <p className="field-hint">{s.notes}</p> : null}
                </div>
              );
            })
          )}
        </Section>

        <Section title="Website visits linked to this">
          {traffic.length === 0 ? (
            <Empty title="No website visits linked to this">
              You link website visits to a post by hand, over on Website Outcomes. The app
              will not guess the connection for you, because a matching tag is a hint and
              not proof.
            </Empty>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Range</th>
                  <th>Source / medium</th>
                  <th className="num">Sessions</th>
                  <th className="num">Leads</th>
                </tr>
              </thead>
              <tbody>
                {traffic.map((t) => (
                  <tr key={t.id}>
                    <td data-label="Range">
                      {formatDay(t.range_start)} – {formatDay(t.range_end)}
                    </td>
                    <td data-label="Source / medium">
                      {t.source ?? 'not set'} / {t.medium ?? 'not set'}
                    </td>
                    <td className="num" data-label="Sessions">
                      <Observed value={t.sessions} />
                    </td>
                    <td className="num" data-label="Leads">
                      <Observed value={t.generate_lead_events} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Enquiries linked to this">
          {leads.length === 0 ? (
            <Empty title="No enquiries linked to this">
              Nobody has connected an enquiry to this post. That is not the same as saying
              it produced none. It means we do not know either way.
            </Empty>
          ) : (
            <ul className="queue">
              {leads.map((l) => (
                <li key={l.id}>
                  <div className="queue-main">
                    <div className="queue-title">{l.prospect_name}</div>
                    <div className="queue-meta">
                      {l.project ?? 'No project named'} ·{' '}
                      {l.attribution_note ?? 'Linked by hand'}
                    </div>
                  </div>
                  <div className="queue-side">
                    <Tag tone="violet">{STAGE_LABELS[l.stage]}</Tag>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="form-actions">
          <button
            className="btn btn-quiet btn-danger"
            onClick={async () => {
              if (confirm(`Delete "${item.title}" and its snapshots?`)) {
                await remove('content_items', item.id);
                onClose();
              }
            }}
          >
            Delete
          </button>
          <button className="btn" onClick={onEdit}>
            Edit content
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setSnapshotTarget({ snapshot: null })}
          >
            Write down numbers
          </button>
        </div>
      </Drawer>

      {snapshotTarget ? (
        <SnapshotForm
          item={item}
          snapshot={snapshotTarget.snapshot}
          defaultWindow={snapshotTarget.window}
          onClose={() => setSnapshotTarget(null)}
        />
      ) : null}
    </>
  );
}
