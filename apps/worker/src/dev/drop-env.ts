import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPlatform, s3ClientConfig } from '@aptamind/platform';

/**
 * Dev/test only: deletes everything the current environment points at — the MongoDB database
 * (MONGODB_DB), every Redis key under QUEUE_PREFIX and the S3 bucket (S3_BUCKET) — so throwaway
 * stacks (e.g. the admin e2e smoke) leave nothing behind. Same env/config as migrate and seed.
 *
 *   tsx apps/worker/src/dev/drop-env.ts --confirm=<MONGODB_DB>
 *
 * Refuses production, any non-throwaway name (db, queue prefix and bucket must start with t_ or t-)
 * and a missing/mismatched --confirm.
 */
const platform = await createPlatform('script');
const { config, logger } = platform;
const dbName = config.mongo.dbName;
const confirm = process.argv.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length);

const refusal =
  config.env === 'production'
    ? 'refusing to run in production'
    : confirm !== dbName
      ? `--confirm must equal MONGODB_DB (${dbName})`
      : ![dbName, config.redis.queuePrefix, config.s3.bucket].every((n) => /^t[_-]/.test(n))
        ? 'refusing: MONGODB_DB, QUEUE_PREFIX and S3_BUCKET must all be throwaway names (t_ or t- prefix)'
        : null;
if (refusal) {
  logger.error({ dbName }, refusal);
  await platform.close();
  process.exit(2);
}

const failures: string[] = [];
const step = async (what: string, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (err) {
    failures.push(`${what}: ${(err as Error).message}`);
  }
};

await step('mongo', async () => {
  await platform.mongo.db.dropDatabase();
});

await step('redis', async () => {
  const redis = platform.transport.redis;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${config.redis.queuePrefix}:*`, 'COUNT', 500);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
});

await step('s3', async () => {
  const s3 = new S3Client(s3ClientConfig(config.s3));
  const Bucket = config.s3.bucket;
  let token: string | undefined;
  try {
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken: token }));
      const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects } }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    await s3.send(new DeleteBucketCommand({ Bucket }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'NoSuchBucket') throw err;
  } finally {
    s3.destroy();
  }
});

await platform.close();
if (failures.length) {
  logger.error({ dbName, failures }, 'environment only partly removed');
  process.exit(1);
}
logger.info(
  { dbName, queuePrefix: config.redis.queuePrefix, bucket: config.s3.bucket },
  'environment removed',
);
