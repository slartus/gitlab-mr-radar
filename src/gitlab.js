const PER_PAGE = 100;
const MAINTAINER_ACCESS_LEVEL = 40;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_MS = 25_000;

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

const hasMergeRequests = (project) =>
  project.merge_requests_enabled !== false && project.merge_requests_access_level !== 'disabled';

export async function fetchAuthoredPipelines(client) {
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
          .getAll(`${projectApiPath}/repository/commits/${encodeURIComponent(sha)}/statuses`, { pipeline_id: id })
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

export const fetchApprovals = (client, mr) =>
  client.get(`/projects/${mr.project_id}/merge_requests/${mr.iid}/approvals`);

export const fetchDiscussions = (client, mr) =>
  client.getAll(`/projects/${mr.project_id}/merge_requests/${mr.iid}/discussions`);
