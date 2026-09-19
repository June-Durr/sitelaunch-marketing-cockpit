/**
 * Backup panel behaviour. The point of these tests is the gate: choosing a file
 * must never be enough to overwrite anything.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DataProvider } from '../data/DataProvider';
import { BackupPanel } from '../screens/BackupPanel';
import { buildSeedDataset } from '../data/seed';
import { DEFAULT_SETTINGS } from '../data/settings';
import { buildBackup, datasetCounts, serializeBackup, totalRows } from '../lib/backup';

function renderPanel() {
  return render(
    <DataProvider>
      <MemoryRouter>
        <BackupPanel />
      </MemoryRouter>
    </DataProvider>,
  );
}

function chooseFile(contents: string, name = 'backup.json') {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File([contents], name, { type: 'application/json' });
  fireEvent.change(input, { target: { files: [file] } });
}

const STORAGE_KEY = 'slmc.dataset.v1';

beforeEach(() => {
  localStorage.clear();
});

describe('the restore gate', () => {
  it('warns and asks for confirmation before replacing anything', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(/Export backup/)).toBeTruthy());

    const smaller = buildSeedDataset();
    smaller.contentItems = smaller.contentItems.slice(0, 1);
    chooseFile(serializeBackup(buildBackup(smaller, DEFAULT_SETTINGS)));

    await waitFor(() =>
      expect(screen.getByText('Review before replacing')).toBeTruthy(),
    );

    // The warning states the cost in records, and the confirm button is explicit.
    const seedTotal = totalRows(datasetCounts(buildSeedDataset()));
    expect(
      screen.getByText(new RegExp(`This will replace all ${seedTotal} records`)),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Replace all data with this backup/ }),
    ).toBeTruthy();

    // Nothing has been written while the review is on screen.
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.contentItems).toHaveLength(3);
  });

  it('leaves data untouched when the review is cancelled', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(/Export backup/)).toBeTruthy());

    const smaller = buildSeedDataset();
    smaller.contentItems = [];
    smaller.snapshots = [];
    chooseFile(serializeBackup(buildBackup(smaller, DEFAULT_SETTINGS)));

    await waitFor(() =>
      expect(screen.getByText('Review before replacing')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByText('Review before replacing')).toBeNull(),
    );
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.contentItems).toHaveLength(3);
  });

  it('replaces the data only after the confirm button is pressed', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(/Export backup/)).toBeTruthy());

    const smaller = buildSeedDataset();
    smaller.contentItems = smaller.contentItems.slice(0, 1);
    smaller.snapshots = smaller.snapshots.slice(0, 1);
    chooseFile(serializeBackup(buildBackup(smaller, DEFAULT_SETTINGS)));

    await waitFor(() =>
      expect(screen.getByText('Review before replacing')).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Replace all data with this backup/ }),
    );

    await waitFor(() => expect(screen.getByText(/Restored/)).toBeTruthy());
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.contentItems).toHaveLength(1);
  });
});

describe('a rejected file', () => {
  it('reports the problems and states that nothing changed', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(/Export backup/)).toBeTruthy());

    chooseFile('{ this is broken', 'corrupt.json');

    await waitFor(() =>
      expect(screen.getByText(/File rejected, and nothing was changed/)).toBeTruthy(),
    );
    expect(screen.getByText(/Your current data is\s+exactly as it was/)).toBeTruthy();
    // No confirm button is offered for a rejected file.
    expect(
      screen.queryByRole('button', { name: /Replace all data/ }),
    ).toBeNull();

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.contentItems).toHaveLength(3);
  });

  it('offers no restore path for a file with a corrupted metric', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(/Export backup/)).toBeTruthy());

    const parsed = JSON.parse(
      serializeBackup(buildBackup(buildSeedDataset(), DEFAULT_SETTINGS)),
    ) as { tables: Record<string, Record<string, unknown>[]> };
    parsed.tables.performance_snapshots[0].views = 'thirty-one';
    chooseFile(JSON.stringify(parsed));

    await waitFor(() =>
      expect(screen.getByText(/File rejected, and nothing was changed/)).toBeTruthy(),
    );
    expect(screen.getByText(/non-numeric "views"/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Replace all data/ }),
    ).toBeNull();
  });
});
