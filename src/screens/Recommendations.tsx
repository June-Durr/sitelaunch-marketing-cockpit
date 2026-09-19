import { useMemo, useState } from 'react';
import { useData } from '../data/context';
import { Empty, Notice, PageHead, Tag } from '../components/primitives';
import {
  MIN_PATTERN, MIN_RELIABLE, generateRecommendations,
  type GeneratedRecommendation,
} from '../engine/recommendations';
import { buildCohorts } from '../engine/cohorts';
import { formatDateTime } from '../lib/dates';
import { CONFIDENCE_LABELS, FORMAT_LABELS, PLATFORM_LABELS } from '../types/domain';
import type { ConfidenceLabel } from '../types/domain';

const TONE: Record<ConfidenceLabel, 'quiet' | 'violet' | 'default'> = {
  early_signal: 'quiet',
  emerging_pattern: 'default',
  reliable_pattern: 'violet',
};

const RULE_NAMES: Record<string, string> = {
  R1_downstream_winner: 'R1 · Downstream outcome above the comparison average',
  R2_traffic_producer: 'R2 · Recorded website traffic',
  R3_engaged_but_inert: 'R3 · Engagement without measurable traffic',
  R4_views_without_action: 'R4 · Views without downstream action',
  R5_measurement_gap: 'R5 · Overdue measurement',
  R6_insufficient_evidence: 'R6 · Not enough comparable items',
  R7_amplification_notice: 'R7 · Externally amplified item excluded',
};

export function Recommendations() {
  const { data } = useData();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const generated = useMemo(() => generateRecommendations(data), [data]);
  const cohorts = useMemo(() => buildCohorts(data), [data]);

  const key = (r: GeneratedRecommendation) => `${r.rule_id}:${r.headline}`;
  const visible = generated.filter((r) => !dismissed.has(key(r)));

  const patternCohorts = cohorts.filter((c) => c.members.length >= MIN_PATTERN);

  return (
    <>
      <PageHead
        kicker="What to do next"
        title="Recommendations"
        lede="Suggestions worked out by a fixed set of rules you can read for yourself. Nothing here is predicted or guessed. Every statement opens up to show the numbers it came from, and when the numbers are too thin to say anything, the app tells you that instead."
      />

      <Notice tone="violet">
        Posts are only ever compared against others on the same platform, in the same
        format, measured at the same point in time. Anything a bigger account boosted is
        left out. The app needs {MIN_PATTERN} similar posts before it will draw any
        conclusion at all, and {MIN_RELIABLE} across two or more themes before it calls
        something reliable. Below that it will tell you it does not know yet.
      </Notice>

      <div className="stat-strip" style={{ marginTop: '1.5rem' }}>
        <div className="stat">
          <span className="stat-value">{cohorts.length}</span>
          <div className="stat-label">Groups of similar posts</div>
          <div className="stat-note">same platform, format and timing</div>
        </div>
        <div className="stat">
          <span className="stat-value">{patternCohorts.length}</span>
          <div className="stat-label">Big enough to learn from</div>
          <div className="stat-note">{MIN_PATTERN} or more measured posts</div>
        </div>
        <div className="stat">
          <span className="stat-value">{visible.length}</span>
          <div className="stat-label">Things the app can tell you</div>
        </div>
      </div>

      <div style={{ marginTop: '2.5rem' }}>
        {visible.length === 0 ? (
          <Empty title="Nothing worth saying yet">
            None of the rules found enough to go on. That is a comment on how much has been
            measured so far, not on how good your posts are.
          </Empty>
        ) : (
          visible.map((rec) => (
            <article className="rec" key={key(rec)}>
              <div className="rec-top">
                <h2 className="rec-headline">{rec.headline}</h2>
                <div className="tag-row">
                  <Tag tone={TONE[rec.confidence]} title="Confidence is set by sample size">
                    {CONFIDENCE_LABELS[rec.confidence]}
                  </Tag>
                  <button
                    className="btn btn-quiet"
                    onClick={() => setDismissed((s) => new Set(s).add(key(rec)))}
                  >
                    Dismiss
                  </button>
                </div>
              </div>

              <p className="rec-detail">{rec.detail}</p>
              {rec.suggested_action ? (
                <p className="rec-action">{rec.suggested_action}</p>
              ) : null}

              <details className="rec-evidence">
                <summary>
                  Show me the numbers behind this ({RULE_NAMES[rec.rule_id] ?? rec.rule_id},
                  based on {rec.sample_size})
                </summary>
                <ul className="evidence-list">
                  {rec.evidence.lines.map((line, i) => (
                    <li key={`${line.label}-${i}`}>
                      <span className="evidence-label">{line.label}</span>
                      <span className={line.derived ? 'v-derived' : 'v-observed'}>
                        {line.value}
                      </span>
                    </li>
                  ))}
                </ul>

                {rec.evidence.excluded.length > 0 ? (
                  <>
                    <p
                      className="field-hint"
                      style={{ marginTop: '1rem', marginBottom: '0.35rem' }}
                    >
                      Left out of this comparison:
                    </p>
                    <ul className="evidence-list">
                      {rec.evidence.excluded.map((ex) => (
                        <li key={ex.id} style={{ display: 'block' }}>
                          <strong style={{ fontWeight: 500 }}>{ex.title}</strong>
                          <br />
                          <span className="field-hint">{ex.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}

                <p className="field-hint" style={{ marginTop: '0.85rem' }}>
                  Worked out {formatDateTime(rec.generated_at)} from numbers you typed in.
                  Anything in italics the app calculated. Anything upright is a real number
                  somebody read off a platform.
                </p>
              </details>
            </article>
          ))
        )}
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Groups of similar posts</h2>
          <span className="section-note">
            what the app can compare right now, and what it cannot
          </span>
        </div>
        {cohorts.length === 0 ? (
          <p className="field-hint">
            No groups yet. A group needs published posts attached to an account, with at
            least one set of numbers written down.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Format</th>
                  <th>Window</th>
                  <th className="num">Compared</th>
                  <th className="num">Held out</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {cohorts.map((c) => (
                  <tr key={c.key}>
                    <td data-label="Platform">{PLATFORM_LABELS[c.platform]}</td>
                    <td data-label="Format">{FORMAT_LABELS[c.format]}</td>
                    <td data-label="Window">{c.window}</td>
                    <td className="num" data-label="Compared">
                      {c.members.length}
                    </td>
                    <td className="num" data-label="Held out">
                      {c.excluded.length}
                    </td>
                    <td data-label="Status">
                      {c.members.length >= MIN_RELIABLE && c.distinctPillars.length >= 2 ? (
                        <Tag tone="violet">Reliable Pattern possible</Tag>
                      ) : c.members.length >= MIN_PATTERN ? (
                        <Tag>Emerging Pattern possible</Tag>
                      ) : (
                        <Tag tone="quiet">
                          Not yet measurable · {MIN_PATTERN - c.members.length} more needed
                        </Tag>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
