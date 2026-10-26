import { STORAGE_KEYS } from './config.js';

const SECTIONS = [
  { id: 'reviewing', title: 'Меня назначили ревьюером', empty: 'Нет MR на ревью' },
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

const elements = {
  meta: document.getElementById('meta'),
  error: document.getElementById('error'),
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

const isUnderBaseUrl = (url, baseUrl) => typeof url === 'string' && url.startsWith(`${baseUrl}/`);

function renderItem(item, sectionId, baseUrl) {
  const webUrl = isUnderBaseUrl(item.webUrl, baseUrl) ? item.webUrl : baseUrl;
  const tags = [];
  if (item.draft) tags.push(tag('draft'));
  if (sectionId === 'reviewing' && item.approvedByMe) tags.push(tag('я апрувнул', 'ok'));
  if (item.threadsAwaitingReply > 0) tags.push(tag(`ждут ответа: ${item.threadsAwaitingReply}`, 'warn'));
  if (sectionId === 'authored') {
    tags.push(tag(`апрувов: ${item.approvalsCount}`, item.approvalsCount > 0 ? 'ok' : ''));
    const status = STATUS_TAGS[item.status];
    if (status) tags.push(tag(status.label, status.tone));
  } else if (item.hasConflicts) {
    tags.push(tag('конфликт', 'bad'));
  }

  const subline = createElement('span', { className: 'sub' }, [
    createElement('span', { text: item.reference }),
    ...(sectionId === 'authored' ? [] : [createElement('span', { text: `@${item.author}` })]),
    createElement('span', { text: formatRelative(item.updatedAt) }),
    ...tags,
  ]);
  const link = createElement('a', { attrs: { href: webUrl, title: item.title } }, [
    createElement('span', { className: 'title', text: item.title }),
    subline,
  ]);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: webUrl });
  });
  return createElement('li', {}, [link]);
}

function renderSection(section, items, baseUrl) {
  const summary = createElement('summary', { text: section.title }, [
    createElement('span', { className: 'count', text: String(items.length) }),
  ]);
  const body = items.length
    ? createElement('ul', {}, items.map((item) => renderItem(item, section.id, baseUrl)))
    : createElement('div', { className: 'empty', text: section.empty });
  const details = createElement('details', {}, [summary, body]);
  details.open = items.length > 0;
  return details;
}

function render(dashboard) {
  const problem = dashboard?.error ?? dashboard?.warning;
  elements.error.hidden = !problem;
  elements.error.textContent = problem ?? '';
  const skipped = [
    dashboard?.watchedProjects !== undefined ? ` · проектов для апрува: ${dashboard.watchedProjects}` : '',
    dashboard?.skippedProjects ? ` · пропущено проектов: ${dashboard.skippedProjects}` : '',
    dashboard?.skippedMrs ? ` · пропущено MR: ${dashboard.skippedMrs}` : '',
  ].join('');
  elements.meta.textContent = dashboard?.fetchedAt
    ? `@${dashboard.username} · ${formatRelative(dashboard.fetchedAt)}${skipped}`
    : '';
  elements.sections.replaceChildren(
    ...(dashboard?.sections && dashboard.baseUrl ? SECTIONS.map((section) => renderSection(section, dashboard.sections[section.id], dashboard.baseUrl)) : []),
  );
}

async function loadAndRender() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.dashboard);
  render(stored[STORAGE_KEYS.dashboard]);
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
  if (area === 'local' && changes[STORAGE_KEYS.dashboard]) {
    render(changes[STORAGE_KEYS.dashboard].newValue);
  }
});

loadAndRender();
