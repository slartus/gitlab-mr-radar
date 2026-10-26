import {
  DEFAULT_BASE_URL,
  DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  PROJECT_FILTER_MODES,
  STORAGE_KEYS,
  UPDATE_CHECK_INTERVAL_MINUTES,
  UPDATE_CHECK_ORIGIN,
  UPDATE_REPOSITORY,
  compareVersions,
  hasHostPermission,
} from './config.js';
import { collectDashboard } from './dashboard.js';
import { GitLabClient } from './gitlab.js';
import { deriveView } from './view.js';

const ALARM_NAME = 'refresh';
const UPDATE_ALARM_NAME = 'update-check';
const BADGE_COLOR_OK = '#1f75cb';
const BADGE_COLOR_ERROR = '#dd2b0e';
const BADGE_TITLE = 'GitLab MR Radar';

let inFlightRefresh = null;

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return {
    baseUrl: DEFAULT_BASE_URL,
    token: '',
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    projectFilterMode: PROJECT_FILTER_MODES.all,
    selectedProjectIds: [],
    ignoredCheckNames: [],
    checkUpdates: false,
    ...stored[STORAGE_KEYS.settings],
  };
}

async function setBadge(text, color, title = BADGE_TITLE) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title });
}

async function showCounts({ waiting, failedCi }) {
  const text = [waiting, failedCi]
    .filter((count) => count > 0)
    .join('·');
  const title = `${BADGE_TITLE}\nЖдут действия: ${waiting}\nУпал CI: ${failedCi}`;
  await setBadge(text, failedCi > 0 ? BADGE_COLOR_ERROR : BADGE_COLOR_OK, title);
}

function describeError(error) {
  if (error.status === 401) {
    return 'Токен невалиден или истёк — обновите его в настройках';
  }
  if (error.status === 403 && error.path === '/user') {
    return 'Недостаточно прав у токена — нужен scope read_api';
  }
  if (error.status === 429) {
    return 'GitLab ограничил частоту запросов — увеличьте интервал обновления';
  }
  if (error.status >= 500) {
    return 'GitLab временно недоступен — показаны данные последнего успешного обновления';
  }
  if (error instanceof TypeError || error.name === 'TimeoutError') {
    return 'GitLab недоступен — проверьте сеть или VPN';
  }
  return error.message;
}

async function performRefresh() {
  const { baseUrl, token, projectFilterMode, selectedProjectIds, ignoredCheckNames } = await loadSettings();
  const setupError = !token
    ? 'Укажите токен в настройках'
    : !(await hasHostPermission(baseUrl))
      ? `Нет доступа к ${baseUrl} — сохраните настройки и разрешите доступ`
      : null;
  if (setupError) {
    await chrome.storage.local.set({ [STORAGE_KEYS.dashboard]: { error: setupError } });
    await setBadge('?', BADGE_COLOR_ERROR);
    return;
  }
  const previous = (await chrome.storage.local.get(STORAGE_KEYS.dashboard))[STORAGE_KEYS.dashboard];
  try {
    const isSelectedMode = projectFilterMode === PROJECT_FILTER_MODES.selected;
    const dashboard = await collectDashboard(new GitLabClient(baseUrl, token), {
      selectedProjectIds: isSelectedMode ? selectedProjectIds : null,
      ignoredCheckNames,
    });
    dashboard.baseUrl = baseUrl;
    if (isSelectedMode && dashboard.watchedProjects === 0 && !dashboard.projectsUnavailable) {
      dashboard.warning = 'Ни один выбранный проект больше не доступен — обновите выбор в настройках';
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.dashboard]: dashboard });
    await showCounts(deriveView(dashboard).counts);
  } catch (error) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.dashboard]: { ...previous, error: describeError(error), failedAt: new Date().toISOString() },
    });
    await setBadge('!', BADGE_COLOR_ERROR);
  }
}

async function checkForUpdate() {
  const { checkUpdates } = await loadSettings();
  const permitted = checkUpdates && (await chrome.permissions.contains({ origins: [UPDATE_CHECK_ORIGIN] }));
  if (!permitted) {
    await chrome.storage.local.remove(STORAGE_KEYS.update);
    return;
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return;
    }
    const release = await response.json();
    const currentVersion = chrome.runtime.getManifest().version;
    const isNewer = compareVersions(release.tag_name, currentVersion) > 0;
    const stillEnabled =
      (await loadSettings()).checkUpdates && (await chrome.permissions.contains({ origins: [UPDATE_CHECK_ORIGIN] }));
    if (!stillEnabled) {
      return;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.update]: isNewer
        ? { version: release.tag_name.replace(/^v/, ''), url: release.html_url, checkedAt: new Date().toISOString() }
        : null,
    });
  } catch (error) {
    console.warn('Update check failed', error);
  }
}

async function scheduleUpdateCheck() {
  const { checkUpdates } = await loadSettings();
  if (!checkUpdates) {
    await chrome.alarms.clear(UPDATE_ALARM_NAME);
    await chrome.storage.local.remove(STORAGE_KEYS.update);
    return;
  }
  await chrome.alarms.create(UPDATE_ALARM_NAME, { delayInMinutes: 0, periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES });
}

function refresh() {
  inFlightRefresh ??= performRefresh().catch(console.error).finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function scheduleRefresh({ immediately }) {
  const { intervalMinutes } = await loadSettings();
  const periodInMinutes = Math.max(MIN_INTERVAL_MINUTES, Number(intervalMinutes) || DEFAULT_INTERVAL_MINUTES);
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: immediately ? 0 : periodInMinutes,
    periodInMinutes,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleRefresh({ immediately: true });
  scheduleUpdateCheck();
});
chrome.runtime.onStartup.addListener(() => {
  scheduleRefresh({ immediately: true });
  scheduleUpdateCheck();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refresh();
  } else if (alarm.name === UPDATE_ALARM_NAME) {
    checkForUpdate();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.settings]) {
    scheduleRefresh({ immediately: false });
    const { oldValue, newValue } = changes[STORAGE_KEYS.settings];
    if (Boolean(oldValue?.checkUpdates) !== Boolean(newValue?.checkUpdates)) {
      scheduleUpdateCheck();
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'refresh') {
    refresh().then(() => sendResponse({ done: true }));
    return true;
  }
  return false;
});
