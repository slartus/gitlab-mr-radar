import {
  DEFAULT_BASE_URL,
  DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  PROJECT_FILTER_MODES,
  STORAGE_KEYS,
  hasHostPermission,
} from './config.js';
import { GitLabClient, collectDashboard, countActionable } from './gitlab.js';

const ALARM_NAME = 'refresh';
const BADGE_COLOR_OK = '#1f75cb';
const BADGE_COLOR_ERROR = '#dd2b0e';

let inFlightRefresh = null;

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return {
    baseUrl: DEFAULT_BASE_URL,
    token: '',
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    projectFilterMode: PROJECT_FILTER_MODES.all,
    selectedProjectIds: [],
    ...stored[STORAGE_KEYS.settings],
  };
}

async function setBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
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
  if (error instanceof TypeError || error.name === 'TimeoutError') {
    return 'GitLab недоступен — проверьте сеть или VPN';
  }
  return error.message;
}

async function performRefresh() {
  const { baseUrl, token, projectFilterMode, selectedProjectIds } = await loadSettings();
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
    });
    dashboard.baseUrl = baseUrl;
    if (isSelectedMode && dashboard.watchedProjects === 0) {
      dashboard.warning = 'Ни один выбранный проект больше не доступен — обновите выбор в настройках';
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.dashboard]: dashboard });
    const count = countActionable(dashboard);
    await setBadge(count > 0 ? String(count) : '', BADGE_COLOR_OK);
  } catch (error) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.dashboard]: { ...previous, error: describeError(error), failedAt: new Date().toISOString() },
    });
    await setBadge('!', BADGE_COLOR_ERROR);
  }
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

chrome.runtime.onInstalled.addListener(() => scheduleRefresh({ immediately: true }));
chrome.runtime.onStartup.addListener(() => scheduleRefresh({ immediately: true }));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refresh();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.settings]) {
    scheduleRefresh({ immediately: false });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'refresh') {
    refresh().then(() => sendResponse({ done: true }));
    return true;
  }
  return false;
});
