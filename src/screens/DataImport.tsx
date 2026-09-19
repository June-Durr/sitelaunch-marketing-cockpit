import { useState } from 'react';
import { useData } from '../data/context';
import { Drawer } from '../components/Drawer';
import { BackupPanel } from './BackupPanel';
import { ProgramPanel } from './ProgramPanel';
import { IntegrationsPanel } from './IntegrationsPanel';
import { Empty, Field, Notice, PageHead, Section } from '../components/primitives';
import { csvNumber, matchHeader, parseCsv } from '../lib/csv';
import { today } from '../lib/dates';
import type { Platform } from '../types/domain';
import { PLATFORM_LABELS } from '../types/domain';

const PLATFORMS = Object.keys(PLATFORM_LABELS) as Platform[];

/** GA4 traffic-acquisition exports vary by property; accept the common spellings. */
const GA4_COLUMNS = {
  source: ['session source', 'source', 'sessionsource'],
  medium: ['session medium', 'medium', 'sessionmedium'],
  campaign: ['session campaign', 'campaign', 'sessioncampaign', 'session manual campaign name'],
  sessions: ['sessions'],
  active_users: ['active users', 'users', 'total users'],
  engaged_sessions: ['engaged sessions'],
  engagement_time_secs: ['average engagement time per session', 'average engagement time', 'user engagement'],
  cta_clicks: ['cta clicks', 'clicks'],
  form_starts: ['form starts', 'form_start'],
  generate_lead_events: ['generate_lead', 'generate lead', 'conversions', 'key events'],
  qualified_inquiries: ['qualified inquiries', 'qualified'],
};

export function DataImport() {
  const { data, mode, insert, insertMany, remove, resetToSeed, refresh } = useData();
  const [addingAccount, setAddingAccount] = useState(false);
  const [importReport, setImportReport] = useState<string | null>(null);
  const [rangeStart, setRangeStart] = useState(today());
  const [rangeEnd, setRangeEnd] = useState(today());

  async function importGa4(file: File) {
    const text = await file.text();
    const { headers, rows } = parseCsv(text);
    if (rows.length === 0) {
      setImportReport('No data rows were found in that file.');
      return;
    }

    const column = Object.fromEntries(
      Object.entries(GA4_COLUMNS).map(([key, candidates]) => [
        key,
        matchHeader(headers, candidates),
      ]),
    ) as Record<keyof typeof GA4_COLUMNS, string | null>;

    const unmapped = Object.entries(column)
      .filter(([, header]) => header === null)
      .map(([key]) => key);

    const payload = rows.map((row) => ({
      content_item_id: null,
      range_start: rangeStart,
      range_end: rangeEnd,
      source: column.source ? row[column.source] : null,
      medium: column.medium ? row[column.medium] : null,
      campaign: column.campaign ? row[column.campaign] : null,
      sessions: column.sessions ? csvNumber(row[column.sessions]) : null,
      active_users: column.active_users ? csvNumber(row[column.active_users]) : null,
      engagement_time_secs: column.engagement_time_secs
        ? csvNumber(row[column.engagement_time_secs])
        : null,
      engaged_sessions: column.engaged_sessions ? csvNumber(row[column.engaged_sessions]) : null,
      cta_clicks: column.cta_clicks ? csvNumber(row[column.cta_clicks]) : null,
      form_starts: column.form_starts ? csvNumber(row[column.form_starts]) : null,
      generate_lead_events: column.generate_lead_events
        ? csvNumber(row[column.generate_lead_events])
        : null,
      qualified_inquiries: column.qualified_inquiries
        ? csvNumber(row[column.qualified_inquiries])
        : null,
      ingest_source: 'csv' as const,
      notes: `Imported from ${file.name}`,
      is_seed: false,
    }));

    await insertMany('traffic_snapshots', payload);
    setImportReport(
      `Imported ${payload.length} ${payload.length === 1 ? 'row' : 'rows'} for ${rangeStart} to ${rangeEnd}. ` +
        (unmapped.length
          ? `Nothing in the file matched ${unmapped.join(', ')}, so those were left blank rather than set to zero. `
          : 'Every expected column was matched. ') +
        `Rows are unattributed until you link them to content in Website Outcomes.`,
    );
  }

  return (
    <>
      <PageHead
        kicker="Where the numbers come from"
        title="Data & Import"
        lede="Everything in this app got here because somebody typed it in or imported it. Nothing is wired up to Instagram, Facebook or Google Analytics, so the app knows exactly what you have told it and nothing more."
      />

      <Notice tone="violet">
        Storage: <strong>{mode === 'supabase' ? 'Supabase' : 'this browser'}</strong>.{' '}
        {mode === 'supabase'
          ? 'Rows are scoped to your account by row-level security.'
          : 'Your data lives in this browser on this machine, and nowhere else. Export a backup before clearing site data. Adding Supabase credentials moves it to a real database without changing any of these screens.'}
      </Notice>

      <Section
        title="Accounts"
        action={
          <button className="btn btn-quiet" onClick={() => setAddingAccount(true)}>
            + Add account
          </button>
        }
      >
        {data.accounts.length === 0 ? (
          <Empty title="No accounts yet">
            Every post needs an account, so the app knows which platform it went out on and
            what to fairly compare it against.
          </Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Handle</th>
                <th>Name</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.id}>
                  <td data-label="Platform">{PLATFORM_LABELS[a.platform]}</td>
                  <td data-label="Handle">{a.handle}</td>
                  <td data-label="Name">{a.display_name ?? 'Not set'}</td>
                  <td data-label="Note">{a.notes ?? 'None'}</td>
                  <td data-label="">
                    <button
                      className="btn btn-quiet btn-danger"
                      onClick={() => remove('accounts', a.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <ProgramPanel onSaved={() => void refresh()} />

      <BackupPanel />

      <Section title="Import GA4 traffic acquisition">
        <p className="page-lede" style={{ marginTop: 0 }}>
          Download a traffic report from Google Analytics as a CSV and drop it here. Empty
          cells stay empty; the importer never fills a gap with a zero. The report covers
          one date range, so tell the app which one before you import.
        </p>
        <div className="form-grid" style={{ maxWidth: '34rem' }}>
          <Field label="Range start">
            <input
              type="date"
              value={rangeStart}
              onChange={(e) => setRangeStart(e.target.value)}
            />
          </Field>
          <Field label="Range end">
            <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
          </Field>
          <Field label="CSV file" span>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importGa4(file);
                e.target.value = '';
              }}
            />
          </Field>
        </div>
        {importReport ? <p className="notice notice-violet">{importReport}</p> : null}
      </Section>

      <IntegrationsPanel />

      <Section title="Seed data">
        <p className="page-lede" style={{ marginTop: 0 }}>
          The app starts with a handful of real records: the behind-the-scenes story posted
          to both Instagram and Facebook, the single Instagram view count that was actually
          checked, the one website visit it produced, and the older story Only in Dade
          boosted, which is kept out of the averages.
        </p>
        <div className="btn-row">
          {resetToSeed ? (
            <button
              className="btn"
              onClick={() => {
                if (confirm('Replace all local data with the seed records?')) {
                  void resetToSeed();
                }
              }}
            >
              Reset to seed records
            </button>
          ) : (
            <span className="field-hint">
              On Supabase, seed records come from supabase/seed.sql, run by hand once you are signed in.
            </span>
          )}
          <button className="btn btn-quiet" onClick={() => void refresh()}>
            Reload data
          </button>
        </div>
      </Section>

      {addingAccount ? (
        <AccountForm onClose={() => setAddingAccount(false)} onSave={insert} />
      ) : null}
    </>
  );
}

function AccountForm({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: ReturnType<typeof useData>['insert'];
}) {
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <Drawer title="Add account" onClose={onClose}>
      <div className="form-grid">
        <Field label="Platform">
          <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABELS[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Handle">
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@sitelaunchstudios"
          />
        </Field>
        <Field label="Display name" span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label="Notes" span hint="For example, which metrics this platform withholds">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!handle.trim()}
          onClick={async () => {
            await onSave('accounts', {
              platform,
              handle: handle.trim(),
              display_name: displayName.trim() || null,
              provider_account_id: null,
              is_active: true,
              notes: notes.trim() || null,
              is_seed: false,
            });
            onClose();
          }}
        >
          Add account
        </button>
      </div>
    </Drawer>
  );
}
