// Integration tests run against real MongoDB (replica set), Redis and S3-compatible storage.
// Boot them with `pnpm infra:up` (Docker) or `pnpm infra:local` (native binaries) first.
process.env.NODE_ENV ??= 'test';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
// Storage is hard-set, not defaulted: a shell that exported the MVP R2 settings must never send
// tests to R2. Override only through TEST_S3_* variables.
process.env.S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
process.env.S3_REGION = process.env.TEST_S3_REGION ?? 'us-east-1';
process.env.S3_ACCESS_KEY_ID = process.env.TEST_S3_ACCESS_KEY_ID ?? 'aptamind';
process.env.S3_SECRET_ACCESS_KEY = process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'aptamind-dev-secret';
process.env.S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'aptamind-artifacts';
process.env.S3_FORCE_PATH_STYLE = 'true';
delete process.env.S3_USE_AWS_DEFAULT_ENDPOINT;
process.env.NET_ALLOW_PRIVATE_NETWORK ??= 'true';
process.env.LOG_LEVEL ??= 'warn';
