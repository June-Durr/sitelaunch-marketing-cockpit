import { useState } from 'react';
import { useData } from '../data/context';
import { Drawer } from '../components/Drawer';
import { BackupPanel } from './BackupPanel';
import { ProgramPanel } from './ProgramPanel';
import { IntegrationsPanel } from './IntegrationsPanel';
import { GoogleSyncPanel } from './GoogleSyncPanel';
import { LeadMirrorPanel } from './LeadMirrorPanel';
import { CalendarPanel } from './CalendarPanel';
import { Empty, Field, Notice, PageHead } from '../components/primitives';
import { DataGroup, Details, IntegrationCard } from '../components/DataGroups';
import { SectionNav } from '../components/SectionNav';
import { DATA_SECTIONS } from '../config/dataSections';
import {
  AccountsIcon, AnalyticsGroupIcon, LeadsGroupIcon,
  ManualImportIcon, ProgramIcon, SettingsGroupIcon, SocialGroupIcon,
} from '../components/icons';
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
        lede={
          mode === 'supabase' ? (
            <>
              Some of this brings itself in and some of it does not, and the groups below
              are sorted by which. Analytics and the follow-up calendar run on a schedule;
              the CSV importer and the backup file are the fallbacks for everything else.
            </>
          ) : (
            <>
              Everything in this app got here because somebody typed it in or imported it.
              Nothing syncs in browser-only mode, because automatic syncing needs a server
              to hold the Google credentials, so the app knows exactly what you have told
              it and nothing more.
            </>
          )
        }
      />

      <SectionNav items={DATA_SECTIONS} />

      <Notice tone="violet">
        Storage: <strong>{mode === 'supabase' ? 'Supabase' : 'this browser'}</strong>.{' '}
        {mode === 'supabase'
          ? 'Rows are scoped to your account by row-level security.'
          : 'Your data lives in this browser on this machine, and nowhere else. Export a backup before clearing site data. Adding Supabase credentials moves it to a real database without changing any of these screens.'}
      </Notice>

      <DataGroup
        id="analytics"
        title="Automatic analytics"
        Icon={AnalyticsGroupIcon}
        lede="Two Google properties that read themselves on a schedule. The only part of the cockpit you never type into."
      >
        <GoogleSyncPanel />
      </DataGroup>

      <DataGroup
        id="leads"
        title="Relationships and follow-up"
        Icon={LeadsGroupIcon}
        lede="Who you are talking to, and when you said you would talk to them next."
      >
        <LeadMirrorPanel />

        {/*
          The calendar gets its own anchor inside this group rather than a group
          of its own. It belongs with the lead mirror, because both are about
          relationships, but it is the destination people come looking for, so
          the jump bar needs to land on it directly.
        */}
        <div id="calendar" tabIndex={-1} className="data-anchor">
          <CalendarPanel />
        </div>

        <Details summary="How follow-ups and Google Calendar relate">
          <p>
            They are two different things and it is worth keeping them apart. The
            follow-up queue on Today is produced by this app's own rules: a lead's
            cadence, when it was last touched, and whether it is on hold. Nothing about
            Google decides it.
          </p>
          <p>
            Google Calendar is one of the places that decision gets written to, so you
            can read your week without opening this app. Disconnecting it changes what
            your calendar shows and changes nothing about which follow-ups are due.
          </p>
        </Details>
      </DataGroup>

      <DataGroup
        id="social"
        title="Remaining automatic connections"
        Icon={SocialGroupIcon}
        lede="Services that are not connected yet. Each one reports from stored state rather than from a sentence on this page."
      >
        <IntegrationsPanel />
      </DataGroup>

      <DataGroup
        id="fallback"
        title="Manual fallback tools"
        Icon={ManualImportIcon}
        tone="sunk"
        lede="For the days nothing was syncing, and for anything the automatic connections do not cover."
      >
        <IntegrationCard
          Icon={ManualImportIcon}
          title="Import a GA4 traffic export"
          purpose={
            mode === 'supabase'
              ? 'The fallback for the stretch before syncing started, or a report the sync does not ask for.'
              : 'In browser-only mode, this is how a Google Analytics export gets in at all.'
          }
          details={
            <p>
              Download a traffic report from Google Analytics as a CSV and drop it here.
              Empty cells stay empty; the importer never fills a gap with a zero. The
              report covers one date range, so tell the app which one before you import.
              Imported rows are kept apart from anything synced, so nothing gets counted
              twice, and they are unattributed until you link them to content in Website
              Outcomes.
            </p>
          }
        >
          <div className="form-grid" style={{ maxWidth: '34rem', marginTop: '1rem' }}>
            <Field label="Range start">
              <input
                type="date"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
              />
            </Field>
            <Field label="Range end">
              <input
                type="date"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
              />
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
        </IntegrationCard>

        <BackupPanel />
      </DataGroup>

      <DataGroup
        id="settings"
        title="Program and account settings"
        Icon={SettingsGroupIcon}
        lede="The handles posts go out under, and the ninety day window every comparison is measured inside."
      >
        <IntegrationCard
          Icon={AccountsIcon}
          title="Accounts"
          purpose="The handles a post can go out under, so the app knows what to compare it against."
          action={
            <button className="btn" onClick={() => setAddingAccount(true)}>
              + Add account
            </button>
          }
        >
          {data.accounts.length === 0 ? (
            <Empty title="No accounts yet">
              Every post needs an account, so the app knows which platform it went out on
              and what to fairly compare it against.
            </Empty>
          ) : (
            <div className="table-wrap" style={{ marginTop: '1rem' }}>
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
            </div>
          )}
        </IntegrationCard>

        <ProgramPanel onSaved={() => void refresh()} />

        <IntegrationCard
          Icon={ProgramIcon}
          title="Seed data"
          purpose="The handful of verified records the app starts with."
          action={
            <>
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
              ) : null}
              <button className="btn btn-quiet" onClick={() => void refresh()}>
                Reload data
              </button>
            </>
          }
          details={
            <>
              <p>
                The app starts with a handful of real records: the behind-the-scenes story
                posted to both Instagram and Facebook, the single Instagram view count
                that was actually checked, the one website visit it produced, and the
                older story Only in Dade boosted, which is kept out of the averages.
              </p>
              {resetToSeed ? null : (
                <p>
                  On Supabase, seed records come from supabase/seed.sql, run by hand once
                  you are signed in.
                </p>
              )}
            </>
          }
        />
      </DataGroup>

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
