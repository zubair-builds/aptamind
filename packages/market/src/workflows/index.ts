import { ref, type WorkflowSpec } from '@aptamind/workflow-sdk';
import { SPONSOR_COLUMN_MAPPING } from '../sources/providers/uk-sponsor-register';
import { FETCH_RETRY } from '../sources/schedule-spread';

/**
 * Market workflow templates (code-authored, versioned on registration).
 * Each composes generic capabilities with Market domain capabilities; business rules live in
 * the domain capabilities, never in the workflow definitions.
 */

const scheduleTrigger = {
  id: 'trigger',
  capability: { type: 'core.schedule_trigger', version: 1 },
  input: { payload: ref('run.input'), trigger: ref('trigger') },
};
const manualTrigger = {
  id: 'trigger',
  capability: { type: 'core.manual_trigger', version: 1 },
  input: { payload: ref('run.input'), trigger: ref('trigger') },
};

/** WF1 / M2 — UK licensed sponsor register → companies with licence capability evidence. */
export const ukSponsorImport: WorkflowSpec = {
  key: 'market.uk_sponsor_register.import',
  title: 'UK sponsor register import',
  description:
    'Downloads the UK register of licensed sponsors, stores the raw CSV, parses and maps rows, and resolves/reconciles each organisation. ' +
    'Registry presence is company licence evidence, never job-level sponsorship. Pass `snapshotId` to reprocess a stored snapshot without refetching, or `force: true` to import an unchanged file in full ' +
    '(e.g. to re-check sponsors that matched no known company before the universe grew).',
  inputSchema: {
    type: 'object',
    required: ['sourceId'],
    properties: {
      sourceId: { type: 'string' },
      snapshotId: { type: 'string' },
      csvUrl: { type: 'string' },
      force: { type: 'boolean' },
    },
  },
  nodes: [
    scheduleTrigger,
    {
      id: 'locate',
      title: 'Locate current CSV',
      capability: { type: 'market.locate_sponsor_register_csv', version: 1 },
      input: {
        sourceId: ref('nodes.trigger.output.payload.sourceId'),
        snapshotId: ref('nodes.trigger.output.payload.snapshotId', null),
        csvUrl: ref('nodes.trigger.output.payload.csvUrl', null),
      },
    },
    {
      id: 'download',
      title: 'Download & store snapshot',
      capability: { type: 'market.acquire_snapshot', version: 1 },
      input: {
        sourceId: ref('nodes.trigger.output.payload.sourceId'),
        url: ref('nodes.locate.output.csvUrl'),
        snapshotId: ref('nodes.trigger.output.payload.snapshotId', null),
      },
      retry: { maxAttempts: 4, backoffMs: 5_000 },
    },
    {
      // Wave 7: an unchanged file already applied by a complete import ends the run here.
      id: 'unchanged',
      title: 'Skip an unchanged, already applied file',
      capability: { type: 'market.check_dataset_unchanged', version: 1 },
      input: {
        sourceId: ref('run.input.sourceId'),
        snapshotId: ref('nodes.download.output.snapshotId'),
        unchanged: ref('nodes.download.output.unchanged'),
        reprocessing: ref('nodes.download.output.reprocessing'),
        force: ref('nodes.trigger.output.payload.force', false),
      },
    },
    {
      id: 'route',
      capability: { type: 'core.switch', version: 1 },
      config: {
        cases: [{ branch: 'unchanged', conditions: [{ path: '', op: 'eq', value: 'unchanged' }] }],
        defaultBranch: 'import',
      },
      input: { value: ref('nodes.unchanged.output.path') },
    },
    {
      id: 'parse',
      title: 'Parse CSV',
      capability: { type: 'core.parse_csv', version: 1 },
      input: { artifact: ref('nodes.download.output.artifact') },
    },
    {
      id: 'map',
      title: 'Map rows → company candidates',
      capability: { type: 'core.map_fields', version: 1 },
      config: { mapping: SPONSOR_COLUMN_MAPPING },
      input: { records: ref('nodes.parse.output.records') },
    },
    {
      id: 'valid',
      title: 'Drop rows without a name or route',
      capability: { type: 'core.filter', version: 1 },
      config: {
        conditions: [
          { path: 'name', op: 'not_empty' },
          { path: 'route', op: 'not_empty' },
        ],
        mode: 'all',
      },
      input: { records: ref('nodes.map.output.records') },
    },
    {
      id: 'companies',
      title: 'Resolve → observe → reconcile (bounded fan-out)',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: {
          capability: { type: 'market.process_sponsor_row', version: 1 },
          input: {
            sourceId: ref('run.input.sourceId'),
            snapshotId: ref('nodes.download.output.snapshotId'),
            artifactId: ref('nodes.download.output.artifact.artifactId'),
            rowIndex: ref('itemIndex'),
            row: ref('item'),
          },
        },
        concurrency: 4,
        batchSize: 200,
        maxFailureRatio: 0.2,
      },
      input: { items: ref('nodes.valid.output.records') },
    },
    {
      id: 'finalize',
      title: 'Finalize import (delisting guard)',
      capability: { type: 'market.finalize_dataset_import', version: 1 },
      input: {
        sourceId: ref('run.input.sourceId'),
        snapshotId: ref('nodes.download.output.snapshotId'),
        importStartedAt: ref('nodes.trigger.output.firedAt'),
        snapshotFetchedAt: ref('nodes.download.output.fetchedAt'),
        rowCount: ref('nodes.valid.output.count'),
        fanout: ref('nodes.companies.output'),
      },
    },
    {
      // Both paths end here, so `run.output` is defined for an unchanged file too (PR #6 review).
      id: 'report',
      title: 'Import report',
      capability: { type: 'market.dataset_import_report', version: 1 },
      input: {
        finalize: ref('nodes.finalize.output', null),
        unchanged: ref('nodes.unchanged.output'),
      },
    },
  ],
  edges: [
    { from: 'trigger', to: 'locate' },
    { from: 'locate', to: 'download' },
    { from: 'download', to: 'unchanged' },
    { from: 'unchanged', to: 'route' },
    { from: 'route', to: 'parse', when: { branch: 'import' } },
    { from: 'parse', to: 'map' },
    { from: 'map', to: 'valid' },
    { from: 'valid', to: 'companies' },
    { from: 'companies', to: 'finalize' },
    { from: 'finalize', to: 'report' },
    { from: 'route', to: 'report', when: { branch: 'unchanged' } },
  ],
  outputNode: 'report',
  labels: { domain: 'market', stream: 'companies' },
};

/**
 * M8.1 — company directory CSV import (upload-only source, provider `company_directory`). The
 * upload was checked before storage (size, rows, company-only columns); this reads the stored
 * snapshot with the source's column map, reports every row it cannot import, and records each
 * valid row as a company observation with snapshot provenance (`row:<line>`), resolved (review on
 * ambiguity) and reconciled. Re-importing the same file is idempotent (same snapshot, same
 * observation ids). A directory never delists: absence from a later file proves nothing.
 */
export const companyDirectoryImport: WorkflowSpec = {
  key: 'market.company_directory.import',
  title: 'Company directory import',
  description:
    'Imports an uploaded company directory CSV (configurable column map) through source → snapshot → observation → resolution → reconciliation. Row errors are reported in a review, never dropped. Requires `snapshotId` (upload-only).',
  inputSchema: {
    type: 'object',
    required: ['sourceId', 'snapshotId'],
    properties: { sourceId: { type: 'string' }, snapshotId: { type: 'string' } },
  },
  nodes: [
    manualTrigger,
    {
      id: 'download',
      title: 'Load stored snapshot',
      capability: { type: 'market.acquire_snapshot', version: 1 },
      input: {
        sourceId: ref('nodes.trigger.output.payload.sourceId'),
        url: null,
        snapshotId: ref('nodes.trigger.output.payload.snapshotId'),
      },
    },
    {
      id: 'map',
      title: 'Map rows → company candidates (row errors reported)',
      capability: { type: 'market.map_company_directory', version: 1 },
      input: {
        sourceId: ref('run.input.sourceId'),
        snapshotId: ref('nodes.download.output.snapshotId'),
        artifact: ref('nodes.download.output.artifact'),
      },
    },
    {
      id: 'companies',
      title: 'Observe → resolve → reconcile (bounded fan-out)',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: {
          capability: { type: 'market.process_directory_row', version: 1 },
          input: {
            sourceId: ref('run.input.sourceId'),
            snapshotId: ref('nodes.download.output.snapshotId'),
            artifactId: ref('nodes.download.output.artifact.artifactId'),
            candidate: ref('item'),
          },
        },
        concurrency: 4,
        batchSize: 200,
        // Row failures are reported by finalize (a review), so the node itself never fails on them.
        maxFailureRatio: 1,
      },
      input: { items: ref('nodes.map.output.records') },
    },
    {
      id: 'finalize',
      title: 'Finalize import (row-error review)',
      capability: { type: 'market.finalize_directory_import', version: 2 },
      input: {
        sourceId: ref('run.input.sourceId'),
        snapshotId: ref('nodes.download.output.snapshotId'),
        artifactId: ref('nodes.download.output.artifact.artifactId'),
        rowCount: ref('nodes.map.output.rowCount'),
        importable: ref('nodes.map.output.importable'),
        errorCount: ref('nodes.map.output.errorCount'),
        errors: ref('nodes.map.output.errors'),
        rowWarningCount: ref('nodes.map.output.rowWarningCount', 0),
        report: ref('nodes.map.output.report', null),
        records: ref('nodes.map.output.records'),
        warnings: ref('nodes.map.output.warnings', []),
        importStartedAt: ref('nodes.trigger.output.firedAt'),
        fanout: ref('nodes.companies.output'),
      },
    },
    {
      id: 'discover',
      title: 'Queue careers discovery for created or changed companies',
      capability: { type: 'market.queue_careers_discovery', version: 1 },
      input: { companyIds: ref('nodes.finalize.output.changedCompanyIds', []) },
    },
  ],
  edges: [
    { from: 'trigger', to: 'download' },
    { from: 'download', to: 'map' },
    { from: 'map', to: 'companies' },
    { from: 'companies', to: 'finalize' },
    { from: 'finalize', to: 'discover' },
  ],
  // The import report (`GET /api/imports/:id`) is the finalize output.
  outputNode: 'finalize',
  labels: { domain: 'market', stream: 'companies' },
};

/**
 * M8.2 — known ATS board file import (upload-only source, provider `ats_board_directory`). Same
 * reader and header rules as M8.1; a board comes from provider and token, or from a board or job
 * URL (OPS-1b). Each row resolves to a company in order: the board's own source, domain, `ats` id,
 * a unique exact name without a domain; an ambiguous match, or a board another company owns,
 * raises a review. With no match, one liveness fetch (bounded fan-out, shared host limiter)
 * decides: a live board anchors a new company and becomes its job source; a board that is not
 * live or unreachable fails the row and creates nothing. Re-importing the same file changes nothing.
 */
export const atsBoardsImport: WorkflowSpec = {
  key: 'market.ats_boards.import',
  title: 'Known ATS board import',
  description:
    'Imports an uploaded CSV of known ATS boards (provider and token, or a board/job URL): attaches each board to an existing company, or creates a company anchored on a live board, and registers it as a job source (review when ambiguous or owned by another company; a board that is not live fails its row). Requires `snapshotId` (upload-only).',
  inputSchema: {
    type: 'object',
    required: ['sourceId', 'snapshotId'],
    properties: {
      sourceId: { type: 'string' },
      snapshotId: { type: 'string' },
      /** OPS-5: set by a `jobs` (job URL) import: refresh the resolved boards after the rows. */
      refreshBoards: { type: 'boolean' },
    },
  },
  nodes: [
    manualTrigger,
    {
      id: 'download',
      title: 'Load stored snapshot',
      capability: { type: 'market.acquire_snapshot', version: 1 },
      input: {
        sourceId: ref('nodes.trigger.output.payload.sourceId'),
        url: null,
        snapshotId: ref('nodes.trigger.output.payload.snapshotId'),
      },
    },
    {
      id: 'map',
      title: 'Map rows → boards (row errors reported)',
      capability: { type: 'market.map_ats_board_directory', version: 2 },
      input: {
        sourceId: ref('run.input.sourceId'),
        snapshotId: ref('nodes.download.output.snapshotId'),
        artifact: ref('nodes.download.output.artifact'),
      },
    },
    {
      id: 'rows',
      title: 'Resolve company or check board is live → register board (bounded fan-out)',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: {
          capability: { type: 'market.process_ats_board_row', version: 2 },
          input: {
            sourceId: ref('run.input.sourceId'),
            snapshotId: ref('nodes.download.output.snapshotId'),
            artifactId: ref('nodes.download.output.artifact.artifactId'),
            row: ref('item'),
          },
        },
        // Liveness fetches queue behind the shared per-host limiter, so more rows than one host
        // allows can wait here while rows of other providers proceed.
        concurrency: 8,
        batchSize: 200,
        maxFailureRatio: 1,
        // Small per-row outcomes; finalize counts them (a large list is stored as an artifact).
        collectOutputs: true,
      },
      input: { items: ref('nodes.map.output.records') },
    },
    {
      id: 'finalize',
      title: 'Finalize import (row-error review)',
      capability: { type: 'market.finalize_ats_board_import', version: 2 },
      input: {
        sourceId: ref('run.input.sourceId'),
        snapshotId: ref('nodes.download.output.snapshotId'),
        rowCount: ref('nodes.map.output.rowCount'),
        importable: ref('nodes.map.output.importable'),
        errorCount: ref('nodes.map.output.errorCount'),
        errors: ref('nodes.map.output.errors'),
        report: ref('nodes.map.output.report', null),
        warningCount: ref('nodes.map.output.warningCount'),
        skippedCount: ref('nodes.map.output.skippedCount'),
        warnings: ref('nodes.map.output.warnings'),
        importStartedAt: ref('nodes.trigger.output.firedAt'),
        fanout: ref('nodes.rows.output'),
      },
    },
    {
      id: 'refresh',
      title: 'Job URL import: refresh resolved boards → canonical jobs',
      capability: { type: 'market.refresh_imported_boards', version: 1 },
      input: {
        enabled: ref('run.input.refreshBoards', false),
        fanout: ref('nodes.rows.output'),
      },
    },
  ],
  edges: [
    { from: 'trigger', to: 'download' },
    { from: 'download', to: 'map' },
    { from: 'map', to: 'rows' },
    { from: 'rows', to: 'finalize' },
    { from: 'rows', to: 'refresh' },
  ],
  outputNode: 'finalize',
  labels: { domain: 'market', stream: 'jobs' },
};

/**
 * M8.4 — any public sponsor register with a register adapter (`sources/providers/registers`): the
 * source's `provider` selects the adapter (parser per format, route taxonomy, identity namespace,
 * evidence tier, scope). Same guarantees as the UK import: raw snapshot first, idempotent rows,
 * and a finalisation that delists only after a healthy complete import (anomaly guard).
 * The UK register keeps its own M2 workflow (`market.uk_sponsor_register.import`); its adapter
 * also runs here with the same row mapping.
 */
export const sponsorRegisterImport: WorkflowSpec = {
  key: 'market.sponsor_register.import',
  title: 'Sponsor register import',
  description:
    'Downloads a public sponsor register (fetch through the SSRF-safe client, or an uploaded snapshot), parses it with the register adapter of the source provider, keeps only evidence routes, and resolves/reconciles each organisation. ' +
    'A listing is company-level evidence for the register’s country only, never job-level sponsorship. Pass `snapshotId` to reprocess a stored snapshot, `url` to fetch a specific file.',
  inputSchema: {
    type: 'object',
    required: ['sourceId'],
    properties: { sourceId: { type: 'string' }, snapshotId: { type: 'string' }, url: { type: 'string' } },
  },
  nodes: [
    scheduleTrigger,
    {
      id: 'locate',
      title: 'Locate register file',
      capability: { type: 'market.locate_register_download', version: 1 },
      input: {
        sourceId: ref('nodes.trigger.output.payload.sourceId'),
        snapshotId: ref('nodes.trigger.output.payload.snapshotId', null),
        url: ref('nodes.trigger.output.payload.url', null),
      },
    },
    {
      id: 'download',
      title: 'Download & store snapshot',
      capability: { type: 'market.acquire_snapshot', version: 1 },
      input: {
        sourceId: ref('nodes.trigger.output.payload.sourceId'),
        url: ref('nodes.locate.output.url'),
        snapshotId: ref('nodes.trigger.output.payload.snapshotId', null),
      },
      retry: { maxAttempts: 4, backoffMs: 5_000 },
    },
    {
      id: 'parse',
      title: 'Parse register (adapter) and keep evidence routes',
      capability: { type: 'market.parse_register_snapshot', version: 1 },
      input: {
        sourceId: ref('run.input.sourceId'),
        artifact: ref('nodes.download.output.artifact'),
        snapshotId: ref('nodes.download.output.snapshotId'),
      },
    },
    {
      id: 'companies',
      title: 'Resolve → observe → reconcile (bounded fan-out)',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: {
          capability: { type: 'market.process_register_row', version: 1 },
          input: {
            sourceId: ref('run.input.sourceId'),
            snapshotId: ref('nodes.download.output.snapshotId'),
            artifactId: ref('nodes.download.output.artifact.artifactId'),
            register: ref('nodes.parse.output.register'),
            row: ref('item'),
          },
        },
        concurrency: 4,
        batchSize: 200,
        maxFailureRatio: 0.2,
      },
      input: { items: ref('nodes.parse.output.records') },
    },
    {
      id: 'finalize',
      title: 'Finalize import (delisting guard)',
      capability: { type: 'market.finalize_dataset_import', version: 1 },
      input: {
        sourceId: ref('run.input.sourceId'),
        snapshotId: ref('nodes.download.output.snapshotId'),
        importStartedAt: ref('nodes.trigger.output.firedAt'),
        snapshotFetchedAt: ref('nodes.download.output.fetchedAt'),
        rowCount: ref('nodes.parse.output.count'),
        fanout: ref('nodes.companies.output'),
        periods: ref('nodes.parse.output.periods', null),
      },
    },
  ],
  edges: [
    { from: 'trigger', to: 'locate' },
    { from: 'locate', to: 'download' },
    { from: 'download', to: 'parse' },
    { from: 'parse', to: 'companies' },
    { from: 'companies', to: 'finalize' },
  ],
  labels: { domain: 'market', stream: 'companies' },
};

/** Reusable subworkflow: one company candidate through the granular domain capabilities. */
export const companyCandidateSubworkflow: WorkflowSpec = {
  key: 'market.company.process_candidate',
  title: 'Process company candidate',
  description: 'Create Company Observation → Resolve Company → Reconcile Company (review on ambiguity).',
  nodes: [
    manualTrigger,
    {
      id: 'observe',
      capability: { type: 'market.create_company_observation', version: 1 },
      input: {
        sourceId: ref('nodes.trigger.output.payload.sourceId'),
        externalId: ref('nodes.trigger.output.payload.externalId', null),
        locator: ref('nodes.trigger.output.payload.locator', null),
        payload: ref('nodes.trigger.output.payload.company'),
      },
    },
    {
      id: 'resolve',
      capability: { type: 'market.resolve_company', version: 1 },
      input: { observationId: ref('nodes.observe.output.observationId') },
    },
    {
      id: 'resolved',
      capability: { type: 'core.if', version: 1 },
      config: { conditions: [{ path: 'companyId', op: 'exists' }] },
      input: { value: ref('nodes.resolve.output') },
    },
    {
      id: 'reconcile',
      capability: { type: 'market.reconcile_company', version: 1 },
      input: { companyId: ref('nodes.resolve.output.companyId') },
    },
  ],
  edges: [
    { from: 'trigger', to: 'observe' },
    { from: 'observe', to: 'resolve' },
    { from: 'resolve', to: 'resolved' },
    { from: 'resolved', to: 'reconcile', when: { branch: 'true' } },
  ],
  outputNode: 'resolve',
  labels: { domain: 'market', stream: 'companies' },
};

/** WF2 — careers discovery for one company. */
export const companyCareersDiscovery: WorkflowSpec = {
  key: 'market.company.discover_careers',
  title: 'Discover careers & ATS for a company',
  description: 'Finds the careers page and ATS board from the official website and registers job sources.',
  nodes: [
    manualTrigger,
    {
      id: 'discover',
      capability: { type: 'market.discover_careers', version: 2 },
      input: { companyId: ref('nodes.trigger.output.payload.companyId') },
    },
    {
      id: 'register',
      title: 'Register detected ATS boards',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: {
          capability: { type: 'market.register_job_source', version: 2 },
          input: {
            companyId: ref('nodes.discover.output.companyId'),
            provider: ref('item.provider'),
            boardToken: ref('item.boardToken'),
            apiBase: ref('item.apiBase', null),
          },
        },
        concurrency: 2,
        batchSize: 10,
        collectOutputs: true,
      },
      input: { items: ref('nodes.discover.output.ats') },
    },
    {
      // Wave 6: no ATS board, but a careers page on the official site → a careers_page source.
      id: 'careers_page',
      title: 'Register the careers page when no ATS was found',
      capability: { type: 'market.register_careers_page_fallback', version: 1 },
      input: {
        companyId: ref('nodes.discover.output.companyId'),
        careersUrl: ref('nodes.discover.output.careersUrl', null),
        ats: ref('nodes.discover.output.ats', null),
      },
    },
  ],
  edges: [
    { from: 'trigger', to: 'discover' },
    { from: 'discover', to: 'register' },
    { from: 'discover', to: 'careers_page' },
  ],
  outputNode: 'discover',
  labels: { domain: 'market', stream: 'jobs' },
};

/** WF2 batch — careers discovery across companies that are due. */
export const careersDiscoveryBatch: WorkflowSpec = {
  key: 'market.careers_discovery.batch',
  title: 'Careers discovery (batch)',
  description:
    'Selects companies due for careers discovery and runs the per-company subworkflow with bounded concurrency.',
  nodes: [
    scheduleTrigger,
    {
      id: 'select',
      capability: { type: 'market.select_companies_for_discovery', version: 2 },
      input: {
        limit: ref('nodes.trigger.output.payload.limit', 25),
        sponsorCountry: ref('nodes.trigger.output.payload.sponsorCountry'),
        companyIds: ref('nodes.trigger.output.payload.companyIds'),
      },
    },
    {
      id: 'each',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: { workflow: { key: 'market.company.discover_careers' }, input: { companyId: ref('item') } },
        concurrency: 4,
        batchSize: 5,
      },
      input: { items: ref('nodes.select.output.companyIds') },
    },
  ],
  edges: [
    { from: 'trigger', to: 'select' },
    { from: 'select', to: 'each' },
  ],
  labels: { domain: 'market', stream: 'jobs' },
};

/** WF3 — ATS job refresh (Greenhouse / Ashby / Lever / third-party feed). */
export const atsRefresh: WorkflowSpec = {
  key: 'market.ats.refresh',
  title: 'Job board refresh',
  description:
    'Fetches a job board (conditionally), stores the snapshot, ingests job observations of a changed listing (an unchanged one has nothing to ingest and is only confirmed), dedupes to canonical jobs and applies safe lifecycle updates.',
  inputSchema: {
    type: 'object',
    required: ['sourceId'],
    properties: { sourceId: { type: 'string' }, snapshotId: { type: 'string' } },
  },
  nodes: [
    scheduleTrigger,
    {
      id: 'fetch',
      capability: { type: 'market.fetch_job_board', version: 3 },
      input: {
        sourceId: ref('nodes.trigger.output.payload.sourceId'),
        snapshotId: ref('nodes.trigger.output.payload.snapshotId', null),
        triggerKind: ref('nodes.trigger.output.triggerKind', null),
        scheduledFor: ref('nodes.trigger.output.scheduledFor', null),
      },
      retry: { ...FETCH_RETRY },
    },
    {
      // A small routing node: the fetch output can be moved to an artifact when large, and the
      // engine reads a branch only from a node's inline output. A deferred fetch ends the run.
      // Older fetch versions have no path and take the default branch.
      id: 'route',
      capability: { type: 'core.switch', version: 1 },
      config: {
        cases: [{ branch: 'deferred', conditions: [{ path: '', op: 'eq', value: 'deferred' }] }],
        defaultBranch: 'listing',
      },
      input: { value: ref('nodes.fetch.output.path', null) },
    },
    {
      id: 'ingest',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: {
          capability: { type: 'market.ingest_job_observation', version: 1 },
          input: {
            sourceId: ref('run.input.sourceId'),
            snapshotId: ref('nodes.fetch.output.snapshotId'),
            artifactId: ref('nodes.fetch.output.artifactId'),
            observedAt: ref('nodes.fetch.output.fetchedAt'),
            board: ref('nodes.fetch.output.board', null),
            item: ref('item'),
          },
        },
        concurrency: 4,
        batchSize: 25,
        maxFailureRatio: 0.5,
      },
      input: { items: ref('nodes.fetch.output.records') },
    },
    {
      id: 'finalize',
      capability: { type: 'market.finalize_job_listing', version: 3 },
      input: {
        sourceId: ref('run.input.sourceId'),
        snapshotId: ref('nodes.fetch.output.snapshotId'),
        records: ref('nodes.fetch.output.records'),
        skipped: ref('nodes.fetch.output.skipped'),
        complete: ref('nodes.fetch.output.complete'),
        fetchedAt: ref('nodes.fetch.output.fetchedAt'),
        board: ref('nodes.fetch.output.board', null),
        acquired: ref('nodes.fetch.output.acquired', null),
        fanout: ref('nodes.ingest.output'),
        path: ref('nodes.fetch.output.path'),
        present: ref('nodes.fetch.output.present', null),
        stamp: ref('nodes.fetch.output.stamp', null),
      },
    },
  ],
  edges: [
    { from: 'trigger', to: 'fetch' },
    { from: 'fetch', to: 'route' },
    { from: 'route', to: 'ingest', when: { branch: 'listing' } },
    { from: 'ingest', to: 'finalize' },
  ],
  labels: { domain: 'market', stream: 'jobs' },
};

/** WF4 — generic careers crawl (scoped) with deterministic JSON-LD extraction. */
export const careersPageCrawl: WorkflowSpec = {
  key: 'market.careers_page.crawl',
  title: 'Careers page crawl',
  description:
    'Bounded, host-scoped crawl of a careers page; extracts JobPosting data; ingests observations (never closes jobs by absence).',
  nodes: [
    scheduleTrigger,
    {
      id: 'crawl',
      capability: { type: 'core.browser_crawl', version: 1 },
      config: {
        maxPages: 25,
        maxDepth: 2,
        followPatterns: ['job', 'career', 'position', 'opening', 'vacanc', 'role'],
        matchPatterns: ['/job', '/jobs/', '/careers/', '/positions/', '/openings/', '/vacancies/'],
      },
      input: { startUrl: ref('nodes.trigger.output.payload.startUrl') },
    },
    {
      id: 'extract',
      capability: { type: 'market.extract_jobs_from_pages', version: 1 },
      input: {
        sourceId: ref('run.input.sourceId'),
        pages: ref('nodes.crawl.output.pages'),
        // The crawl's start (the run's trigger) and its start URL: its evidence time and board.
        startedAt: ref('nodes.trigger.output.firedAt', null),
        startUrl: ref('nodes.trigger.output.payload.startUrl', null),
      },
    },
    {
      id: 'ingest',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: {
          capability: { type: 'market.ingest_job_observation', version: 1 },
          input: {
            sourceId: ref('run.input.sourceId'),
            item: ref('item'),
            // Labelled once by the extract step: the crawl's time and board, not ingest time.
            observedAt: ref('nodes.extract.output.observedAt', null),
            board: ref('nodes.extract.output.board', null),
          },
        },
        concurrency: 2,
        batchSize: 10,
      },
      input: { items: ref('nodes.extract.output.records') },
    },
  ],
  edges: [
    { from: 'trigger', to: 'crawl' },
    { from: 'crawl', to: 'extract' },
    { from: 'extract', to: 'ingest' },
  ],
  labels: { domain: 'market', stream: 'jobs' },
};

/** WF6 — verify jobs that are due under the freshness policy. */
export const verifyDueJobs: WorkflowSpec = {
  key: 'market.jobs.verify_due',
  title: 'Verify due jobs',
  description:
    'Selects jobs due for verification and re-checks their authoritative source with bounded concurrency.',
  nodes: [
    scheduleTrigger,
    {
      id: 'select',
      capability: { type: 'market.select_jobs_due_verification', version: 1 },
      input: {
        limit: ref('nodes.trigger.output.payload.limit', 200),
        jobIds: ref('nodes.trigger.output.payload.jobIds'),
      },
    },
    {
      id: 'verify',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: { capability: { type: 'market.verify_job', version: 1 }, input: { jobId: ref('item') } },
        concurrency: 4,
        batchSize: 10,
      },
      input: { items: ref('nodes.select.output.jobIds') },
    },
  ],
  edges: [
    { from: 'trigger', to: 'select' },
    { from: 'select', to: 'verify' },
  ],
  labels: { domain: 'market', stream: 'jobs' },
  defaultSchedule: { intervalMinutes: 60, enabled: true, input: { limit: 200 } },
};

export const freshnessSweepWorkflow: WorkflowSpec = {
  key: 'market.freshness.sweep',
  title: 'Freshness sweep',
  description:
    'Marks unconfirmed jobs possibly stale (never closed), reports overdue sources, and re-derives every job named by newly recorded evidence.',
  nodes: [
    scheduleTrigger,
    { id: 'sweep', capability: { type: 'market.freshness_sweep', version: 1 }, input: {} },
    // Its own node and time budget (re-verify #12 LOW-4), independent of the sweep above.
    { id: 'evidence', capability: { type: 'market.sweep_recorded_evidence', version: 1 }, input: {} },
  ],
  edges: [
    { from: 'trigger', to: 'sweep' },
    { from: 'trigger', to: 'evidence' },
  ],
  labels: { domain: 'market' },
  defaultSchedule: { intervalMinutes: 60, enabled: true, input: {} },
};

/** OPS-3 release marks, then FE-4 byte purge (at most 500 artifacts; on by default). */
export const retentionSweepWorkflow: WorkflowSpec = {
  key: 'market.retention.sweep',
  title: 'Retention sweep',
  description:
    'Releases raw snapshots past their retention window that no open review, current observation, job or signal evidence, canonical fact, or latest-of-source read still needs, then deletes bytes of artifacts whose every snapshot is released and unpinned and that no other market record cites (at most 500 per run).',
  nodes: [
    scheduleTrigger,
    { id: 'sweep', capability: { type: 'market.retention_sweep', version: 1 }, input: {} },
    { id: 'purge', capability: { type: 'market.retention_purge', version: 1 }, input: { limit: 500 } },
  ],
  edges: [
    { from: 'trigger', to: 'sweep' },
    { from: 'sweep', to: 'purge' },
  ],
  labels: { domain: 'market' },
  defaultSchedule: { intervalMinutes: 24 * 60, enabled: true, input: {} },
};

/** OPS-4 — hourly lifecycle signal writer (vocabulary v1). */
export const lifecycleSignalsWorkflow: WorkflowSpec = {
  key: 'market.signals.lifecycle',
  title: 'Lifecycle signals',
  description: 'Records a market signal, with evidence, for each new job lifecycle transition.',
  nodes: [
    scheduleTrigger,
    { id: 'signals', capability: { type: 'market.write_lifecycle_signals', version: 1 }, input: {} },
  ],
  edges: [{ from: 'trigger', to: 'signals' }],
  labels: { domain: 'market' },
  defaultSchedule: { intervalMinutes: 60, enabled: true, input: {} },
};

/** OPS-4 — daily canonical-change signal writer (vocabulary v1). */
export const companyChangeSignalsWorkflow: WorkflowSpec = {
  key: 'market.signals.company_changes',
  title: 'Company change signals',
  description:
    'Records sponsorship, remote policy, role family, location and hiring acceleration signals from canonical changes.',
  nodes: [
    scheduleTrigger,
    { id: 'signals', capability: { type: 'market.write_company_change_signals', version: 1 }, input: {} },
  ],
  edges: [{ from: 'trigger', to: 'signals' }],
  labels: { domain: 'market' },
  defaultSchedule: { intervalMinutes: 24 * 60, enabled: true, input: {} },
};

/** WF5 — re-run interpretation/reconciliation for a job (e.g. after a logic version bump). */
export const jobReinterpret: WorkflowSpec = {
  key: 'market.job.reinterpret',
  title: 'Re-interpret job',
  description: 'Recomputes canonical job intelligence with the current logic/policy versions.',
  nodes: [
    manualTrigger,
    {
      id: 'reconcile',
      capability: { type: 'market.reconcile_job', version: 1 },
      input: { jobId: ref('nodes.trigger.output.payload.jobId') },
    },
  ],
  edges: [{ from: 'trigger', to: 'reconcile' }],
  labels: { domain: 'market', stream: 'jobs' },
};

/**
 * Manual AI requirements proposal for one job (live test of the AI gateway). The step only
 * stores a non-canonical proposal through `market.propose_job_requirements` (AI only proposes,
 * Law H); canonical requirements stay the deterministic extraction. Runs on the `ai` queue.
 */
export const jobProposeRequirements: WorkflowSpec = {
  key: 'market.job.propose_requirements',
  title: 'Propose job requirements (AI)',
  description:
    'Asks the configured AI provider for a schema-validated requirements proposal for one job (`jobId`), stored as a proposal on the job, never as canonical requirements.',
  inputSchema: {
    type: 'object',
    required: ['jobId'],
    properties: { jobId: { type: 'string', minLength: 1 } },
  },
  nodes: [
    manualTrigger,
    {
      id: 'propose',
      capability: { type: 'market.propose_job_requirements', version: 1 },
      input: { jobId: ref('nodes.trigger.output.payload.jobId') },
    },
  ],
  edges: [{ from: 'trigger', to: 'propose' }],
  outputNode: 'propose',
  labels: { domain: 'market', stream: 'jobs' },
};

/**
 * Re-interpretation backfill (DECISION_LOG 8d96663 (3); run by the deploy runbook after a
 * logic/policy bump): one keyset page of jobs whose employment policy version is older than the
 * current one — any lifecycle state (CLOSED, POSSIBLY_STALE) and source (disabled included) —
 * each re-reconciled by `market.reconcile_job`, the `market.job.reinterpret` code (operator
 * overrides applied as always). Replay-safe: re-interpreted jobs drop out of the selection, a
 * retried chunk resumes; re-run (optionally with `after` = the report's `nextAfter`) until the
 * report says `done`.
 */
export const jobsReinterpretOutdated: WorkflowSpec = {
  key: 'market.jobs.reinterpret_outdated',
  title: 'Re-interpret outdated jobs',
  description:
    'Backfill: re-reconciles every job whose employment interpretation is older than the current policy version (one page per run).',
  nodes: [
    manualTrigger,
    {
      id: 'select',
      capability: { type: 'market.select_outdated_job_interpretations', version: 1 },
      input: {
        after: ref('nodes.trigger.output.payload.after', ''),
        limit: ref('nodes.trigger.output.payload.limit', 1000),
      },
    },
    {
      id: 'reinterpret',
      capability: { type: 'core.for_each', version: 1 },
      config: {
        body: {
          capability: { type: 'market.reconcile_job', version: 1 },
          // Each re-interpreted job records this run (its run history shows it: M6.2 MR2).
          config: { recordRunChange: true },
          input: { jobId: ref('item') },
        },
        concurrency: 4,
        batchSize: 20,
      },
      input: { items: ref('nodes.select.output.jobIds') },
    },
    {
      id: 'report',
      capability: { type: 'market.report_reinterpret_backfill', version: 1 },
      input: {
        policyVersion: ref('nodes.select.output.policyVersion'),
        selected: ref('nodes.reinterpret.output.total'),
        succeeded: ref('nodes.reinterpret.output.succeeded'),
        failed: ref('nodes.reinterpret.output.failed'),
        nextAfter: ref('nodes.select.output.nextAfter'),
      },
    },
  ],
  edges: [
    { from: 'trigger', to: 'select' },
    { from: 'select', to: 'reinterpret' },
    { from: 'reinterpret', to: 'report' },
  ],
  outputNode: 'report',
  labels: { domain: 'market', stream: 'jobs' },
};

/** Re-derive a source's jobs after its standing changed (DECISION_LOG 15c965b). */
export const sourceRecomputeJobs: WorkflowSpec = {
  key: 'market.source.recompute_jobs',
  title: 'Recompute source jobs',
  description: 'Re-derives the lifecycle of every job with a copy on a source after its standing changed.',
  nodes: [
    manualTrigger,
    {
      id: 'recompute',
      capability: { type: 'market.recompute_source_jobs', version: 1 },
      input: { sourceId: ref('nodes.trigger.output.payload.sourceId') },
    },
  ],
  edges: [{ from: 'trigger', to: 'recompute' }],
  labels: { domain: 'market', stream: 'jobs' },
};

/** Placeholder acquisition workflow for system sources that are never fetched. */
export const noopWorkflow: WorkflowSpec = {
  key: 'market.noop',
  title: 'No-op',
  description: 'Acquisition workflow for internal sources (operator decisions) that are never fetched.',
  nodes: [manualTrigger],
  edges: [],
  labels: { domain: 'market' },
};

export const marketWorkflows: WorkflowSpec[] = [
  ukSponsorImport,
  companyDirectoryImport,
  atsBoardsImport,
  sponsorRegisterImport,
  companyCandidateSubworkflow,
  companyCareersDiscovery,
  careersDiscoveryBatch,
  atsRefresh,
  careersPageCrawl,
  verifyDueJobs,
  freshnessSweepWorkflow,
  retentionSweepWorkflow,
  lifecycleSignalsWorkflow,
  companyChangeSignalsWorkflow,
  jobReinterpret,
  jobProposeRequirements,
  jobsReinterpretOutdated,
  sourceRecomputeJobs,
  noopWorkflow,
];
