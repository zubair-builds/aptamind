/**
 * Test support for Market integration tests (`@aptamind/market/testing`). Importing this module
 * installs the egress guard (PR #11 re-verify #7 LOW-3) as a side effect, so a test file that
 * imports it FIRST has the guard in place before any other module it imports is evaluated.
 * Every Market integration test imports it — directly, or through `test-harness.ts` /
 * `apps/admin/lib/api-server/market-test-harness.ts` — and asserts `assertNoEgress()` when it ends.
 */
import { installEgressGuard } from './test-egress-guard';

installEgressGuard();

export {
  assertNoEgress,
  clearEgressAttempts,
  egressAttempts,
  egressGuardInstalled,
  installEgressGuard,
  isLoopbackHost,
} from './test-egress-guard';

export { installOfflineHttp, offlineHttp } from './test-offline-http';
