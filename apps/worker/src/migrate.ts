import { createPlatform } from '@aptamind/platform';

/** Apply migrations, create indexes, register workflows and system sources. Idempotent. */
const platform = await createPlatform('script');
await platform.init();
platform.logger.info('migrations and registrations complete');
await platform.close();
