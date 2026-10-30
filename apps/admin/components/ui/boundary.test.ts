import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function restrictedImports(code: string, file: string) {
  const [result] = await eslint.lintText(code, { filePath: `${root}${file}` });
  return result!.messages.filter((m) => m.ruleId === 'no-restricted-imports').length;
}

// The ESLint boundary that keeps design-system primitives domain-free (UX0c).
describe('components/ui import boundary', () => {
  const primitive = 'apps/admin/components/ui/Example.tsx';

  it.each([
    "import { apiGet } from '@/lib/api';",
    "import type { Job } from '@/lib/types';",
    "import { runSource } from '@/lib/actions';",
    "import { apiGet } from '../../lib/api';",
    "import { FactView } from '@/components/FactView';",
    "import { FactView } from '../FactView';",
    "import { apiGet } from '../../lib/api.ts';",
    "import { fmtRelative } from '../../lib/format';",
    "import { getApiHealth } from '@/lib/health';",
    "import { toneFor } from '@/lib/tones';",
    "import { Page } from '@/app/page';",
    "import { RecordTable } from '@/components/records/RecordTable';",
    // Assembled so scripts/check-architecture.ts does not read the fixture as a real import.
    `import type { ActorRef } from '${'@aptamind'}/contracts';`,
  ])('rejects %s', async (line) => {
    expect(await restrictedImports(`${line}\nexport const x = 1;\n`, primitive)).toBe(1);
  });

  it('allows primitives, pure helpers and React', async () => {
    const code = [
      "import type { ReactNode } from 'react';",
      "import { fmtRelative } from '@/lib/format';",
      "import { Icon } from '@/components/ui/Icon';",
      "import { Kbd } from './Kbd';",
      'export const x = [fmtRelative, Icon] as unknown as ReactNode;',
      '',
    ].join('\n');
    expect(await restrictedImports(code, primitive)).toBe(0);
  });

  it('does not restrict record/page code outside components/ui', async () => {
    const code = "import { apiGet } from '@/lib/api';\nexport const x = apiGet;\n";
    expect(await restrictedImports(code, 'apps/admin/components/Other.tsx')).toBe(0);
  });
});
