// First import: the global stylesheet declares the cascade layer order before any CSS Module.
import '@/styles/index.css';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Suspense, type ReactNode } from 'react';
import { Shell } from '@/components/shell/Shell';
import { Sidebar } from '@/components/shell/Sidebar';
import { AuthChip, HealthNotice } from '@/components/shell/status';
import { ToastProvider } from '@/components/ui/Toast';
import { parseTheme, SIDEBAR_COOKIE, THEME_COOKIE } from '@/lib/preferences';

// Every page reads live operational data from the API: never prerender or cache.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'Aptamind Market Admin', template: '%s · Aptamind Market Admin' },
  description: 'Internal operations tool for Aptamind Market Intelligence.',
  robots: { index: false, follow: false },
};

/** `actions` is the parallel-route slot (app/@actions) rendered in the top bar. */
export default async function RootLayout({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  const jar = await cookies();
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);
  return (
    // "system" leaves data-theme off so CSS follows prefers-color-scheme without a script.
    <html lang="en" data-theme={theme === 'system' ? undefined : theme} suppressHydrationWarning>
      <body>
        <ToastProvider>
          <Shell
            initialCollapsed={jar.get(SIDEBAR_COOKIE)?.value === 'collapsed'}
            sidebar={<Sidebar theme={theme} />}
            actions={actions}
            chip={<AuthChip />}
            notice={
              <Suspense fallback={null}>
                <HealthNotice />
              </Suspense>
            }
          >
            {children}
          </Shell>
        </ToastProvider>
      </body>
    </html>
  );
}
