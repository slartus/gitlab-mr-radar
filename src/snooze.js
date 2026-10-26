const HOUR_MS = 60 * 60 * 1000;
const MORNING_HOUR = 9;

export const SNOOZE_OPTIONS = {
  hour: { label: 'на 1 ч' },
  tomorrow: { label: 'до завтра' },
  untilChange: { label: 'до изменений' },
};

function nextMorning(now) {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(MORNING_HOUR, 0, 0, 0);
  return date;
}

export function createSnooze(option, item, now = Date.now()) {
  if (option === 'hour') {
    return { until: new Date(now + HOUR_MS).toISOString() };
  }
  if (option === 'tomorrow') {
    return { until: nextMorning(now).toISOString() };
  }
  if (option === 'untilChange') {
    return { updatedAt: item.updatedAt };
  }
  throw new Error(`Unknown snooze option: ${option}`);
}

export function isSnoozeActive(snooze, item, now = Date.now()) {
  if (!snooze) {
    return false;
  }
  if (snooze.until) {
    return now < Date.parse(snooze.until);
  }
  if (snooze.updatedAt) {
    return Date.parse(item.updatedAt) <= Date.parse(snooze.updatedAt);
  }
  return false;
}

export function nextSnoozeExpiry(snoozed, now = Date.now()) {
  const expiries = Object.values(snoozed ?? {})
    .map((snooze) => Date.parse(snooze?.until))
    .filter((time) => time > now);
  return expiries.length ? Math.min(...expiries) : null;
}

export function pruneSnoozed(snoozed, itemsByKey, now = Date.now()) {
  return Object.fromEntries(
    Object.entries(snoozed ?? {}).filter(
      ([key, snooze]) => itemsByKey.has(key) && isSnoozeActive(snooze, itemsByKey.get(key), now),
    ),
  );
}
