import { useMemo, useState } from 'react';
import { useData } from '../data/context';
import {
  AmplifiedTag, DataLegend, Empty, Field, Observed, PageHead, Tag, Unavailable,
} from '../components/primitives';
import { ContentForm } from './ContentForm';
import { ContentDetail } from './ContentDetail';
import { formatDay } from '../lib/dates';
import { latestSnapshot } from '../lib/metrics';
import type { ContentItem } from '../types/domain';
import { FORMAT_LABELS, PLATFORM_LABELS, STATUS_LABELS, WINDOW_LABELS } from '../types/domain';

type Mode =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; item: ContentItem }
  | { kind: 'detail'; item: ContentItem };

export function ContentLog() {
  const { data } = useData();
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [platform, setPlatform] = useState('');
  const [format, setFormat] = useState('');
  const [status, setStatus] = useState('');
  const [amplified, setAmplified] = useState('');
  const [query, setQuery] = useState('');

  const accountById = useMemo(
    () => new Map(data.accounts.map((a) => [a.id, a])),
    [data.accounts],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.contentItems
      .filter((c) => {
        const account = c.account_id ? accountById.get(c.account_id) : undefined;
        if (platform && account?.platform !== platform) return false;
        if (format && c.format !== format) return false;
        if (status && c.status !== status) return false;
        if (amplified === 'yes' && !c.is_externally_amplified) return false;
        if (amplified === 'no' && c.is_externally_amplified) return false;
        if (q) {
          const haystack = [c.title, c.pillar, c.utm_campaign, c.cta]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  }, [accountById, amplified, data.contentItems, format, platform, query, status]);

  const amplifiedCount = data.contentItems.filter((c) => c.is_externally_amplified).length;

  return (
    <>
      <PageHead
        kicker="What I published"
        title="Content Log"
        lede="Everything you have posted or plan to post. Each one keeps the tracking details that let you find out later whether it actually did anything. Posts are only ever compared against others on the same platform in the same format, because a story and an article are not the same job."
        action={
          <button className="btn btn-primary" onClick={() => setMode({ kind: 'create' })}>
            Add a post
          </button>
        }
      />

      <div className="filters">
        <Field label="Search" >
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Title, pillar, campaign"
          />
        </Field>
        <Field label="Platform">
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">All</option>
            {[...new Set(data.accounts.map((a) => a.platform))].map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABELS[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Format">
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="">All</option>
            {Object.entries(FORMAT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amplification">
          <select value={amplified} onChange={(e) => setAmplified(e.target.value)}>
            <option value="">All</option>
            <option value="no">Organic only</option>
            <option value="yes">Amplified only</option>
          </select>
        </Field>
      </div>

      {amplifiedCount > 0 ? (
        <p className="notice notice-amber">
          {amplifiedCount === 1 ? 'One post here was' : `${amplifiedCount} posts here were`}{' '}
          boosted by someone else. You can still see them, but they are kept out of the
          averages, because their reach says more about the account that shared them than
          about the post itself.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <Empty title="Nothing to show">
          {data.contentItems.length === 0
            ? 'Add your first post and the app can start connecting what you publish to what happens afterwards.'
            : 'Nothing matches those filters. Try widening them.'}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Posted</th>
                <th>Title</th>
                <th>Platform</th>
                <th>Format</th>
                <th>Theme</th>
                <th>Status</th>
                <th className="num">Views</th>
                <th className="num">Link clicks</th>
                <th className="num">Enquiries</th>
                <th>Last checked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const account = item.account_id ? accountById.get(item.account_id) : undefined;
                const snap = latestSnapshot(data.snapshots, item.id);
                return (
                  <tr key={item.id}>
                    <td data-label="Posted">{formatDay(item.published_at)}</td>
                    <td data-label="Title">
                      <button
                        className="row-button"
                        onClick={() => setMode({ kind: 'detail', item })}
                      >
                        {item.title}
                      </button>
                      {item.is_externally_amplified ? (
                        <>
                          {' '}
                          <AmplifiedTag amplifier={item.amplifier_name} />
                        </>
                      ) : null}
                    </td>
                    <td data-label="Platform">
                      {account ? PLATFORM_LABELS[account.platform] : 'No account'}
                    </td>
                    <td data-label="Format">{FORMAT_LABELS[item.format]}</td>
                    <td data-label="Theme">{item.pillar ?? 'Not set'}</td>
                    <td data-label="Status">
                      <Tag tone={item.status === 'measured' ? 'violet' : 'quiet'}>
                        {STATUS_LABELS[item.status]}
                      </Tag>
                    </td>
                    <td className="num" data-label="Views">
                      {snap?.metrics_unavailable ? (
                        <Unavailable reason={snap.unavailable_reason} short />
                      ) : (
                        <Observed value={snap?.views ?? null} />
                      )}
                    </td>
                    <td className="num" data-label="Link clicks">
                      <Observed value={snap?.link_clicks ?? null} />
                    </td>
                    <td className="num" data-label="Enquiries">
                      <Observed value={snap?.leads ?? null} />
                    </td>
                    <td data-label="Last checked">
                      {snap ? (
                        WINDOW_LABELS[snap.window_type]
                      ) : (
                        <span className="v-absent">Never measured</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <DataLegend />

      {mode.kind === 'create' ? (
        <ContentForm item={null} onClose={() => setMode({ kind: 'none' })} />
      ) : null}
      {mode.kind === 'edit' ? (
        <ContentForm item={mode.item} onClose={() => setMode({ kind: 'none' })} />
      ) : null}
      {mode.kind === 'detail' ? (
        <ContentDetail
          item={data.contentItems.find((c) => c.id === mode.item.id) ?? mode.item}
          onClose={() => setMode({ kind: 'none' })}
          onEdit={() => setMode({ kind: 'edit', item: mode.item })}
        />
      ) : null}
    </>
  );
}
