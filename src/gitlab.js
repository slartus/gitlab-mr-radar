const PER_PAGE = 100;
const CONCURRENCY = 6;
const MAINTAINER_ACCESS_LEVEL = 40;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_MS = 25_000;
const SKIPPABLE_STATUSES = new Set([403, 404]);

const AUTHORED_PIPELINES_QUERY = `
  query AuthoredPipelines($after: String) {
    currentUser {
      authoredMergeRequests(state: opened, first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          iid
          project { fullPath }
          headPipeline { id sha status path project { fullPath } }
        }
      }
    }
  }
`;

export class GitLabError extends Error {
  constructor(status, message, path) {
    super(message);
    this.status = status;
    this.path = path;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitLabClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.apiUrl = `${baseUrl}/api/v4`;
    this.graphqlUrl = `${baseUrl}/api/graphql`;
    this.token = token;
    this.pausedUntil = 0;
  }

  async request(path, params = {}) {
    const url = new URL(`${this.apiUrl}${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await this.send(url, {}, path);
    return {
      data: await response.json(),
      nextPage: response.headers.get('x-next-page'),
    };
  }

  async graphql(query, variables = {}) {
    const response = await this.send(
      this.graphqlUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ query, variables }),
      },
      '/graphql',
    );
    const { data, errors } = await response.json();
    if (errors?.length) {
      throw new GitLabError(response.status, `GraphQL: ${errors[0].message}`, '/graphql');
    }
    return data;
  }

  async send(url, init, path) {
    for (let attempt = 0; ; attempt++) {
      await this.waitForRateLimit(path);
      const response = await this.fetchWithToken(url, init);
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfterMs = (Number(response.headers.get('retry-after')) || 5) * 1000;
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + retryAfterMs);
        continue;
      }
      if (!response.ok) {
        throw new GitLabError(response.status, `${response.status} ${response.statusText}: ${path}`, path);
      }
      return response;
    }
  }

  async waitForRateLimit(path) {
    const waitMs = this.pausedUntil - Date.now();
    if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
      throw new GitLabError(429, 'Rate limited', path);
    }
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  fetchWithToken(url, { headers = {}, ...init } = {}) {
    return fetch(url, {
      ...init,
      headers: { 'PRIVATE-TOKEN': this.token, ...headers },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async get(path, params) {
    return (await this.request(path, params)).data;
  }

  async getAll(path, params = {}) {
    const items = [];
    let page = '1';
    while (page) {
      const { data, nextPage } = await this.request(path, { ...params, per_page: PER_PAGE, page });
      items.push(...data);
      page = nextPage;
    }
    return items;
  }
}

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

async function orSkip(action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof GitLabError && SKIPPABLE_STATUSES.has(error.status)) {
      return null;
    }
    throw error;
  }
}

const mrKey = (mr) => `${mr.project_id}!${mr.iid}`;
const isDraft = (mr) => Boolean(mr.draft ?? mr.work_in_progress);
const uniqueBy = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];
const hasMergeRequests = (project) =>
  project.merge_requests_enabled !== false && project.merge_requests_access_level !== 'disabled';

function fetchApprovals(client, mr) {
  return client.get(`/projects/${mr.project_id}/merge_requests/${mr.iid}/approvals`);
}

async function countThreadsAwaitingReply(client, mr, me) {
  if (!mr.user_notes_count) {
    return 0;
  }
  const discussions = await client.getAll(`/projects/${mr.project_id}/merge_requests/${mr.iid}/discussions`);
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

function toItem(mr, extra) {
  return {
    key: mrKey(mr),
    projectId: mr.project_id,
    title: mr.title,
    webUrl: mr.web_url,
    reference: mr.references?.full ?? `!${mr.iid}`,
    author: mr.author.username,
    draft: isDraft(mr),
    status: mr.detailed_merge_status ?? mr.merge_status,
    hasConflicts: Boolean(mr.has_conflicts),
    updatedAt: mr.updated_at,
    ...extra,
  };
}

const byUpdatedDesc = (a, b) => b.updatedAt.localeCompare(a.updatedAt);

async function fetchAuthoredPipelines(client) {
  const pipelines = new Map();
  let after = null;
  do {
    const data = await client.graphql(AUTHORED_PIPELINES_QUERY, { after });
    const connection = data.currentUser.authoredMergeRequests;
    connection.nodes
      .filter((node) => node.headPipeline)
      .forEach(({ iid, project, headPipeline }) => {
        pipelines.set(`${project.fullPath}!${iid}`, {
          id: Number(headPipeline.id.split('/').pop()),
          projectPath: headPipeline.project?.fullPath ?? project.fullPath,
          sha: headPipeline.sha,
          status: headPipeline.status.toLowerCase(),
          webUrl: new URL(headPipeline.path, client.baseUrl).href,
        });
      });
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return pipelines;
}

export async function fetchPipelineFailures(client, { projectPath, id, sha }) {
  const projectApiPath = `/projects/${encodeURIComponent(projectPath)}`;
  const pipelinePath = `${projectApiPath}/pipelines/${id}`;
  const [jobs, bridges, statuses] = await Promise.all([
    client.getAll(`${pipelinePath}/jobs`, { 'scope[]': 'failed' }),
    client.getAll(`${pipelinePath}/bridges`, { 'scope[]': 'failed' }),
    sha
      ? client
          .getAll(`${projectApiPath}/repository/commits/${sha}/statuses`, { pipeline_id: id })
          .catch((error) => (error instanceof GitLabError ? [] : Promise.reject(error)))
      : [],
  ]);
  const isBlocking = (job) => !job.allow_failure;
  const toFailure = (job, overrides) => ({
    id: job.id,
    name: job.name,
    stage: job.stage,
    reason: job.failure_reason,
    webUrl: job.web_url,
    kind: 'job',
    ...overrides,
  });
  const gitlabJobIds = new Set([...jobs, ...bridges].map((job) => job.id));
  return [
    ...jobs.filter(isBlocking).map((job) => toFailure(job)),
    ...bridges
      .filter(isBlocking)
      .map((bridge) =>
        toFailure(bridge, { webUrl: bridge.downstream_pipeline?.web_url ?? bridge.web_url, kind: 'downstream' }),
      ),
    ...statuses
      .filter((status) => status.status === 'failed' && isBlocking(status) && !gitlabJobIds.has(status.id))
      .map((status) =>
        toFailure(status, { reason: status.description, webUrl: status.target_url, kind: 'external' }),
      ),
  ];
}

export async function fetchMaintainedProjects(client) {
  const projects = await client.getAll('/projects', {
    membership: true,
    min_access_level: MAINTAINER_ACCESS_LEVEL,
    archived: false,
    order_by: 'path',
    sort: 'asc',
  });
  return projects.filter(hasMergeRequests);
}

export const normalizeCheckName = (name) => name.trim().toLowerCase();

async function withPipelineFailures(client, item, pipeline, ignoredChecks) {
  if (pipeline?.status !== 'failed') {
    return { ...item, pipeline };
  }
  const failures = await fetchPipelineFailures(client, pipeline).catch((error) =>
    error instanceof GitLabError ? null : Promise.reject(error),
  );
  const blockingFailures = failures?.filter((failure) => !ignoredChecks.has(normalizeCheckName(failure.name)));
  return {
    ...item,
    pipeline: {
      ...pipeline,
      failures,
      onlyIgnoredFailures: Boolean(failures?.length) && blockingFailures.length === 0,
    },
  };
}

export async function collectDashboard(client, { selectedProjectIds = null, ignoredCheckNames = [] } = {}) {
  const me = await client.get('/user');

  const [maintainedProjects, authoredMrs, reviewingMrs, authoredPipelines] = await Promise.all([
    fetchMaintainedProjects(client),
    client.getAll('/merge_requests', { scope: 'created_by_me', state: 'opened' }),
    client.getAll('/merge_requests', { scope: 'all', state: 'opened', reviewer_id: me.id }),
    fetchAuthoredPipelines(client).catch((error) => {
      if (error instanceof GitLabError) {
        return null;
      }
      throw error;
    }),
  ]);
  const watchedIds = selectedProjectIds && new Set(selectedProjectIds);
  const watchedProjects = watchedIds
    ? maintainedProjects.filter((project) => watchedIds.has(project.id))
    : maintainedProjects;

  const maintainedMrLists = await mapLimit(watchedProjects, CONCURRENCY, (project) =>
    orSkip(() =>
      client.getAll(`/projects/${project.id}/merge_requests`, {
        state: 'opened',
        wip: 'no',
        'not[author_id]': me.id,
      }),
    ),
  );
  const skippedProjects = maintainedMrLists.filter((list) => list === null).length;
  const maintainedMrs = maintainedMrLists
    .flatMap((list) => list ?? [])
    .filter((mr) => !isDraft(mr) && mr.author.id !== me.id);

  const reviewingKeys = new Set(reviewingMrs.map(mrKey));
  const allMrs = uniqueBy([...authoredMrs, ...reviewingMrs, ...maintainedMrs], mrKey);

  const details = await mapLimit(allMrs, CONCURRENCY, (mr) =>
    orSkip(async () => {
      const approvals = await fetchApprovals(client, mr);
      const shouldCheckThreads = mr.author.id === me.id || reviewingKeys.has(mrKey(mr));
      const threadsAwaitingReply = shouldCheckThreads ? await countThreadsAwaitingReply(client, mr, me) : 0;
      return {
        mr,
        approvedByMe: Boolean(approvals.user_has_approved),
        approvalsCount: approvals.approved_by?.length ?? 0,
        threadsAwaitingReply,
      };
    }),
  );
  const skippedMrs = details.filter((detail) => detail === null).length;
  const detailsByKey = new Map(details.filter(Boolean).map((detail) => [mrKey(detail.mr), detail]));
  const toItems = (mrs) =>
    mrs
      .filter((mr) => detailsByKey.has(mrKey(mr)))
      .map((mr) => {
        const { approvedByMe, approvalsCount, threadsAwaitingReply } = detailsByKey.get(mrKey(mr));
        return toItem(mr, { approvedByMe, approvalsCount, threadsAwaitingReply });
      });

  const reviewing = toItems(reviewingMrs.filter((mr) => mr.author.id !== me.id));
  const awaitingApproval = toItems(maintainedMrs.filter((mr) => !reviewingKeys.has(mrKey(mr)))).filter(
    (item) => !item.approvedByMe,
  );
  const ignoredChecks = new Set(ignoredCheckNames.map(normalizeCheckName));
  const authored = await mapLimit(toItems(authoredMrs), CONCURRENCY, (item) =>
    withPipelineFailures(client, item, authoredPipelines?.get(item.reference) ?? null, ignoredChecks),
  );
  const threads = uniqueBy([...authored, ...reviewing], (item) => item.key).filter(
    (item) => item.threadsAwaitingReply > 0,
  );

  return {
    fetchedAt: new Date().toISOString(),
    username: me.username,
    watchedProjects: watchedProjects.length,
    skippedProjects,
    skippedMrs,
    pipelinesUnavailable: authoredPipelines === null,
    sections: {
      reviewing: reviewing.sort(byUpdatedDesc),
      awaitingApproval: awaitingApproval.sort(byUpdatedDesc),
      threads: threads.sort(byUpdatedDesc),
      authored: authored.sort(byUpdatedDesc),
    },
  };
}

export function countActionable(dashboard) {
  const { reviewing, awaitingApproval, threads, authored } = dashboard.sections;
  const waiting = new Set([
    ...reviewing.filter((item) => !item.approvedByMe && !item.draft).map((item) => item.key),
    ...awaitingApproval.map((item) => item.key),
    ...threads.map((item) => item.key),
  ]);
  const failed = authored.filter((item) => item.pipeline?.status === 'failed' && !item.pipeline.onlyIgnoredFailures);
  return { waiting: waiting.size, failedCi: failed.length };
}
