import { useCallback, useState } from 'react'

/**
 * Theme preference — persisted per-browser in localStorage and applied as the
 * `data-theme` attribute on <html>. The CSS resolves three states:
 *   - "system"  → follow the OS color scheme (no forced attribute semantics);
 *   - "light"   → the daylight paper-panel token set;
 *   - "dark"    → the night-shift blue-black token set.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

const STORAGE_KEY = 'skillbox-theme'

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  } catch {
    // localStorage unavailable (private mode) — fall through to system.
  }
  return 'system'
}

export function applyThemePreference(preference: ThemePreference): void {
  document.documentElement.dataset.theme = preference
}

export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference)

  const set = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Persistence is best-effort; the in-memory choice still applies.
    }
    applyThemePreference(next)
    setPreference(next)
  }, [])

  return [preference, set]
}
