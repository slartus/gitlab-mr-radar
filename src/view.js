import { isSnoozeActive } from './snooze.js';

export const SECTION_IDS = ['reviewing', 'mentioned', 'awaitingApproval', 'threads', 'authored'];

const isFailedPipeline = (item) => item.pipeline?.status === 'failed' && !item.pipeline.onlyIgnoredFailures;
const awaitsMyReview = (item) => !item.approvedByMe && !item.draft;

function countActionable({ reviewing, mentioned, awaitingApproval, threads, authored }) {
  const waiting = new Set([
    ...mentioned.map((item) => item.key),
    ...reviewing.filter(awaitsMyReview).map((item) => item.key),
    ...awaitingApproval.map((item) => item.key),
    ...threads.map((item) => item.key),
  ]);
  return { waiting: waiting.size, failedCi: authored.filter(isFailedPipeline).length };
}

export function itemsByKey(dashboard) {
  return new Map(SECTION_IDS.flatMap((id) => dashboard.sections?.[id] ?? []).map((item) => [item.key, item]));
}

export function deriveView(dashboard, userState = {}, now = Date.now()) {
  const snoozed = userState.snoozed ?? {};
  const isSnoozed = (item) => isSnoozeActive(snoozed[item.key], item, now);
  const sections = Object.fromEntries(
    SECTION_IDS.map((id) => [id, (dashboard.sections?.[id] ?? []).filter((item) => !isSnoozed(item))]),
  );
  const snoozedItems = [...itemsByKey(dashboard).values()]
    .filter(isSnoozed)
    .map((item) => ({ ...item, snooze: snoozed[item.key] }));
  return { sections, snoozed: snoozedItems, counts: countActionable(sections) };
}

const NOTIFICATION_RULES = [
  {
    type: 'review',
    section: 'reviewing',
    applies: awaitsMyReview,
    isNew: (item, prev) => !prev || !awaitsMyReview(prev),
  },
  {
    type: 'mention',
    section: 'mentioned',
    source: 'mentionsUnavailable',
    isNew: (item, prev) => !prev || item.mentionCount > prev.mentionCount || item.mentionedAt > prev.mentionedAt,
  },
  { type: 'approval', section: 'awaitingApproval', isNew: (item, prev) => !prev },
  {
    type: 'thread',
    section: 'threads',
    isNew: (item, prev) => !prev || item.threadsAwaitingReply > prev.threadsAwaitingReply,
  },
  {
    type: 'ciFailed',
    section: 'authored',
    source: 'pipelinesUnavailable',
    applies: isFailedPipeline,
    isNew: (item, prev) => !prev || !isFailedPipeline(prev) || prev.pipeline.id !== item.pipeline.id,
  },
  {
    type: 'mergeable',
    section: 'authored',
    applies: (item) => item.status === 'mergeable' && !item.draft,
    isNew: (item, prev) => Boolean(prev) && prev.status !== 'mergeable',
  },
];

const isComplete = (dashboard) =>
  !dashboard.skippedMrs && !dashboard.skippedProjects && !dashboard.projectsUnavailable;

const sameSource = (previous, next) =>
  previous.baseUrl === next.baseUrl &&
  previous.username === next.username &&
  JSON.stringify(previous.filters ?? null) === JSON.stringify(next.filters ?? null);

export function collectNotificationEvents(previous, next, userState = {}, now = Date.now()) {
  if (!previous?.sections || !sameSource(previous, next)) {
    return [];
  }
  const previousView = deriveView(previous, {}, now);
  const nextView = deriveView(next, userState, now);
  const previousComplete = isComplete(previous);
  return NOTIFICATION_RULES.filter(({ source }) => !source || (!previous[source] && !next[source])).flatMap(
    ({ type, section, applies = () => true, isNew }) => {
      const previousByKey = new Map(previousView.sections[section].map((item) => [item.key, item]));
      return nextView.sections[section]
        .filter((item) => {
          const prev = previousByKey.get(item.key);
          return applies(item) && (prev || previousComplete) && isNew(item, prev);
        })
        .map((item) => ({ type, item }));
    },
  );
}
