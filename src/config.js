export const DEFAULT_BASE_URL = 'https://gitlab.com';
export const DEFAULT_INTERVAL_MINUTES = 5;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 120;

export const PROJECT_FILTER_MODES = {
  all: 'all',
  selected: 'selected',
};

export const STORAGE_KEYS = {
  settings: 'settings',
  dashboard: 'dashboard',
};

export function normalizeBaseUrl(input) {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:') {
    throw new Error('Поддерживается только https');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export const hostPermissionPattern = (baseUrl) => `${new URL(baseUrl).origin}/*`;

export const hasHostPermission = (baseUrl) =>
  chrome.permissions.contains({ origins: [hostPermissionPattern(baseUrl)] });

export const requestHostPermission = (baseUrl) =>
  chrome.permissions.request({ origins: [hostPermissionPattern(baseUrl)] });
