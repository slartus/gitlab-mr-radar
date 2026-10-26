import {
  GitLabError,
  MERGE_REQUEST_STATES_BATCH,
  fetchApprovals,
  fetchAuthoredPipelines,
  fetchDiscussions,
  fetchMaintainedProjects,
  fetchMergeRequestStates,
  fetchPipelineFailures,
} from './gitlab.js';

const CONCURRENCY = 6;
const SKIPPABLE_STATUSES = new Set([403, 404]);
const FATAL_STATUSES = new Set([401, 429]);
const MENTION_ACTIONS = new Set(['mentioned', 'directly_addressed']);

export const mrKey = (mr) => `${mr.project_id}!${mr.iid}`;
const mrReference = (mr) => mr.references?.full ?? `!${mr.iid}`;
const isDraft = (mr) => Boolean(mr.draft ?? mr.work_in_progress);
const projectPathOf = (mr) => {
  const reference = mr.references?.full;
  return reference?.includes('!') ? reference.slice(0, reference.lastIndexOf('!')) : null;
};
const uniqueBy = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];
const byUpdatedDesc = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
const byMentionedDesc = (a, b) => b.mentionedAt.localeCompare(a.mentionedAt);

export const normalizeCheckName = (name) => name.trim().toLowerCase();

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const isSkippable = (error) =>
  error instanceof GitLabError && (SKIPPABLE_STATUSES.has(error.status) || error.status >= 500);

async function orSkip(action, skippedErrors) {
  try {
    return await action();
  } catch (error) {
    if (isSkippable(error)) {
      skippedErrors.push(error);
      return null;
    }
    throw error;
  }
}

function assertNotAllFailed(results, skippedErrors) {
  const serverError = skippedErrors.find((error) => error.status >= 500);
  if (serverError && results.length > 0 && skippedErrors.length === results.length) {
    throw serverError;
  }
}

const optional = (promise) =>
  promise.catch((error) =>
    error instanceof GitLabError && !FATAL_STATUSES.has(error.status) ? null : Promise.reject(error),
  );

export function countThreadsAwaitingReply(discussions, mr, me) {
  const isMyMr = mr.author.id === me.id;
  return discussions.filter((discussion) => {
    const notes = discussion.notes.filter((note) => !note.system);
    const isUnresolved = notes.some((note) => note.resolvable && !note.resolved);
    if (!isUnresolved) {
      return false;
    }
    const iParticipate = isMyMr || notes.some((note) => note.author.id === me.id);
    const lastNote = notes[notes.length - 1];
    return iParticipate && lastNote.author.id !== me.id;
  }).length;
}

async function fetchThreadsAwaitingReply(client, mr, me) {
  if (!mr.user_notes_count) {
    return 0;
  }
  return countThreadsAwaitingReply(await fetchDiscussions(client, mr), mr, me);
}

async function fetchDetails(client, mr, me, shouldCheckThreads) {
  const approvals = await fetchApprovals(client, mr);
  return {
    approvedByMe: Boolean(approvals.user_has_approved),
    approvalsCount: approvals.approved_by?.length ?? 0,
    threadsAwaitingReply: shouldCheckThreads ? await fetchThreadsAwaitingReply(client, mr, me) : 0,
  };
}

const threadStateKey = (mr, state) =>
  `${mr.updated_at}:${state.userNotesCount}:${state.unresolvedThreads}:${state.resolvedThreads}`;

async function detailsFromState(client, mr, me, state, shouldCheckThreads, threadCache) {
  const details = {
    approvedByMe: state.approverIds.includes(me.id),
    approvalsCount: state.approverIds.length,
    threadsAwaitingReply: 0,
  };
  if (!shouldCheckThreads || state.userNotesCount === 0 || state.unresolvedThreads <= 0) {
    return { details };
  }
  const stateKey = threadStateKey(mr, state);
  const cached = threadCache[mrKey(mr)];
  const threadsAwaitingReply =
    cached?.stateKey === stateKey
      ? cached.threadsAwaitingReply
      : countThreadsAwaitingReply(await fetchDiscussions(client, mr), mr, me);
  return { details: { ...details, threadsAwaitingReply }, cacheEntry: { stateKey, threadsAwaitingReply } };
}

function chunk(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

async function fetchStates(client, mrs) {
  const iidsByPath = new Map();
  mrs.forEach((mr) => {
    const path = projectPathOf(mr);
    if (path) {
      iidsByPath.set(path, [...(iidsByPath.get(path) ?? []), mr]);
    }
  });
  const batches = [...iidsByPath].flatMap(([path, pathMrs]) =>
    chunk(pathMrs, MERGE_REQUEST_STATES_BATCH).map((batch) => ({ path, batch })),
  );
  const results = await mapLimit(batches, CONCURRENCY, ({ path, batch }) =>
    optional(fetchMergeRequestStates(client, path, batch.map((mr) => mr.iid))),
  );
  const states = new Map();
  batches.forEach(({ batch }, index) =>
    batch.forEach((mr) => {
      const state = results[index]?.get(mr.iid);
      if (state) {
        states.set(mrKey(mr), state);
      }
    }),
  );
  return states;
}

function toItem(mr, extra) {
  return {
    key: mrKey(mr),
    projectId: mr.project_id,
    title: mr.title,
    webUrl: mr.web_url,
    reference: mrReference(mr),
    author: mr.author.username,
    draft: isDraft(mr),
    status: mr.detailed_merge_status ?? mr.merge_status,
    hasConflicts: Boolean(mr.has_conflicts),
    updatedAt: mr.updated_at,
    ...extra,
  };
}

export function collectMentions(todos, excludedKeys) {
  const todosByMr = new Map();
  todos
    .filter((todo) => MENTION_ACTIONS.has(todo.action_name) && todo.target?.state === 'opened')
    .filter((todo) => !excludedKeys.has(mrKey(todo.target)))
    .forEach((todo) => {
      const key = mrKey(todo.target);
      todosByMr.set(key, [...(todosByMr.get(key) ?? []), todo]);
    });
  return [...todosByMr.values()].map((mrTodos) => {
    const latest = mrTodos.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    return toItem(latest.target, {
      mentionedBy: [...new Set(mrTodos.map((todo) => todo.author.username))],
      mentionCount: mrTodos.length,
      mentionUrl: latest.target_url,
      mentionedAt: latest.created_at,
    });
  });
}

function withFailures(pipeline, failures, ignoredChecks) {
  if (pipeline?.status !== 'failed') {
    return pipeline;
  }
  const blockingFailures = failures?.filter((failure) => !ignoredChecks.has(normalizeCheckName(failure.name)));
  return {
    ...pipeline,
    failures,
    onlyIgnoredFailures: Boolean(failures?.length) && blockingFailures.length === 0,
  };
}

const pipelineOf = (raw, mr) => raw.authoredPipelines?.get(mrReference(mr)) ?? null;

export async function fetchRaw(client, { selectedProjectIds = null } = {}) {
  const me = await client.get('/user');

  const [maintainedProjects, authoredMrs, reviewingMrs, assignedMrs, authoredPipelines, todos] = await Promise.all([
    optional(fetchMaintainedProjects(client)),
    client.getAll('/merge_requests', { scope: 'created_by_me', state: 'opened' }),
    client.getAll('/merge_requests', { scope: 'all', state: 'opened', reviewer_id: me.id }),
    optional(client.getAll('/merge_requests', { scope: 'assigned_to_me', state: 'opened' })),
    optional(fetchAuthoredPipelines(client)),
    optional(client.getAll('/todos', { state: 'pending', type: 'MergeRequest' })),
  ]);
  const watchedIds = selectedProjectIds && new Set(selectedProjectIds);
  const watchedProjects = (maintainedProjects ?? []).filter((project) => !watchedIds || watchedIds.has(project.id));

  const skippedErrors = [];
  const maintainedMrLists = await mapLimit(watchedProjects, CONCURRENCY, (project) =>
    orSkip(
      () =>
        client.getAll(`/projects/${project.id}/merge_requests`, {
          state: 'opened',
          wip: 'no',
          'not[author_id]': me.id,
        }),
      skippedErrors,
    ),
  );
  assertNotAllFailed(maintainedMrLists, skippedErrors);

  return {
    me,
    authoredMrs,
    reviewingMrs,
    assignedMrs: (assignedMrs ?? []).filter((mr) => mr.author.id !== me.id),
    assignedUnavailable: assignedMrs === null,
    maintainedMrs: maintainedMrLists
      .flatMap((list) => list ?? [])
      .filter((mr) => !isDraft(mr) && mr.author.id !== me.id),
    watchedProjects: watchedProjects.length,
    skippedProjects: maintainedMrLists.filter((list) => list === null).length,
    projectsUnavailable: maintainedProjects === null,
    authoredPipelines,
    todos,
  };
}

export async function enrich(client, raw, threadCache = null) {
  const { me, authoredMrs, reviewingMrs, assignedMrs, maintainedMrs } = raw;
  const threadWatchKeys = new Set([...authoredMrs, ...reviewingMrs, ...assignedMrs].map(mrKey));
  const allMrs = uniqueBy([...authoredMrs, ...reviewingMrs, ...assignedMrs, ...maintainedMrs], mrKey);
  const cachedThreads = threadCache?.userId === me.id ? threadCache.entries : {};

  const states = await fetchStates(client, allMrs);
  const skippedErrors = [];
  const results = await mapLimit(allMrs, CONCURRENCY, (mr) =>
    orSkip(async () => {
      const shouldCheckThreads = threadWatchKeys.has(mrKey(mr));
      const state = states.get(mrKey(mr));
      return state
        ? detailsFromState(client, mr, me, state, shouldCheckThreads, cachedThreads)
        : { details: await fetchDetails(client, mr, me, shouldCheckThreads) };
    }, skippedErrors),
  );
  assertNotAllFailed(results, skippedErrors);
  const detailsByKey = new Map(
    allMrs.map((mr, index) => [mrKey(mr), results[index]?.details]).filter(([, detail]) => detail),
  );
  const threadEntries = Object.fromEntries(
    allMrs.map((mr, index) => [mrKey(mr), results[index]?.cacheEntry]).filter(([, entry]) => entry),
  );

  const failedAuthored = authoredMrs.filter(
    (mr) => detailsByKey.has(mrKey(mr)) && pipelineOf(raw, mr)?.status === 'failed',
  );
  const failures = await mapLimit(failedAuthored, CONCURRENCY, (mr) =>
    optional(fetchPipelineFailures(client, pipelineOf(raw, mr))),
  );

  return {
    details: detailsByKey,
    pipelineFailures: new Map(failedAuthored.map((mr, index) => [mrKey(mr), failures[index]])),
    skippedMrs: results.filter((result) => result === null).length,
    threadCache: { userId: me.id, entries: threadEntries },
  };
}

export function classify(raw, { details, pipelineFailures }, ignoredCheckNames = []) {
  const { me, authoredMrs, reviewingMrs, assignedMrs, maintainedMrs, todos } = raw;
  const reviewingKeys = new Set(reviewingMrs.map(mrKey));
  const toItems = (mrs) =>
    mrs
      .filter((mr) => details.has(mrKey(mr)))
      .map((mr) => {
        const { approvedByMe, approvalsCount, threadsAwaitingReply } = details.get(mrKey(mr));
        return toItem(mr, { approvedByMe, approvalsCount, threadsAwaitingReply });
      });

  const reviewing = toItems(reviewingMrs.filter((mr) => mr.author.id !== me.id));
  const assigned = toItems(assignedMrs.filter((mr) => !reviewingKeys.has(mrKey(mr))));
  const personalKeys = new Set([...reviewing, ...assigned].map((item) => item.key));
  const mentioned = collectMentions(todos ?? [], personalKeys);
  const awaitingApproval = toItems(maintainedMrs.filter((mr) => !personalKeys.has(mrKey(mr)))).filter(
    (item) => !item.approvedByMe,
  );
  const ignoredChecks = new Set(ignoredCheckNames.map(normalizeCheckName));
  const authored = toItems(authoredMrs).map((item) => ({
    ...item,
    pipeline: withFailures(
      raw.authoredPipelines?.get(item.reference) ?? null,
      pipelineFailures.get(item.key) ?? null,
      ignoredChecks,
    ),
  }));
  const threads = uniqueBy([...authored, ...reviewing, ...assigned], (item) => item.key).filter(
    (item) => item.threadsAwaitingReply > 0,
  );

  return {
    reviewing: reviewing.sort(byUpdatedDesc),
    assigned: assigned.sort(byUpdatedDesc),
    mentioned: mentioned.sort(byMentionedDesc),
    awaitingApproval: awaitingApproval.sort(byUpdatedDesc),
    threads: threads.sort(byUpdatedDesc),
    authored: authored.sort(byUpdatedDesc),
  };
}

export async function collectDashboard(
  client,
  { selectedProjectIds = null, ignoredCheckNames = [], threadCache = null } = {},
) {
  const raw = await fetchRaw(client, { selectedProjectIds });
  const enriched = await enrich(client, raw, threadCache);
  return {
    fetchedAt: new Date().toISOString(),
    username: raw.me.username,
    watchedProjects: raw.watchedProjects,
    skippedProjects: raw.skippedProjects,
    skippedMrs: enriched.skippedMrs,
    projectsUnavailable: raw.projectsUnavailable,
    pipelinesUnavailable: raw.authoredPipelines === null,
    mentionsUnavailable: raw.todos === null,
    assignedUnavailable: raw.assignedUnavailable,
    sections: classify(raw, enriched, ignoredCheckNames),
    threadCache: enriched.threadCache,
  };
}
