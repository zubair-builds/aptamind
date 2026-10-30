// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportWizard } from './ImportWizard';

const mocks = vi.hoisted(() => ({ start: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/import-actions', () => ({ startMappedImportAction: mocks.start }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, refresh: vi.fn() }) }));

const CSV = 'Company,Owner email,Domain\nAcme,ceo@acme.com,acme.com\nBeta,cto@beta.io,beta.io\n';

async function pick(text: string | Uint8Array<ArrayBuffer>, name = 'UK fintechs.csv') {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([text], name, { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  mocks.start.mockReset();
  mocks.push.mockReset();
});
afterEach(cleanup);

describe('ImportWizard', () => {
  it('maps columns, uploads only the mapped ones and opens the import', async () => {
    mocks.start.mockResolvedValue({ ok: true, importId: 'imp_1' });
    render(<ImportWizard type="companies" lists={[]} />);
    await pick(CSV);

    const email = await screen.findByLabelText('Import Owner email as');
    expect((email as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Import Company as') as HTMLSelectElement).value).toBe('name');
    expect((screen.getByLabelText('Import Domain as') as HTMLSelectElement).value).toBe('domain');
    expect(screen.getByText(/never leave your browser/)).toBeTruthy();
    expect((screen.getByLabelText('Name of the new list') as HTMLInputElement).value).toBe('UK fintechs');

    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/imports/imp_1'));

    const fd = mocks.start.mock.calls[0]![0] as FormData;
    expect(fd.get('type')).toBe('companies');
    expect(fd.get('target')).toBe('new');
    expect(JSON.parse(fd.get('columns') as string)).toEqual({ name: 'Company', domain: 'Domain' });
    const sent = await (fd.get('file') as File).text();
    expect(sent).toBe('Company,Domain\r\nAcme,acme.com\r\nBeta,beta.io\r\n');
    expect(sent).not.toContain('@');
  });

  it('blocks start until the required column is mapped', async () => {
    render(<ImportWizard type="companies" lists={[]} />);
    await pick('Org,Notes\nAcme,x\n');
    await screen.findByLabelText('Import Org as');
    expect(screen.getByText('Choose a column for Name.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start import' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Import Org as'), { target: { value: 'name' } });
    expect(screen.queryByText('Choose a column for Name.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Start import' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('refuses a file that is not UTF-8', async () => {
    render(<ImportWizard type="companies" lists={[]} />);
    await pick(new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x5a, 0xfc, 0x72]));
    expect(await screen.findByText(/not UTF-8 text/)).toBeTruthy();
    expect(screen.queryByLabelText('Column mapping')).toBeNull();
  });

  it('shows the API problems in plain words when the upload is refused', async () => {
    mocks.start.mockResolvedValue({
      ok: false,
      stage: 'upload',
      code: 'invalid_upload',
      message: 'Upload refused',
      problems: [{ code: 'personal_data_column', column: 'Owner email' }],
    });
    render(<ImportWizard type="companies" lists={[]} />);
    await pick(CSV);
    await screen.findByLabelText('Import Company as');
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));
    expect(await screen.findByText(/looks like personal data.*\("Owner email"\)/)).toBeTruthy();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('blocks Start and lists the lines when rows cannot be read (nothing is dropped silently)', async () => {
    render(<ImportWizard type="companies" lists={[]} />);
    // A good row, a row with an extra value, then an unclosed quote that swallows the last row.
    await pick('Company,Domain\nAcme,acme.com\nBeta,beta.io,extra\n"Gamma,g.com\nAsana,asana.com\n');
    const alert = await screen.findByText(/2 rows cannot be read/);
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(screen.getByText(/Line 3:/)).toBeTruthy();
    expect(screen.getByText(/Line 4: a quote that is never closed/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start import' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns that every row goes to review when no domain or register id is mapped', async () => {
    render(<ImportWizard type="companies" lists={[]} />);
    await pick('Company,Website,Notes,Phone\nAcme,https://acme.com,x,1\n');
    await screen.findByLabelText('Import Company as');
    expect(screen.getAllByText(/every row will go to review/)).toHaveLength(2);
    expect(screen.getByText(/2 columns stay in your browser/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Import Notes as'), { target: { value: 'registerIds.lei' } });
    expect(screen.queryByText(/every row will go to review/)).toBeNull();
    expect(screen.getByText(/1 column stays in your browser/)).toBeTruthy();
  });

  it('takes an ATS board file with a company and a job link, with no identity warning', async () => {
    render(<ImportWizard type="ats_boards" lists={[]} />);
    await pick('Company,Job Link,Salary\nAcme,https://jobs.ashbyhq.com/acme/123,90k\n', 'Boards.csv');
    expect(((await screen.findByLabelText('Import Job Link as')) as HTMLSelectElement).value).toBe('url');
    expect(screen.queryByText(/every row will go to review/)).toBeNull();
    expect(screen.queryByText(/Choose a column for Board or job URL/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Import Job Link as'), { target: { value: '' } });
    expect(screen.getByText(/Choose a column for Board or job URL/)).toBeTruthy();
    expect(screen.queryByText(/every row will go to review/)).toBeNull();
  });

  it('asks for a CSV export when given a spreadsheet file', async () => {
    render(<ImportWizard type="ats_boards" lists={[]} />);
    await pick('not read', 'Boards.xlsx');
    expect(await screen.findByText(/This is a spreadsheet file, not a CSV file/)).toBeTruthy();
    cleanup();
    render(<ImportWizard type="ats_boards" lists={[]} />);
    // A workbook renamed to .csv is still a zip file.
    await pick(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), 'Boards.csv');
    expect(await screen.findByText(/save the sheet as "CSV UTF-8"/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Import .* as$/)).toBeNull();
  });

  it('defaults to an existing list and prefills its saved mapping', async () => {
    const lists = [
      { id: 'src_a', name: 'Alpha', columns: { name: 'Org', domain: 'Site' }, defaultCountry: 'GB' },
      { id: 'src_b', name: 'Beta', columns: { name: 'Company' } },
    ];
    render(<ImportWizard type="companies" lists={lists} />);
    await pick('Org,Site,Company\nAcme,acme.com,Acme Ltd\n');
    expect(((await screen.findByLabelText('Import Org as')) as HTMLSelectElement).value).toBe('name');
    expect((screen.getByLabelText('Import Site as') as HTMLSelectElement).value).toBe('domain');
    expect((screen.getByLabelText('Import Company as') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Default country (optional)') as HTMLInputElement).value).toBe('GB');
    expect((screen.getByLabelText('An existing list') as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByLabelText('Existing companies list'), { target: { value: 'src_b' } });
    expect((screen.getByLabelText('Import Company as') as HTMLSelectElement).value).toBe('name');
    expect((screen.getByLabelText('Import Org as') as HTMLSelectElement).value).toBe('');
  });

  it('keeps the wizard state and says so when the action call itself fails', async () => {
    mocks.start.mockRejectedValue(new Error('network down'));
    render(<ImportWizard type="companies" lists={[]} />);
    await pick(CSV);
    await screen.findByLabelText('Import Company as');
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));
    // A generous wait: the rejected call settles inside a transition, slower under a full parallel run.
    expect(
      await screen.findByText(/did not reach the server.*Your choices are kept/, {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect((screen.getByLabelText('Import Company as') as HTMLSelectElement).value).toBe('name');
    // The button can still show its pending label for a moment after the message appears.
    const start = await screen.findByRole('button', { name: 'Start import' }, { timeout: 5000 });
    expect((start as HTMLButtonElement).disabled).toBe(false);
  });

  it('names a column the server gives by position with its header name', async () => {
    mocks.start.mockResolvedValue({
      ok: false,
      stage: 'upload',
      code: 'invalid_upload',
      message: 'Upload refused',
      problems: [{ code: 'missing_column', column: 'column 2' }],
    });
    render(<ImportWizard type="companies" lists={[]} />);
    await pick(CSV);
    await screen.findByLabelText('Import Company as');
    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));
    // Column 2 of the uploaded file is Domain (Owner email never left the browser).
    expect(await screen.findByText(/missing from the file\. \("Domain"\)/)).toBeTruthy();
  });
});
