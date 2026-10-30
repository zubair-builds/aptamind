import { MongoClient, type ClientSession, type Db, type MongoClientOptions } from 'mongodb';

export interface MongoHandle {
  client: MongoClient;
  db: Db;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface ConnectMongoOptions {
  uri: string;
  dbName: string;
  appName?: string;
  clientOptions?: MongoClientOptions;
}

export async function connectMongo(opts: ConnectMongoOptions): Promise<MongoHandle> {
  const client = new MongoClient(opts.uri, {
    appName: opts.appName ?? 'aptamind',
    // Majority writes: canonical state must survive a primary failover.
    writeConcern: { w: 'majority' },
    readConcern: { level: 'majority' },
    retryWrites: true,
    // `undefined` means "absent", never `null`, in persisted documents.
    ignoreUndefined: true,
    serverSelectionTimeoutMS: 10_000,
    ...opts.clientOptions,
  });
  await client.connect();
  const db = client.db(opts.dbName);
  return {
    client,
    db,
    async ping() {
      try {
        await db.command({ ping: 1 });
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * Run `fn` inside a MongoDB transaction (requires a replica set, which the local
 * development stack provides). The callback may be retried by the driver on transient
 * transaction errors, so it must be idempotent with respect to non-database effects.
 */
export async function withTransaction<T>(
  client: MongoClient,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = client.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}

export function isDuplicateKeyError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 11000;
}
