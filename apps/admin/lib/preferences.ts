/** Per-browser UI preferences stored in cookies (read server-side so the first paint is right). */

export const THEME_COOKIE = 'aptamind-theme';
export const SIDEBAR_COOKIE = 'aptamind-sidebar';

export type ThemePreference = 'system' | 'light' | 'dark';

export function parseTheme(value: string | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** Client-side cookie write (one year, whole admin). */
export function writePreference(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
