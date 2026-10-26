import { DEFAULT_BASE_URL, STORAGE_KEYS, UPDATE_REPOSITORY, compareVersions } from './config.js';
import { GitLabClient, fetchPipelineFailures } from './gitlab.js';
import { failureUrl, isHttpsUrl, isUnderBaseUrl } from './links.js';
import { SNOOZE_OPTIONS, createSnooze, pruneSnoozed } from './snooze.js';
import { deriveView, itemsByKey } from './view.js';

const SECTIONS = [
  { id: 'reviewing', title: 'Меня назначили ревьюером', empty: 'Нет MR на ревью' },
  { id: 'assigned', title: 'Назначены на меня', empty: 'Нет назначенных MR' },
  { id: 'mentioned', title: 'Меня упомянули', empty: 'Нет новых упоминаний' },
  { id: 'awaitingApproval', title: 'Ждут моего апрува', empty: 'Всё заапрувлено' },
  { id: 'threads', title: 'Ждут моего ответа в тредах', empty: 'Нет неотвеченных тредов' },
  { id: 'authored', title: 'Мои MR', empty: 'Нет открытых MR' },
];

const STATUS_TAGS = {
  mergeable: { label: 'можно мёржить', tone: 'ok' },
  can_be_merged: { label: 'можно мёржить', tone: 'ok' },
  not_approved: { label: 'нет апрувов', tone: 'warn' },
  discussions_not_resolved: { label: 'треды', tone: 'warn' },
  ci_must_pass: { label: 'CI не прошёл', tone: 'bad' },
  ci_still_running: { label: 'CI идёт', tone: 'warn' },
  need_rebase: { label: 'нужен rebase', tone: 'bad' },
  conflict: { label: 'конфликт', tone: 'bad' },
  broken_status: { label: 'сломан', tone: 'bad' },
  cannot_be_merged: { label: 'конфликт', tone: 'bad' },
  requested_changes: { label: 'просят правки', tone: 'bad' },
  blocked_status: { label: 'заблокирован', tone: 'bad' },
  checking: { label: 'проверяется', tone: '' },
  unchecked: { label: 'не проверен', tone: '' },
};

const PIPELINE_STATUS_TAGS = {
  success: { label: 'CI ок', tone: 'ok' },
  running: { label: 'CI идёт', tone: 'warn' },
  pending: { label: 'CI идёт', tone: 'warn' },
  created: { label: 'CI идёт', tone: 'warn' },
  preparing: { label: 'CI идёт', tone: 'warn' },
  waiting_for_resource: { label: 'CI идёт', tone: 'warn' },
  scheduled: { label: 'CI запланирован', tone: '' },
  manual: { label: 'CI ждёт ручного запуска', tone: 'warn' },
  waiting_for_callback: { label: 'CI идёт', tone: 'warn' },
  canceling: { label: 'CI отменяется', tone: '' },
  canceled: { label: 'CI отменён', tone: '' },
  skipped: { label: 'CI пропущен', tone: '' },
};

const CI_MERGE_STATUSES = new Set(['ci_must_pass', 'ci_still_running']);

const FAILURE_REASONS = {
  script_failure: 'ошибка в скрипте',
  runner_system_failure: 'сбой раннера',
  stuck_or_timeout_failure: 'таймаут',
  job_execution_timeout: 'таймаут',
  missing_dependency_failure: 'нет артефактов зависимости',
  api_failure: 'ошибка API',
  scheduler_failure: 'ошибка планировщика',
  runner_unsupported: 'раннер не поддерживает джобу',
  unmet_prerequisites: 'не выполнены предусловия',
  archived_failure: 'джоба в архиве',
  downstream_pipeline_creation_failed: 'не создан дочерний пайплайн',
};

const SNOOZED_SECTION = { id: 'snoozed', title: 'Отложено', empty: '' };

const pipelineFailures = new Map();
const expandedPipelines = new Set();
let currentDashboard = null;
let currentUserState = {};
let pendingUserStateWrite = Promise.resolve();

const elements = {
  meta: document.getElementById('meta'),
  error: document.getElementById('error'),
  update: document.getElementById('update'),
  sections: document.getElementById('sections'),
  refresh: document.getElementById('refresh'),
  settings: document.getElementById('settings'),
};

function createElement(tag, { className, text, attrs } = {}, children = []) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  Object.entries(attrs ?? {}).forEach(([key, value]) => element.setAttribute(key, value));
  element.append(...children);
  return element;
}

const tag = (label, tone = '') => createElement('span', { className: `tag ${tone}`.trim(), text: label });

function formatRelative(isoDate) {
  const minutes = Math.round((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} д назад`;
}

const openUrl = (url) => chrome.tabs.create({ url });

function describeFailure(failure) {
  if (failure.kind === 'downstream') {
    return 'дочерний пайплайн';
  }
  if (failure.kind === 'external') {
    const host = isHttpsUrl(failure.webUrl) ? new URL(failure.webUrl).hostname : null;
    return [failure.reason, host].filter(Boolean).join(' · ') || 'внешняя проверка';
  }
  return FAILURE_REASONS[failure.reason] ?? failure.reason ?? 'причина неизвестна';
}

async function loadPipelineFailures(item, baseUrl) {
  const { settings } = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if ((settings?.baseUrl ?? DEFAULT_BASE_URL) !== baseUrl) {
    throw new Error('настройки изменились, обновите список');
  }
  const client = new GitLabClient(baseUrl, settings.token);
  return fetchPipelineFailures(client, item.pipeline);
}

function renderFailureRow(failure, baseUrl) {
  const url = failureUrl(failure, baseUrl);
  const title = failure.stage && failure.stage !== 'external' ? `${failure.stage} / ${failure.name}` : failure.name;
  const children = [
    createElement('span', { className: 'ci-job-name', text: `✖ ${title}` }),
    createElement('span', { className: 'ci-job-reason', text: describeFailure(failure), attrs: { title: describeFailure(failure) } }),
  ];
  if (!url) {
    return createElement('div', { className: 'ci-job' }, children);
  }
  const link = createElement('a', { className: 'ci-job', attrs: { href: url, title: url } }, children);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    openUrl(url);
  });
  return link;
}

function renderCiPanel(item, baseUrl, rerender) {
  const state = pipelineFailures.get(item.pipeline.id);
  if (!state || state.status === 'loading') {
    return [createElement('div', { className: 'ci-note', text: 'Загружаю упавшие джобы…' })];
  }
  if (state.status === 'error') {
    const retry = createElement('button', { className: 'ci-retry', text: 'повторить', attrs: { type: 'button' } });
    retry.addEventListener('click', () => {
      pipelineFailures.delete(item.pipeline.id);
      rerender();
    });
    return [createElement('div', { className: 'ci-note bad', text: `Не удалось загрузить: ${state.message} ` }, [retry])];
  }
  if (state.failures.length === 0) {
    const pipelineUrl = isUnderBaseUrl(item.pipeline.webUrl, baseUrl) ? item.pipeline.webUrl : baseUrl;
    const link = createElement('a', { className: 'ci-job', text: 'Упавших джоб не найдено — открыть пайплайн', attrs: { href: pipelineUrl } });
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openUrl(pipelineUrl);
    });
    return [link];
  }
  return state.failures.map((failure) => renderFailureRow(failure, baseUrl));
}

function rerenderCiBlocks(pipelineId) {
  document.querySelectorAll(`.ci[data-pipeline-id="${pipelineId}"]`).forEach((block) => block.rerender?.());
}

function renderCiBlock(item, baseUrl) {
  const pipelineId = item.pipeline.id;
  const block = createElement('div', { className: 'ci', attrs: { 'data-pipeline-id': String(pipelineId) } });
  if (Array.isArray(item.pipeline.failures)) {
    pipelineFailures.set(pipelineId, { status: 'loaded', failures: item.pipeline.failures });
  }
  const onlyIgnored = Boolean(item.pipeline.onlyIgnoredFailures);
  block.classList.toggle('ignored', onlyIgnored);
  const label = onlyIgnored
    ? `⏸ CI ждёт: ${[...new Set(item.pipeline.failures.map((failure) => failure.name))].join(', ')}`
    : '✖ CI упал';

  const rerender = () => {
    const expanded = expandedPipelines.has(pipelineId);
    const toggle = createElement('button', {
      className: onlyIgnored ? 'ci-toggle ignored' : 'ci-toggle',
      text: `${label} ${expanded ? '▾' : '▸'}`,
      attrs: { type: 'button', 'aria-expanded': String(expanded) },
    });
    toggle.addEventListener('click', () => {
      if (expanded) {
        expandedPipelines.delete(pipelineId);
      } else {
        expandedPipelines.add(pipelineId);
      }
      rerender();
    });
    const children = [toggle];
    if (expanded) {
      if (!pipelineFailures.has(pipelineId)) {
        pipelineFailures.set(pipelineId, { status: 'loading' });
        loadPipelineFailures(item, baseUrl)
          .then((failures) => pipelineFailures.set(pipelineId, { status: 'loaded', failures }))
          .catch((error) => pipelineFailures.set(pipelineId, { status: 'error', message: error.message }))
          .finally(() => rerenderCiBlocks(pipelineId));
      }
      children.push(createElement('div', { className: 'ci-panel' }, renderCiPanel(item, baseUrl, rerender)));
    }
    block.replaceChildren(...children);
  };
  block.rerender = rerender;
  rerender();
  return block;
}

function authorLabel(item, sectionId) {
  if (sectionId === 'mentioned') {
    return `от @${item.mentionedBy.join(', @')}`;
  }
  return `@${item.author}`;
}

function renderItem(item, sectionId, baseUrl) {
  const targetUrl = sectionId === 'mentioned' && item.mentionUrl ? item.mentionUrl : item.webUrl;
  const webUrl = isUnderBaseUrl(targetUrl, baseUrl) ? targetUrl : baseUrl;
  const tags = [];
  if (item.draft) tags.push(tag('draft'));
  if (sectionId === SNOOZED_SECTION.id) tags.push(tag(formatSnooze(item.snooze)));
  if (sectionId === 'mentioned' && item.mentionCount > 1) tags.push(tag(`упоминаний: ${item.mentionCount}`, 'warn'));
  if (['reviewing', 'assigned'].includes(sectionId) && item.approvedByMe) tags.push(tag('я апрувнул', 'ok'));
  if (item.threadsAwaitingReply > 0) tags.push(tag(`ждут ответа: ${item.threadsAwaitingReply}`, 'warn'));
  const showsPipeline = sectionId === 'authored' && Boolean(item.pipeline);
  if (sectionId === 'authored') {
    tags.push(tag(`апрувов: ${item.approvalsCount}`, item.approvalsCount > 0 ? 'ok' : ''));
    const pipelineStatus = showsPipeline ? PIPELINE_STATUS_TAGS[item.pipeline.status] : null;
    const hasPipelineTag = Boolean(pipelineStatus) || item.pipeline?.status === 'failed';
    const status = hasPipelineTag && CI_MERGE_STATUSES.has(item.status) ? null : STATUS_TAGS[item.status];
    if (status) tags.push(tag(status.label, status.tone));
    if (pipelineStatus) tags.push(tag(pipelineStatus.label, pipelineStatus.tone));
  } else if (item.hasConflicts) {
    tags.push(tag('конфликт', 'bad'));
  }

  const subline = createElement('span', { className: 'sub' }, [
    createElement('span', { text: item.reference }),
    ...(sectionId === 'authored' ? [] : [createElement('span', { text: authorLabel(item, sectionId) })]),
    createElement('span', { text: formatRelative(sectionId === 'mentioned' ? (item.mentionedAt ?? item.updatedAt) : item.updatedAt) }),
    ...tags,
  ]);
  const link = createElement('a', { attrs: { href: webUrl, title: item.title } }, [
    createElement('span', { className: 'title', text: item.title }),
    subline,
  ]);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    openUrl(webUrl);
  });
  const ciBlock = showsPipeline && item.pipeline.status === 'failed' ? [renderCiBlock(item, baseUrl)] : [];
  const row = createElement('div', { className: 'row' }, [link, renderRowAction(item, sectionId)]);
  return createElement('li', {}, [row, ...ciBlock]);
}

function formatSnooze(snooze) {
  if (!snooze?.until) {
    return 'до изменений';
  }
  const until = new Date(snooze.until);
  const sameDay = until.toDateString() === new Date().toDateString();
  const time = until.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `до ${time}` : `до ${until.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} ${time}`;
}

const isCompleteDashboard = (dashboard) =>
  Boolean(dashboard?.sections) &&
  !dashboard.error &&
  !dashboard.skippedMrs &&
  !dashboard.skippedProjects &&
  !dashboard.projectsUnavailable &&
  !dashboard.mentionsUnavailable &&
  !dashboard.assignedUnavailable;

async function writeSnoozed(change) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.userState);
  const userState = stored[STORAGE_KEYS.userState] ?? {};
  const current = isCompleteDashboard(currentDashboard)
    ? pruneSnoozed(userState.snoozed, itemsByKey(currentDashboard))
    : (userState.snoozed ?? {});
  await chrome.storage.local.set({ [STORAGE_KEYS.userState]: { ...userState, snoozed: change(current) } });
}

function updateSnoozed(change) {
  pendingUserStateWrite = pendingUserStateWrite.then(() => writeSnoozed(change)).catch(console.error);
  return pendingUserStateWrite;
}

const snoozeItem = (item, option) =>
  updateSnoozed((snoozed) => ({ ...snoozed, [item.key]: createSnooze(option, item) }));

const unsnoozeItem = (item) =>
  updateSnoozed(({ [item.key]: _removed, ...snoozed }) => snoozed);

function renderSnoozeMenu(item) {
  return createElement(
    'div',
    { className: 'snooze-menu', attrs: { role: 'group', 'aria-label': 'Отложить MR' } },
    Object.entries(SNOOZE_OPTIONS).map(([option, { label }]) => {
      const button = createElement('button', { text: label, attrs: { type: 'button' } });
      button.addEventListener('click', () => snoozeItem(item, option));
      return button;
    }),
  );
}

function renderRowAction(item, sectionId) {
  if (sectionId === SNOOZED_SECTION.id) {
    const button = createElement('button', {
      className: 'row-action visible',
      text: '↩',
      attrs: { type: 'button', title: 'Вернуть', 'aria-label': `Вернуть: ${item.title}` },
    });
    button.addEventListener('click', () => unsnoozeItem(item));
    return button;
  }
  const button = createElement('button', {
    className: 'row-action',
    text: '⏰',
    attrs: { type: 'button', title: 'Отложить', 'aria-label': `Отложить: ${item.title}`, 'aria-expanded': 'false' },
  });
  button.addEventListener('click', () => {
    const li = button.closest('li');
    const existing = li.querySelector('.snooze-menu');
    if (existing) {
      existing.remove();
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    li.querySelector('.row').after(renderSnoozeMenu(item));
    button.setAttribute('aria-expanded', 'true');
  });
  return button;
}

function renderSection(section, items, baseUrl, { collapsed = false } = {}) {
  const summary = createElement('summary', { text: section.title }, [
    createElement('span', { className: 'count', text: String(items.length) }),
  ]);
  const body = items.length
    ? createElement('ul', {}, items.map((item) => renderItem(item, section.id, baseUrl)))
    : createElement('div', { className: 'empty', text: section.empty });
  const details = createElement('details', {}, [summary, body]);
  details.open = items.length > 0 && !collapsed;
  return details;
}

function render(dashboard, userState) {
  currentDashboard = dashboard;
  currentUserState = userState;
  const problem = dashboard?.error ?? dashboard?.warning;
  elements.error.hidden = !problem;
  elements.error.textContent = problem ?? '';
  const skipped = [
    dashboard?.watchedProjects !== undefined && !dashboard.projectsUnavailable
      ? ` · проектов для апрува: ${dashboard.watchedProjects}`
      : '',
    dashboard?.skippedProjects ? ` · пропущено проектов: ${dashboard.skippedProjects}` : '',
    dashboard?.skippedMrs ? ` · пропущено MR: ${dashboard.skippedMrs}` : '',
    dashboard?.projectsUnavailable ? ' · проекты для апрува недоступны' : '',
    dashboard?.pipelinesUnavailable ? ' · статусы CI недоступны' : '',
    dashboard?.mentionsUnavailable ? ' · упоминания недоступны' : '',
    dashboard?.assignedUnavailable ? ' · назначенные MR недоступны' : '',
  ].join('');
  elements.meta.textContent = dashboard?.fetchedAt
    ? `@${dashboard.username} · ${formatRelative(dashboard.fetchedAt)}${skipped}`
    : '';
  if (!dashboard?.sections || !dashboard.baseUrl) {
    elements.sections.replaceChildren();
    return;
  }
  const view = deriveView(dashboard, userState);
  elements.sections.replaceChildren(
    ...SECTIONS.map((section) => renderSection(section, view.sections[section.id], dashboard.baseUrl)),
    ...(view.snoozed.length
      ? [renderSection(SNOOZED_SECTION, view.snoozed, dashboard.baseUrl, { collapsed: true })]
      : []),
  );
}

function renderUpdate(update) {
  const currentVersion = chrome.runtime.getManifest().version;
  const isNewer =
    Boolean(update?.version) &&
    String(update.url).startsWith(`https://github.com/${UPDATE_REPOSITORY}/releases/`) &&
    compareVersions(update.version, currentVersion) > 0;
  elements.update.hidden = !isNewer;
  if (!isNewer) {
    return;
  }
  const link = createElement('a', { text: `Доступна версия ${update.version}`, attrs: { href: update.url } });
  link.addEventListener('click', (event) => {
    event.preventDefault();
    openUrl(update.url);
  });
  elements.update.replaceChildren(
    link,
    createElement('span', { className: 'muted', text: `у вас ${currentVersion} · git pull → ↻ в chrome://extensions` }),
  );
}

async function loadAndRender() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.dashboard,
    STORAGE_KEYS.update,
    STORAGE_KEYS.userState,
  ]);
  render(stored[STORAGE_KEYS.dashboard], stored[STORAGE_KEYS.userState] ?? {});
  renderUpdate(stored[STORAGE_KEYS.update]);
}

elements.refresh.addEventListener('click', async () => {
  elements.refresh.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'refresh' });
  } finally {
    elements.refresh.disabled = false;
  }
});

elements.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (changes[STORAGE_KEYS.dashboard] || changes[STORAGE_KEYS.userState]) {
    render(
      changes[STORAGE_KEYS.dashboard] ? changes[STORAGE_KEYS.dashboard].newValue : currentDashboard,
      changes[STORAGE_KEYS.userState] ? (changes[STORAGE_KEYS.userState].newValue ?? {}) : currentUserState,
    );
  }
  if (changes[STORAGE_KEYS.update]) {
    renderUpdate(changes[STORAGE_KEYS.update].newValue);
  }
});

loadAndRender();
