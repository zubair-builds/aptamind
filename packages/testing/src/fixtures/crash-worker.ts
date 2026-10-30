/**
 * Child-process worker used by the crash-recovery integration test. The parent SIGKILLs
 * this process while a node is running to prove another worker takes over from MongoDB state.
 */
import { connectMongo } from '@aptamind/db';
import { createLogger } from '@aptamind/observability';
import { QueueTransport } from '@aptamind/queue';
import { ArtifactStore, S3ObjectStorage } from '@aptamind/storage';
import { genericCapabilities } from '@aptamind/workflow-nodes';
import { createWorkflowRuntime } from '@aptamind/workflows';
import { TEST_DB, testCapabilities, testWorkflows } from './test-capabilities';

const env = process.env;
const mongo = await connectMongo({ uri: env.MONGODB_URI as string, dbName: env.TEST_DB_NAME as string });
const transport = new QueueTransport({
  url: env.REDIS_URL as string,
  prefix: env.TEST_QUEUE_PREFIX as string,
});
const storage = new S3ObjectStorage({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION ?? 'us-east-1',
  bucket: 'aptamind-test',
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: true,
});
const logger = createLogger({ service: 'crash-worker', level: 'warn' });
const runtime = createWorkflowRuntime({
  db: mongo.db,
  transport,
  artifacts: new ArtifactStore(mongo.db, storage),
  logger,
  capabilities: [...genericCapabilities, ...testCapabilities],
  leaseMs: Number(env.TEST_LEASE_MS ?? 1500),
});
runtime.services.register(TEST_DB, mongo.db);
await runtime.registerWorkflows(testWorkflows);
runtime
  .createWorkerHost({ workerId: 'crash-worker', schedulerEnabled: false, sweeperIntervalMs: 60_000 })
  .start();
process.send?.('ready');
