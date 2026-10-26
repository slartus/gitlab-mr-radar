import { GitLabError } from '../src/gitlab.js';

export const ME = { id: 1, username: 'me' };
export const ALICE = { id: 2, username: 'alice' };
export const BOB = { id: 3, username: 'bob' };

export function mr({ projectId = 10, iid, author = ALICE, updatedAt = '2026-01-01T00:00:00Z', ...rest }) {
  return {
    project_id: projectId,
    iid,
    title: `MR ${iid}`,
    web_url: `https://gitlab.example.com/group/project/-/merge_requests/${iid}`,
    references: { full: `group/project!${iid}` },
    author,
    draft: false,
    detailed_merge_status: 'mergeable',
    has_conflicts: false,
    updated_at: updatedAt,
    user_notes_count: 0,
    ...rest,
  };
}

export function note(author, { system = false, resolvable = true, resolved = false } = {}) {
  return { author, system, resolvable, resolved };
}

export class FakeClient {
  constructor(routes, { graphql = null } = {}) {
    this.routes = routes;
    this.graphqlHandler = graphql;
    this.baseUrl = 'https://gitlab.example.com';
    this.calls = [];
  }

  resolve(path, params) {
    this.calls.push({ path, params });
    const handler = this.routes[path];
    if (handler === undefined) {
      throw new GitLabError(404, `404 Not Found: ${path}`, path);
    }
    if (handler instanceof GitLabError) {
      throw handler;
    }
    return typeof handler === 'function' ? handler(params) : handler;
  }

  async get(path, params) {
    return this.resolve(path, params);
  }

  async getAll(path, params) {
    return this.resolve(path, params);
  }

  async graphql(query, variables) {
    if (!this.graphqlHandler) {
      throw new GitLabError(404, 'GraphQL disabled', '/graphql');
    }
    return this.graphqlHandler(query, variables);
  }
}

export const serverError = (path) => new GitLabError(500, `500 Internal Server Error: ${path}`, path);

export function emptyDashboardRoutes() {
  return {
    '/user': ME,
    '/projects': [],
    '/merge_requests': () => [],
    '/todos': [],
  };
}
