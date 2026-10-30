import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from 'mongodb';
import { loadConfig } from '@aptamind/config';
import { connectMongo, type MongoHandle } from '@aptamind/db';
import { createLogger, type Logger } from '@aptamind/observability';
import { QueueTransport } from '@aptamind/queue';
import { ArtifactStore, S3ObjectStorage } from '@aptamind/storage';
import { ensureWorkflowCollections, type WorkflowRunDoc, type WorkflowEngine } from '@aptamind/workflows';

/**
 * Integration-test infrastructure: a fresh MongoDB database, a unique queue prefix and the
 * shared S3 bucket, all against the real local services (`pnpm infra:up` / `infra:local`).
 */
export interface TestInfra {
  name: string;
  mongo: MongoHandle;
  db: Db;
  transport: QueueTransport;
  storage: S3ObjectStorage;
  artifacts: ArtifactStore;
  logger: Logger;
  redisUrl: string;
  mongoUri: string;
  dbName: string;
  queuePrefix: string;
  cleanup(): Promise<void>;
}

export async function createTestInfra(label: string): Promise<TestInfra> {
  const cfg = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const name = `${label.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}_${randomBytes(4).toString('hex')}`;
  const dbName = `t_${name}`;
  const mongo = await connectMongo({ uri: cfg.mongo.uri, dbName, appName: `test-${label}` });
  await ensureWorkflowCollections(mongo.db);
  const queuePrefix = `t-${name}`;
  const transport = new QueueTransport({ url: cfg.redis.url, prefix: queuePrefix });
  const storage = new S3ObjectStorage({ ...cfg.s3, bucket: 'aptamind-test' });
  await storage.ensureReady();
  const artifacts = new ArtifactStore(mongo.db, storage);
  const logger = createLogger({ service: `test-${label}`, level: process.env.LOG_LEVEL ?? 'warn' });
  return {
    name,
    mongo,
    db: mongo.db,
    transport,
    storage,
    artifacts,
    logger,
    redisUrl: cfg.redis.url,
    mongoUri: cfg.mongo.uri,
    dbName,
    queuePrefix,
    async cleanup() {
      await transport.close();
      if (!process.env.KEEP_TEST_DB) await mongo.db.dropDatabase().catch(() => {});
      await mongo.close();
    },
  };
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 50));
  }
  throw new Error(`Timed out waiting: ${opts.message ?? ''} ${last ? String(last) : ''}`);
}

export async function waitForRun(
  engine: WorkflowEngine,
  runId: string,
  states: WorkflowRunDoc['state'][] = ['COMPLETED', 'FAILED', 'CANCELLED'],
  timeoutMs = 30_000,
): Promise<WorkflowRunDoc> {
  return waitFor(
    async () => {
      const r = await engine.runs.findOne({ _id: runId });
      return r && states.includes(r.state) ? r : null;
    },
    { timeoutMs, message: `run ${runId} to reach ${states.join('/')}` },
  );
}

/** Minimal local HTTP server for acquisition tests (requires NET_ALLOW_PRIVATE_NETWORK=true). */
export async function startFixtureServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close(): Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export * from './runtime-harness';
export * from './fixtures/test-capabilities';
