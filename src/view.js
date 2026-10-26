import { isSnoozeActive } from './snooze.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_EXPIRY_WARNING_DAYS = 7;
export const REQUIRED_TOKEN_SCOPE = 'read_api';

export const SECTION_IDS = [
  'reviewing',
  'assigned',
  'mentioned',
  'awaitingApproval',
  'threads',
  'authored',
  'brokenBranches',
];

const isFailedPipeline = (item) => item.pipeline?.status === 'failed' && !item.pipeline.onlyIgnoredFailures;
const awaitsMyReview = (item) => !item.approvedByMe && !item.draft;

function countActionable({ reviewing, assigned, mentioned, awaitingApproval, threads, authored }) {
  const waiting = new Set([
    ...mentioned.map((item) => item.key),
    ...reviewing.filter(awaitsMyReview).map((item) => item.key),
    ...assigned.filter(awaitsMyReview).map((item) => item.key),
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
    type: 'assigned',
    section: 'assigned',
    sources: ['assignedUnavailable'],
    applies: awaitsMyReview,
    isNew: (item, prev) => !prev || !awaitsMyReview(prev),
  },
  {
    type: 'mention',
    section: 'mentioned',
    sources: ['mentionsUnavailable', 'assignedUnavailable'],
    isNew: (item, prev) => !prev || item.mentionCount > prev.mentionCount || item.mentionedAt > prev.mentionedAt,
  },
  { type: 'approval', section: 'awaitingApproval', sources: ['assignedUnavailable'], isNew: (item, prev) => !prev },
  {
    type: 'thread',
    section: 'threads',
    isNew: (item, prev) => !prev || item.threadsAwaitingReply > prev.threadsAwaitingReply,
  },
  {
    type: 'ciFailed',
    section: 'authored',
    sources: ['pipelinesUnavailable'],
    applies: isFailedPipeline,
    isNew: (item, prev) => !prev || !isFailedPipeline(prev) || prev.pipeline.id !== item.pipeline.id,
  },
  {
    type: 'mergeable',
    section: 'authored',
    applies: (item) => item.status === 'mergeable' && !item.draft,
    isNew: (item, prev) => Boolean(prev) && prev.status !== 'mergeable',
  },
  {
    type: 'branchBroken',
    section: 'brokenBranches',
    sources: ['defaultBranchesUnavailable'],
    isNew: (item, prev) => !prev,
  },
];

const isComplete = (dashboard) =>
  !dashboard.skippedMrs &&
  !dashboard.skippedProjects &&
  !dashboard.projectsUnavailable &&
  !dashboard.assignedUnavailable;

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
  const isApplicable = ({ section, sources = [] }) =>
    Boolean(previous.sections[section]) && sources.every((source) => !previous[source] && !next[source]);
  return NOTIFICATION_RULES.filter(isApplicable).flatMap(
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

export function tokenProblems(token, dismissed = {}, now = Date.now()) {
  if (!token) {
    return [];
  }
  const problems = [];
  if (!token.expiresAt) {
    problems.push({ kind: 'noExpiry', text: 'Токен бессрочный — лучше пересоздать его со сроком действия' });
  } else {
    const msLeft = Date.parse(token.expiresAt) - now;
    if (msLeft <= 0) {
      problems.push({ kind: 'expiry', text: 'Срок действия токена истёк' });
    } else if (msLeft < DAY_MS) {
      problems.push({ kind: 'expiry', text: 'Токен истекает сегодня' });
    } else if (msLeft <= TOKEN_EXPIRY_WARNING_DAYS * DAY_MS) {
      problems.push({ kind: 'expiry', text: `Токен истекает через ${Math.floor(msLeft / DAY_MS)} дн.` });
    }
  }
  const extraScopes = token.scopes.filter((scope) => scope !== REQUIRED_TOKEN_SCOPE).sort();
  const extraScopesKey = extraScopes.join(',');
  if (extraScopes.length && dismissed.extraScopes !== extraScopesKey) {
    problems.push({
      kind: 'extraScopes',
      text: `У токена лишние права: ${extraScopes.join(', ')} — достаточно ${REQUIRED_TOKEN_SCOPE}`,
      dismissKey: extraScopesKey,
    });
  }
  return problems;
}
