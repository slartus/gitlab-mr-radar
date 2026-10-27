import { isUnderBaseUrl } from './links.js';

const MAX_LISTED_ITEMS = 5;

const EVENT_LABELS = {
  review: { title: 'Ревью', counted: (count) => `на ревью: ${count}` },
  assigned: { title: 'Назначен на меня', counted: (count) => `назначено: ${count}` },
  mention: { title: 'Упоминание', counted: (count) => `упоминаний: ${count}` },
  approval: { title: 'Ждёт апрува', counted: (count) => `ждут апрува: ${count}` },
  thread: { title: 'Ответ в треде', counted: (count) => `ждут ответа: ${count}` },
  ciFailed: { title: 'Упал CI', counted: (count) => `упал CI: ${count}` },
  mergeable: { title: 'Можно мёржить', counted: (count) => `можно мёржить: ${count}` },
  branchBroken: { title: 'Сломан default branch', counted: (count) => `сломан default branch: ${count}` },
};

export const NOTIFICATION_TYPES = Object.entries(EVENT_LABELS).map(([type, { title }]) => ({ type, title }));

export const enabledEvents = (events, mutedTypes = []) => events.filter(({ type }) => !mutedTypes.includes(type));

export const uniqueEventItems = (events) => [...new Map(events.map(({ item }) => [item.key, item])).values()];

export function notificationTarget(events, baseUrl) {
  const items = uniqueEventItems(events);
  if (items.length !== 1) {
    return null;
  }
  const event = events.find(({ item }) => item.key === items[0].key);
  const url = event.type === 'mention' && event.item.mentionUrl ? event.item.mentionUrl : event.item.webUrl;
  return isUnderBaseUrl(url, baseUrl) ? url : null;
}

export function formatNotification(events, { showDetails, iconUrl }) {
  const countsByType = new Map();
  events.forEach(({ type }) => countsByType.set(type, (countsByType.get(type) ?? 0) + 1));
  const summary = [...countsByType].map(([type, count]) => EVENT_LABELS[type].counted(count)).join(' · ');
  const base = {
    iconUrl,
    title: 'GitLab MR Radar',
    message: summary,
    priority: ['ciFailed', 'mention', 'branchBroken'].some((type) => countsByType.has(type)) ? 1 : 0,
  };
  if (!showDetails) {
    return { ...base, type: 'basic' };
  }
  return {
    ...base,
    type: 'list',
    items: events.slice(0, MAX_LISTED_ITEMS).map(({ type, item }) => ({
      title: EVENT_LABELS[type].title,
      message: item.title,
    })),
  };
}
