import {
  GitLabError,
  fetchApprovals,
  fetchAuthoredPipelines,
  fetchDiscussions,
  fetchMaintainedProjects,
  fetchPipelineFailures,
} from './gitlab.js';

const CONCURRENCY = 6;
const SKIPPABLE_STATUSES = new Set([403, 404]);
const FATAL_STATUSES = new Set([401, 429]);
const MENTION_ACTIONS = new Set(['mentioned', 'directly_addressed']);

export const mrKey = (mr) => `${mr.project_id}!${mr.iid}`;
const mrReference = (mr) => mr.references?.full ?? `!${mr.iid}`;
const isDraft = (mr) => Boolean(mr.draft ?? mr.work_in_progress);
const uniqueBy = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];
const byUpdatedDesc = (a, b) => b.updatedAt.localeCompare(a.updatedAt);

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

async function fetchDetails(client, mr, me, isReviewing) {
  const approvals = await fetchApprovals(client, mr);
  const shouldCheckThreads = mr.author.id === me.id || isReviewing;
  return {
    approvedByMe: Boolean(approvals.user_has_approved),
    approvalsCount: approvals.approved_by?.length ?? 0,
    threadsAwaitingReply: shouldCheckThreads ? await fetchThreadsAwaitingReply(client, mr, me) : 0,
  };
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
      updatedAt: latest.created_at,
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

  const [maintainedProjects, authoredMrs, reviewingMrs, authoredPipelines, todos] = await Promise.all([
    optional(fetchMaintainedProjects(client)),
    client.getAll('/merge_requests', { scope: 'created_by_me', state: 'opened' }),
    client.getAll('/merge_requests', { scope: 'all', state: 'opened', reviewer_id: me.id }),
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

export async function enrich(client, raw) {
  const { me, authoredMrs, reviewingMrs, maintainedMrs } = raw;
  const reviewingKeys = new Set(reviewingMrs.map(mrKey));
  const allMrs = uniqueBy([...authoredMrs, ...reviewingMrs, ...maintainedMrs], mrKey);

  const skippedErrors = [];
  const details = await mapLimit(allMrs, CONCURRENCY, (mr) =>
    orSkip(() => fetchDetails(client, mr, me, reviewingKeys.has(mrKey(mr))), skippedErrors),
  );
  assertNotAllFailed(details, skippedErrors);
  const detailsByKey = new Map(
    allMrs.map((mr, index) => [mrKey(mr), details[index]]).filter(([, detail]) => detail !== null),
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
    skippedMrs: details.filter((detail) => detail === null).length,
  };
}

export function classify(raw, { details, pipelineFailures }, ignoredCheckNames = []) {
  const { me, authoredMrs, reviewingMrs, maintainedMrs, todos } = raw;
  const reviewingKeys = new Set(reviewingMrs.map(mrKey));
  const toItems = (mrs) =>
    mrs
      .filter((mr) => details.has(mrKey(mr)))
      .map((mr) => {
        const { approvedByMe, approvalsCount, threadsAwaitingReply } = details.get(mrKey(mr));
        return toItem(mr, { approvedByMe, approvalsCount, threadsAwaitingReply });
      });

  const reviewing = toItems(reviewingMrs.filter((mr) => mr.author.id !== me.id));
  const mentioned = collectMentions(todos ?? [], new Set(reviewing.map((item) => item.key)));
  const awaitingApproval = toItems(maintainedMrs.filter((mr) => !reviewingKeys.has(mrKey(mr)))).filter(
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
  const threads = uniqueBy([...authored, ...reviewing], (item) => item.key).filter(
    (item) => item.threadsAwaitingReply > 0,
  );

  return {
    reviewing: reviewing.sort(byUpdatedDesc),
    mentioned: mentioned.sort(byUpdatedDesc),
    awaitingApproval: awaitingApproval.sort(byUpdatedDesc),
    threads: threads.sort(byUpdatedDesc),
    authored: authored.sort(byUpdatedDesc),
  };
}

export async function collectDashboard(client, { selectedProjectIds = null, ignoredCheckNames = [] } = {}) {
  const raw = await fetchRaw(client, { selectedProjectIds });
  const enriched = await enrich(client, raw);
  return {
    fetchedAt: new Date().toISOString(),
    username: raw.me.username,
    watchedProjects: raw.watchedProjects,
    skippedProjects: raw.skippedProjects,
    skippedMrs: enriched.skippedMrs,
    projectsUnavailable: raw.projectsUnavailable,
    pipelinesUnavailable: raw.authoredPipelines === null,
    mentionsUnavailable: raw.todos === null,
    sections: classify(raw, enriched, ignoredCheckNames),
  };
}
