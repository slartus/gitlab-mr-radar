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
  update: 'update',
  userState: 'userState',
};

export const notificationTargetKey = (notificationId) => `notificationTarget:${notificationId}`;

export const NOTIFICATIONS_PERMISSION = 'notifications';

export const hasNotificationsPermission = () =>
  chrome.permissions.contains({ permissions: [NOTIFICATIONS_PERMISSION] });

export const UPDATE_REPOSITORY = 'slartus/gitlab-mr-radar';
export const UPDATE_CHECK_ORIGIN = 'https://api.github.com/*';
export const UPDATE_CHECK_INTERVAL_MINUTES = 24 * 60;

export function compareVersions(left, right) {
  const parse = (version) => version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

export function parseCheckNames(text) {
  return [...new Set(text.split(/[\n,]/).map((name) => name.trim()).filter(Boolean))];
}

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
