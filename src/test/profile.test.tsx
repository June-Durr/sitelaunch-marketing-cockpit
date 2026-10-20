/**
 * Who a message says it is from, and where that is asked for.
 *
 * One store, two places to fill it in, and a rule that nothing guesses it. The
 * store is AppSettings.introduction, which already existed; these tests exist
 * partly to make sure a second one does not appear beside it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ProfileForm } from '../components/ProfileForm';
import { ProfilePrompt } from '../components/ProfilePrompt';
import { ProfilePanel } from '../screens/ProfilePanel';
import { DetailDisclosure } from '../assistant/DetailDisclosure';
import {
  DEFAULT_SETTINGS, coerceSettings, hasIdentity, readIdentity, readSettings,
  subscribeToSettings, writeIdentity, writeSettings,
} from '../data/settings';

afterEach(() => {
  localStorage.clear();
});

/* ================================================== the one identity store === */

describe('the identity store', () => {
  it('starts empty rather than guessed', () => {
    // Nothing is read from a sign in address or from the app's own branding. A
    // message under a name nobody chose is worse than one that waits.
    expect(DEFAULT_SETTINGS.introduction).toEqual({ name: null, business: null });
    expect(readIdentity()).toEqual({ name: null, business: null });
    expect(hasIdentity(readIdentity())).toBe(false);
  });

  it('saves without disturbing any other setting', () => {
    writeSettings({ ...readSettings(), pipelineView: 'board', showCompletedTasks: true });
    writeIdentity({ name: 'Invented Sender', business: 'Invented Studios' });

    const after = readSettings();
    expect(after.introduction).toEqual({
      name: 'Invented Sender', business: 'Invented Studios',
    });
    expect(after.pipelineView).toBe('board');
    expect(after.showCompletedTasks).toBe(true);
  });

  it('treats blank as absent rather than as an empty name', () => {
    writeIdentity({ name: '   ', business: '' });
    expect(readIdentity()).toEqual({ name: null, business: null });
    expect(hasIdentity({ name: '  ', business: 'x' })).toBe(false);
  });

  it('survives a backup round trip', () => {
    writeIdentity({ name: 'Invented Sender', business: 'Invented Studios' });
    const restored = coerceSettings(JSON.parse(JSON.stringify(readSettings())));
    expect(restored.introduction.name).toBe('Invented Sender');
  });

  it('tells an open screen when it changed', () => {
    // localStorage fires its event in other tabs and never in this one, so a
    // panel left open while somebody edits their profile would keep composing
    // from the old identity.
    const heard = vi.fn();
    const stop = subscribeToSettings(heard);
    writeIdentity({ name: 'Invented Sender', business: null });

    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0].introduction.name).toBe('Invented Sender');

    stop();
    writeIdentity({ name: 'Somebody Else', business: null });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

/* ======================================================== filling it in === */

describe('the profile form', () => {
  it('refuses to save without a name, and does not need a business', () => {
    render(<ProfileForm />);
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^Your name/), { target: { value: 'Invented Sender' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    expect(readIdentity()).toEqual({ name: 'Invented Sender', business: null });
    expect(screen.getByText(/Messages will say so/)).toBeTruthy();
  });

  it('keeps both values when both are given', () => {
    render(<ProfileForm />);
    fireEvent.change(screen.getByLabelText(/^Your name/), { target: { value: 'Invented Sender' } });
    fireEvent.change(screen.getByLabelText(/^Your business/), {
      target: { value: 'Invented Studios' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(readIdentity()).toEqual({
      name: 'Invented Sender', business: 'Invented Studios',
    });
  });

  it('opens with whatever is already saved', () => {
    writeIdentity({ name: 'Invented Sender', business: 'Invented Studios' });
    render(<ProfileForm />);
    expect((screen.getByLabelText(/^Your name/) as HTMLInputElement).value)
      .toBe('Invented Sender');
    expect((screen.getByLabelText(/^Your business/) as HTMLInputElement).value)
      .toBe('Invented Studios');
    // Nothing to save until something changes.
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a placeholder in the box and never in a saved value', () => {
    render(<ProfileForm />);
    const name = screen.getByLabelText(/^Your name/) as HTMLInputElement;
    expect(name.placeholder).not.toBe('');
    // A placeholder is a hint in an empty box, not a value anything can copy.
    expect(name.value).toBe('');
    expect(readIdentity().name).toBeNull();
  });
});

/* ============================================= asked once, at the start === */

describe('the onboarding prompt', () => {
  it('asks while there is no name on file', () => {
    render(<ProfilePrompt />);
    expect(screen.getByText(/Who should your messages say they are from/)).toBeTruthy();
    expect(screen.getByLabelText(/^Your name/)).toBeTruthy();
  });

  it('goes away for good once answered', async () => {
    render(<ProfilePrompt />);
    fireEvent.change(screen.getByLabelText(/^Your name/), { target: { value: 'Invented Sender' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.queryByText(/Who should your messages say they are from/)).toBeNull());
  });

  it('can be put off, and nothing else in the Cockpit waits on it', () => {
    render(<ProfilePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText(/Who should your messages say they are from/)).toBeNull();
    expect(readIdentity().name).toBeNull();
  });

  it('is absent from the start when a name is already saved', () => {
    writeIdentity({ name: 'Invented Sender', business: null });
    render(<ProfilePrompt />);
    expect(screen.queryByText(/Who should your messages say they are from/)).toBeNull();
  });
});

describe('the settings panel', () => {
  it('edits the same store and says who messages are signed as', async () => {
    writeIdentity({ name: 'Invented Sender', business: 'Invented Studios' });
    render(<MemoryRouter><ProfilePanel /></MemoryRouter>);

    expect(screen.getByText('Invented Sender, Invented Studios')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Your name/), { target: { value: 'Renamed Sender' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(readIdentity().name).toBe('Renamed Sender'));
  });

  it('says plainly that nothing is guessed', () => {
    render(<MemoryRouter><ProfilePanel /></MemoryRouter>);
    expect(screen.getByText(/will not guess that/)).toBeTruthy();
  });
});

/* ====================================================== the details, hidden === */

describe('the details disclosure', () => {
  const rows = [
    { label: 'Name', value: 'Invented Person' },
    { label: 'Business', value: null },
    { label: 'Met on', value: null, absent: 'Day not known' },
  ];

  it('summarises by default and keeps the inputs out of the way', () => {
    render(
      <DetailDisclosure rows={rows}>
        <input aria-label="Name input" defaultValue="Invented Person" />
      </DetailDisclosure>,
    );
    expect(screen.getByText('Invented Person')).toBeTruthy();
    expect(screen.queryByLabelText('Name input')).toBeNull();
  });

  it('says what is missing rather than leaving a blank line', () => {
    render(<DetailDisclosure rows={rows}><input aria-label="x" /></DetailDisclosure>);
    // The gap is the thing worth noticing, not the values that are fine.
    expect(screen.getByText('Day not known')).toBeTruthy();
    expect(screen.getByText('Not recorded')).toBeTruthy();
    expect(screen.getByText('2 not recorded')).toBeTruthy();
  });

  it('hands over the real inputs when asked, and back again', () => {
    render(
      <DetailDisclosure rows={rows}>
        <input aria-label="Name input" defaultValue="Invented Person" />
      </DetailDisclosure>,
    );
    fireEvent.click(screen.getByText('Edit details'));
    expect(screen.getByLabelText('Name input')).toBeTruthy();

    fireEvent.click(screen.getByText('Done editing'));
    expect(screen.queryByLabelText('Name input')).toBeNull();
    expect(screen.getByText('Invented Person')).toBeTruthy();
  });

  it('counts nothing missing when every row has a value', () => {
    render(
      <DetailDisclosure rows={[{ label: 'Name', value: 'Invented Person' }]}>
        <input aria-label="x" />
      </DetailDisclosure>,
    );
    expect(screen.queryByText(/not recorded/)).toBeNull();
  });
});
