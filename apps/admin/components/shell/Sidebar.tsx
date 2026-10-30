import { Suspense, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { ThemePreference } from '@/lib/preferences';
import { NavItem } from './NavItem';
import { SidebarToggle } from './Shell';
import s from './Shell.module.css';
import { HealthDot, ReviewCount } from './status';
import { ThemeSwitch } from './ThemeSwitch';

function Group({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className={s.group}>
      <span id={id} className={s.groupLabel}>
        {label}
      </span>
      <ul className={s.navList} aria-labelledby={id}>
        {children}
      </ul>
    </div>
  );
}

const count = (node: ReactNode) => <Suspense fallback={null}>{node}</Suspense>;

export function Sidebar({ theme }: { theme: ThemePreference }) {
  return (
    <>
      <div className={s.workspace}>
        <span className={s.logo} aria-hidden="true">
          A
        </span>
        <span className={s.workspaceName}>
          Aptamind <span className={s.workspaceSub}>Market</span>
        </span>
        <SidebarToggle />
      </div>
      <nav aria-label="Main" className={s.nav}>
        <ul className={s.navList}>
          <NavItem href="/" label="Home" icon={<Icon name="house" />} />
          <NavItem
            href="/review"
            label="Review"
            icon={<Icon name="inbox" />}
            trailing={count(<ReviewCount />)}
          />
        </ul>
        <Group id="nav-records" label="Records">
          <NavItem href="/companies" label="Companies" icon={<Icon name="building" />} />
          <NavItem href="/jobs" label="Jobs" icon={<Icon name="briefcase" />} />
          <NavItem href="/sources" label="Sources" icon={<Icon name="database" />} also={['/snapshots']} />
          <NavItem href="/imports" label="Imports" icon={<Icon name="upload" />} />
        </Group>
        <Group id="nav-automations" label="Automations">
          <NavItem href="/workflows" label="Workflows" icon={<Icon name="workflow" />} />
          <NavItem href="/runs" label="Runs" icon={<Icon name="play" />} also={['/node-runs']} />
        </Group>
        <div className={s.navFooter}>
          <Group id="nav-settings" label="Settings">
            <NavItem href="/capabilities" label="Capabilities" icon={<Icon name="puzzle" />} />
            <NavItem
              href="/settings/system"
              label="System status"
              icon={<Icon name="activity" />}
              trailing={count(<HealthDot />)}
            />
          </Group>
        </div>
      </nav>
      <ThemeSwitch initial={theme} />
    </>
  );
}
