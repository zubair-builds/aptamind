'use client';

import { useState } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import { THEME_COOKIE, type ThemePreference, writePreference } from '@/lib/preferences';
import s from './Shell.module.css';

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: IconName }> = [
  { value: 'system', label: 'System theme', icon: 'monitor' },
  { value: 'light', label: 'Light theme', icon: 'sun' },
  { value: 'dark', label: 'Dark theme', icon: 'moon' },
];

/**
 * System / light / dark. The choice lives in a cookie that the root layout renders as
 * `<html data-theme>`, so reloads paint the right theme with no flash; "system" leaves the
 * attribute off and the CSS follows `prefers-color-scheme`.
 */
export function ThemeSwitch({ initial }: { initial: ThemePreference }) {
  const [theme, setTheme] = useState(initial);
  const choose = (value: ThemePreference) => {
    setTheme(value);
    writePreference(THEME_COOKIE, value);
    if (value === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  };
  return (
    <fieldset className={s.theme}>
      <legend className="sr-only">Theme</legend>
      {OPTIONS.map((o) => (
        <label key={o.value} className={s.themeOption} title={o.label}>
          <input
            type="radio"
            name="aptamind-theme"
            value={o.value}
            checked={theme === o.value}
            onChange={() => choose(o.value)}
          />
          <Icon name={o.icon} />
          <span className="sr-only">{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
