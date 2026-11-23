import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Transactions from '../Transactions';
import { listAllActivity, type VaultActivityRecord } from '../../services/vaultService';
import { useConnectivityStore } from '../../services/connectivity';
import { downloadCsv, toCsv } from '../../utils/csv';

vi.mock('../../services/vaultService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/vaultService')>();
  return {
    ...actual,
    listAllActivity: vi.fn(),
  };
});

vi.mock('../../context/WalletContext', () => ({
  useWallet: () => ({ network: 'TESTNET' }),
}));

vi.mock('../../utils/csv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/csv')>();
  return {
    ...actual,
    downloadCsv: vi.fn(),
  };
});

const mockListAllActivity = vi.mocked(listAllActivity);
const mockDownloadCsv = vi.mocked(downloadCsv);

function makeRecord(overrides: Partial<VaultActivityRecord> = {}): VaultActivityRecord {
  return {
    id: 'act-1',
    type: 'create',
    vault: 'Alpha Vault',
    amount: 100,
    fee: 0.01,
    block: 1,
    hash: '0x1234567890abcdef',
    status: 'confirmed',
    from: 'GFROM',
    to: 'GTO',
    timestamp: new Date(1000),
    memo: '',
    ...overrides,
  };
}

function renderTransactions(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Transactions />
    </MemoryRouter>
  );
}

function makeRecords(count: number): VaultActivityRecord[] {
  return Array.from({ length: count }, (_, index) =>
    makeRecord({
      id: `act-${index + 1}`,
      type: index % 5 === 0 ? 'release' : 'create',
      vault: `Vault ${index + 1}`,
      amount: index + 1,
      fee: 0.1,
      status: index % 2 === 0 ? 'confirmed' : 'pending',
      timestamp: new Date(index * 1000),
    })
  );
}

describe('Transactions page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useConnectivityStore.getState().reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    useConnectivityStore.getState().reset();
  });

  it('shows loading text while listAllActivity is pending', () => {
    mockListAllActivity.mockImplementation(() => new Promise(() => {}));

    renderTransactions();

    const loading = screen.getByText('Loading activity...');
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute('aria-live', 'polite');
  });

  it('shows error message in an alert when listAllActivity rejects', async () => {
    mockListAllActivity.mockRejectedValueOnce(new Error('boom'));

    renderTransactions();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('boom');
  });

  it('shows create-vault link to /vaults/create when activity is empty', async () => {
    mockListAllActivity.mockResolvedValueOnce([]);

    renderTransactions();

    const link = await screen.findByRole('link', { name: 'Create a vault' });
    expect(link).toHaveAttribute('href', '/vaults/create');
  });

  it('disables the export button when there are zero rows', async () => {
    mockListAllActivity.mockResolvedValueOnce([]);

    renderTransactions();

    await screen.findByRole('link', { name: 'Create a vault' });
    expect(screen.getByRole('button', { name: /export csv/i })).toBeDisabled();
  });

  it('exports the visible rows once with the transactions CSV headers', async () => {
    mockListAllActivity.mockResolvedValueOnce([makeRecord()]);

    renderTransactions();

    const button = await screen.findByRole('button', { name: /export csv/i });
    act(() => {
      button.click();
    });

    expect(mockDownloadCsv).toHaveBeenCalledTimes(1);
    const csv = String(mockDownloadCsv.mock.calls[0]?.[0] ?? '');
    const headerLine = csv.split('\n')[0]?.replace(/\r$/, '');
    expect(headerLine).toBe(toCsv([], 'transactions').split('\n')[0]?.replace(/\r$/, ''));
  });

  it('neutralises formula-like memos in the export', async () => {
    mockListAllActivity.mockResolvedValueOnce([
      makeRecord({ memo: '=HYPERLINK("x")' }),
    ]);

    renderTransactions();

    const button = await screen.findByRole('button', { name: /export csv/i });
    act(() => {
      button.click();
    });

    const csv = String(mockDownloadCsv.mock.calls[0]?.[0] ?? '');
    expect(csv).toContain("'=HYPERLINK");
  });

  it('renders a valid transaction hash as a Stellar Expert link', async () => {
    const hash = 'a'.repeat(64);
    mockListAllActivity.mockResolvedValueOnce([makeRecord({ hash })]);

    renderTransactions();

    const link = await screen.findByRole('link', { name: /aaaaaaaa/ });
    expect(link.getAttribute('href')).toMatch(
      /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\//
    );
  });

  it('renders no anchor for a path-traversal hash', async () => {
    mockListAllActivity.mockResolvedValueOnce([makeRecord({ hash: '../../x' })]);

    renderTransactions();

    await screen.findByText('Alpha Vault');
    expect(screen.queryByRole('link', { name: /\.\.\/\.\.\/x/ })).toBeNull();
  });

  it('renders an em dash for an undefined hash without throwing', async () => {
    mockListAllActivity.mockResolvedValueOnce([
      makeRecord({ hash: undefined as unknown as string }),
    ]);

    renderTransactions();

    expect(await screen.findByText('—')).toBeInTheDocument();
  });

  it('renders rows newest first regardless of input order', async () => {
    const older = makeRecord({ id: 'old', vault: 'Older Vault', timestamp: new Date(1) });
    const newer = makeRecord({ id: 'new', vault: 'Newer Vault', timestamp: new Date(2) });
    mockListAllActivity.mockResolvedValueOnce([older, newer]);

    renderTransactions();

    await screen.findByText('Newer Vault');
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Newer Vault');
    expect(rows[2]).toHaveTextContent('Older Vault');
  });

  it('filters by event type and shows totals for all filtered rows', async () => {
    mockListAllActivity.mockResolvedValueOnce(makeRecords(25));

    renderTransactions();

    fireEvent.change(await screen.findByLabelText('Filter by event type'), {
      target: { value: 'release' },
    });

    expect(screen.getAllByText('Funds released')).toHaveLength(5);
    expect(screen.getByText('Filtered total (5 transactions)')).toBeInTheDocument();
    expect(screen.getByText('55.00')).toBeInTheDocument();
    expect(screen.getByText('0.50')).toBeInTheDocument();
  });

  it('filters by status as well as event type', async () => {
    mockListAllActivity.mockResolvedValueOnce(makeRecords(25));

    renderTransactions();

    fireEvent.change(await screen.findByLabelText('Filter by event type'), {
      target: { value: 'release' },
    });
    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: { value: 'pending' },
    });

    expect(screen.getAllByText('Funds released')).toHaveLength(2);
    expect(screen.getByText('Filtered total (2 transactions)')).toBeInTheDocument();
  });

  it('sorts by amount descending', async () => {
    mockListAllActivity.mockResolvedValueOnce(makeRecords(25));

    renderTransactions();

    fireEvent.change(await screen.findByLabelText('Sort transactions by'), {
      target: { value: 'amount' },
    });

    const dataRows = screen.getAllByRole('row');
    expect(dataRows[1]).toHaveTextContent('Vault 25');
  });

  it('paginates to page 2 and clamps an oversized URL page to the last page', async () => {
    mockListAllActivity.mockResolvedValueOnce(makeRecords(25));

    const { unmount } = renderTransactions();
    await screen.findByText('Page 1 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Go to page 2' }));
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(12);
    expect(screen.getByText('Vault 15')).toBeInTheDocument();
    expect(screen.queryByText('Vault 16')).not.toBeInTheDocument();

    unmount();
    mockListAllActivity.mockResolvedValueOnce(makeRecords(25));
    renderTransactions('/?page=99');

    expect(await screen.findByText('Page 3 of 3')).toBeInTheDocument();
    expect(screen.getByText('Vault 5')).toBeInTheDocument();
    expect(screen.queryByText('Vault 6')).not.toBeInTheDocument();
  });

  it('ignores an unknown event type in the URL', async () => {
    mockListAllActivity.mockResolvedValueOnce(makeRecords(25));

    renderTransactions('/?type=bogus');

    expect(await screen.findByText('Filtered total (25 transactions)')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(12);
  });

  it('re-triggers loading when connectivity recovers', async () => {
    vi.stubEnv('VITE_API', 'https://api.disciplr.test');
    useConnectivityStore.getState().setStatus('offline');

    mockListAllActivity.mockRejectedValueOnce(new Error('Network error'));

    renderTransactions();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    expect(mockListAllActivity).toHaveBeenCalledTimes(1);

    mockListAllActivity.mockResolvedValueOnce([
      makeRecord({ id: 'recovered', vault: 'Recovered Vault', timestamp: new Date(3) }),
    ]);

    act(() => {
      useConnectivityStore.getState().setStatus('online');
    });

    await waitFor(() => {
      expect(screen.getByText('Recovered Vault')).toBeInTheDocument();
    });
    expect(mockListAllActivity).toHaveBeenCalledTimes(2);
  });
});
