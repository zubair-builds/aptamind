import type { Db } from 'mongodb';
import { type Clock, contentHash, NotFoundError, systemClock } from '@aptamind/contracts';
import { getCollection, isDuplicateKeyError } from '@aptamind/db';
import { type WorkflowSpec, workflowSpecSchema } from '@aptamind/workflow-sdk';
import { type CapabilityRegistry, validateWorkflowSpec } from './registry';
import {
  type ResolvedNode,
  schedulesCollection,
  WORKFLOW_SCHEMA_VERSION,
  workflowDefinitionsCollection,
  type WorkflowVersionDoc,
  workflowVersionsCollection,
} from './schemas';

export const DEFAULT_NODE_TIMEOUT_MS = 5 * 60_000;

/**
 * Workflow definitions and immutable versions.
 *
 * `register(spec)` is idempotent: an unchanged spec returns the existing version, a changed
 * spec creates version N+1. Historical runs keep pointing at the exact version they ran.
 */
export class WorkflowCatalog {
  private readonly versionCache = new Map<string, WorkflowVersionDoc>();

  constructor(
    private readonly db: Db,
    private readonly registry: CapabilityRegistry,
    private readonly clock: Clock = systemClock,
  ) {}

  private get versions() {
    return getCollection(this.db, workflowVersionsCollection);
  }
  private get definitions() {
    return getCollection(this.db, workflowDefinitionsCollection);
  }

  resolveNodes(spec: ReturnType<typeof workflowSpecSchema.parse>): ResolvedNode[] {
    return spec.nodes.map((n) => {
      const def = this.registry.get(n.capability);
      const defaultAttempts = def.execution.retryable ? 3 : 1;
      return {
        ...n,
        config: n.config ?? {},
        retry: {
          maxAttempts: n.retry?.maxAttempts ?? defaultAttempts,
          backoffMs: n.retry?.backoffMs ?? 2_000,
          maxBackoffMs: n.retry?.maxBackoffMs ?? 5 * 60_000,
        },
        timeoutMs: n.timeoutMs ?? def.execution.defaultTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,
        queue: def.execution.queue ?? 'default',
      };
    });
  }

  async register(input: WorkflowSpec): Promise<{ version: WorkflowVersionDoc; created: boolean }> {
    const spec = workflowSpecSchema.parse(input);
    validateWorkflowSpec(spec, this.registry);
    const nodes = this.resolveNodes(spec);
    const hash = contentHash({
      title: spec.title,
      description: spec.description,
      nodes,
      edges: spec.edges,
      inputSchema: spec.inputSchema,
      outputNode: spec.outputNode,
      labels: spec.labels,
    });

    for (let attempt = 0; attempt < 5; attempt++) {
      const latest = await this.versions
        .find({ workflowKey: spec.key })
        .sort({ version: -1 })
        .limit(1)
        .next();
      if (latest && latest.contentHash === hash) {
        await this.ensureDefaultSchedule(spec);
        return { version: latest, created: false };
      }
      const now = this.clock.now();
      const version = (latest?.version ?? 0) + 1;
      const doc: WorkflowVersionDoc = {
        _id: `${spec.key}@${version}`,
        workflowKey: spec.key,
        version,
        title: spec.title,
        description: spec.description,
        nodes,
        edges: spec.edges,
        inputSchema: spec.inputSchema,
        outputNode: spec.outputNode,
        labels: spec.labels,
        contentHash: hash,
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.versions.insertOne(doc);
      } catch (err) {
        if (isDuplicateKeyError(err)) continue; // concurrent registration; re-evaluate
        throw err;
      }
      await this.definitions.updateOne(
        { _id: spec.key },
        {
          $set: { title: spec.title, description: spec.description, labels: spec.labels, updatedAt: now },
          $max: { latestVersion: version },
          $setOnInsert: { archived: false, schemaVersion: WORKFLOW_SCHEMA_VERSION, createdAt: now },
        },
        { upsert: true },
      );
      await this.ensureDefaultSchedule(spec);
      return { version: doc, created: true };
    }
    throw new Error(`Could not register workflow ${spec.key} after concurrent retries`);
  }

  private async ensureDefaultSchedule(spec: ReturnType<typeof workflowSpecSchema.parse>): Promise<void> {
    const s = spec.defaultSchedule;
    if (!s) return;
    const now = this.clock.now();
    await getCollection(this.db, schedulesCollection).updateOne(
      { 'owner.kind': 'workflow', 'owner.id': spec.key },
      {
        $setOnInsert: {
          _id: `sch_wf_${spec.key}`,
          workflowKey: spec.key,
          cron: s.cron,
          intervalMinutes: s.intervalMinutes,
          timezone: s.timezone,
          input: s.input,
          labels: {},
          enabled: s.enabled,
          owner: { kind: 'workflow', id: spec.key },
          fireCount: 0,
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }

  async getVersion(workflowKey: string, version?: number): Promise<WorkflowVersionDoc> {
    if (version !== undefined) return this.getVersionById(`${workflowKey}@${version}`);
    const latest = await this.versions.find({ workflowKey }).sort({ version: -1 }).limit(1).next();
    if (!latest) throw new NotFoundError('Workflow', workflowKey);
    this.versionCache.set(latest._id, latest);
    return latest;
  }

  async getVersionById(versionId: string): Promise<WorkflowVersionDoc> {
    const cached = this.versionCache.get(versionId);
    if (cached) return cached;
    const doc = await this.versions.findOne({ _id: versionId });
    if (!doc) throw new NotFoundError('WorkflowVersion', versionId);
    // Versions are immutable, so caching is always safe.
    this.versionCache.set(versionId, doc);
    return doc;
  }

  async listDefinitions() {
    return this.definitions
      .find({ archived: { $ne: true } })
      .sort({ _id: 1 })
      .toArray();
  }

  async listVersions(workflowKey: string) {
    return this.versions.find({ workflowKey }).sort({ version: -1 }).toArray();
  }
}
