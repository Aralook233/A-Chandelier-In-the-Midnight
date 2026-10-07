export type ThemeName = 'light' | 'dark';

const storageKey = 'chandelier-theme';
const themeEvent = 'chandelier:themechange';

function systemTheme(): ThemeName {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function storedTheme(): ThemeName | null {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

function syncControls(theme: ThemeName): void {
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((button) => {
    button.setAttribute('aria-pressed', String(theme === 'dark'));
    button.textContent = theme === 'dark' ? '浅色' : '深色';
    button.setAttribute('title', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
  });
}

function publish(theme: ThemeName): void {
  window.dispatchEvent(new CustomEvent(themeEvent, { detail: { theme } }));
}

export function currentTheme(): ThemeName {
  const declared = document.documentElement.dataset.theme;
  return declared === 'dark' || declared === 'light' ? declared : systemTheme();
}

function applyTheme(theme: ThemeName): ThemeName {
  document.documentElement.dataset.theme = theme;
  syncControls(theme);
  publish(theme);
  return theme;
}

/**
 * Used while the reader has expressed no preference: the attribute stays off
 * the element so each page's `prefers-color-scheme` block decides the theme at
 * first paint, before this module is even evaluated.
 */
function followSystem(theme: ThemeName): ThemeName {
  document.documentElement.removeAttribute('data-theme');
  syncControls(theme);
  publish(theme);
  return theme;
}

export function initTheme(): ThemeName {
  const stored = storedTheme();
  if (stored) return applyTheme(stored);

  const resolved = systemTheme();
  followSystem(resolved);

  if (window.matchMedia) {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', (event) => {
      if (!storedTheme()) followSystem(event.matches ? 'dark' : 'light');
    });
  }

  return resolved;
}

export function toggleTheme(): ThemeName {
  const next: ThemeName = currentTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    // Private browsing or restricted storage: the theme still applies for this visit.
  }
  return applyTheme(next);
}

export function onThemeChange(handler: (theme: ThemeName) => void): void {
  window.addEventListener(themeEvent, (event) => {
    const detail = (event as CustomEvent<{ theme: ThemeName }>).detail;
    if (detail && (detail.theme === 'dark' || detail.theme === 'light')) handler(detail.theme);
  });
}
