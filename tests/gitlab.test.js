import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { compareVersions, normalizeBaseUrl, parseCheckNames, refreshDelayMinutes } from '../src/config.js';
import {
  GitLabClient,
  GitLabError,
  fetchDefaultBranchPipelines,
  fetchMergeRequestStates,
  fetchPipelineFailures,
  fetchTokenInfo,
} from '../src/gitlab.js';
import { FakeClient, partialGraphql } from './helpers.js';

const BASE_URL = 'https://gitlab.example.com';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('GitLabClient', () => {
  afterEach(() => mock.restoreAll());

  it('follows pagination and sends the token only in the header', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
      const page = new URL(url).searchParams.get('page');
      return jsonResponse([page], { headers: page === '1' ? { 'x-next-page': '2' } : {} });
    });

    const items = await new GitLabClient(BASE_URL, 'secret').getAll('/projects');

    assert.deepEqual(items, ['1', '2']);
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.ok(!String(url).includes('secret'));
    assert.equal(init.headers['PRIVATE-TOKEN'], 'secret');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
  });

  it('retries after 429', async () => {
    let attempt = 0;
    mock.method(globalThis, 'fetch', async () =>
      attempt++ === 0 ? jsonResponse({}, { status: 429, headers: { 'retry-after': '0.01' } }) : jsonResponse({ id: 1 }),
    );

    const client = new GitLabClient(BASE_URL, 't');
    assert.deepEqual(await client.get('/user'), { id: 1 });
    assert.equal(attempt, 2);
    assert.equal(client.requestCount, 2);
  });

  it('throws GitLabError with status and path', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({}, { status: 401 }));
    await assert.rejects(new GitLabClient(BASE_URL, 't').get('/user'), (error) => {
      assert.ok(error instanceof GitLabError);
      assert.equal(error.status, 401);
      assert.equal(error.path, '/user');
      return true;
    });
  });

  it('turns GraphQL errors into GitLabError', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ errors: [{ message: 'boom' }] }));
    await assert.rejects(new GitLabClient(BASE_URL, 't').graphql('{ x }'), /GraphQL: boom/);
  });

  it('returns partial GraphQL data together with errors', async () => {
    const body = { data: { p0: null, p1: { ok: true } }, errors: [{ message: 'boom', path: ['p0'] }] };
    mock.method(globalThis, 'fetch', async () => jsonResponse(body));
    const client = new GitLabClient(BASE_URL, 't');
    assert.deepEqual(await client.graphqlPartial('{ x }'), body);
    await assert.rejects(client.graphql('{ x }'), /GraphQL: boom/);
  });
});

describe('refreshDelayMinutes', () => {
  const NOW = Date.parse('2026-03-10T15:00:00Z');

  it('waits one minute while fast refresh is on and the full interval otherwise', () => {
    assert.equal(refreshDelayMinutes({ intervalMinutes: 15, now: NOW }), 15);
    assert.equal(refreshDelayMinutes({ intervalMinutes: 15, fastSince: NOW - 60_000, now: NOW }), 1);
    assert.equal(refreshDelayMinutes({ intervalMinutes: 15, fastSince: NOW, immediately: true, now: NOW }), 0);
    assert.equal(refreshDelayMinutes({ intervalMinutes: undefined, now: NOW }), 5);
  });

  it('falls back to the interval after an hour of fast refresh', () => {
    assert.equal(refreshDelayMinutes({ intervalMinutes: 15, fastSince: NOW - 59 * 60_000, now: NOW }), 1);
    assert.equal(refreshDelayMinutes({ intervalMinutes: 15, fastSince: NOW - 60 * 60_000, now: NOW }), 15);
  });
});

describe('fetchPipelineFailures', () => {
  const pipeline = { projectPath: 'group/project', id: 7, sha: 'abc' };
  const root = '/projects/group%2Fproject';

  it('collects blocking jobs, downstream bridges and external statuses without duplicates', async () => {
    const client = new FakeClient({
      [`${root}/pipelines/7/jobs`]: [
        { id: 1, name: 'unit', stage: 'test', failure_reason: 'script_failure', web_url: 'j1' },
        { id: 2, name: 'lint', stage: 'test', allow_failure: true },
      ],
      [`${root}/pipelines/7/bridges`]: [
        { id: 3, name: 'deploy', stage: 'deploy', web_url: 'b3', downstream_pipeline: { web_url: 'd3' } },
      ],
      [`${root}/repository/commits/abc/statuses`]: [
        { id: 1, name: 'unit', status: 'failed' },
        { id: 4, name: 'jenkins', status: 'failed', description: 'red', target_url: 'https://ci/4' },
        { id: 5, name: 'ok', status: 'success' },
      ],
    });

    const failures = await fetchPipelineFailures(client, pipeline);

    assert.deepEqual(
      failures.map(({ name, kind, webUrl }) => [name, kind, webUrl]),
      [
        ['unit', 'job', 'j1'],
        ['deploy', 'downstream', 'd3'],
        ['jenkins', 'external', 'https://ci/4'],
      ],
    );
  });

  it('tolerates unavailable commit statuses', async () => {
    const client = new FakeClient({ [`${root}/pipelines/7/jobs`]: [], [`${root}/pipelines/7/bridges`]: [] });
    assert.deepEqual(await fetchPipelineFailures(client, pipeline), []);
  });
});

describe('config helpers', () => {
  it('compares versions', () => {
    assert.equal(compareVersions('v1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.equal(compareVersions('1.2.0', '1.2.1'), -1);
  });

  it('parses check names', () => {
    assert.deepEqual(parseCheckNames('approves, lint\n\napproves\n sonar '), ['approves', 'lint', 'sonar']);
  });

  it('normalizes the base URL and rejects plain http', () => {
    assert.equal(normalizeBaseUrl(' https://gitlab.example.com/gitlab/// '), 'https://gitlab.example.com/gitlab');
    assert.throws(() => normalizeBaseUrl('http://gitlab.example.com'), /https/);
  });
});

describe('fetchMergeRequestStates', () => {
  it('maps approvers and thread counters by iid', async () => {
    let variables = null;
    const client = new FakeClient({}, {
      graphql: (query, vars) => {
        variables = vars;
        return {
          project: {
            mergeRequests: {
              nodes: [
                {
                  iid: '7',
                  userNotesCount: 4,
                  resolvableDiscussionsCount: 3,
                  resolvedDiscussionsCount: 1,
                  approvedBy: { nodes: [{ id: 'gid://gitlab/User/42', username: 'alice' }] },
                },
              ],
            },
          },
        };
      },
    });

    const states = await fetchMergeRequestStates(client, 'group/project', [7, 8]);

    assert.deepEqual(variables, { fullPath: 'group/project', iids: ['7', '8'] });
    assert.deepEqual(states.get(7), {
      approverIds: [42],
      approverNames: ['alice'],
      userNotesCount: 4,
      unresolvedThreads: 2,
      resolvedThreads: 1,
    });
    assert.equal(states.has(8), false);
  });

  it('reads review states of reviewers only when asked', async () => {
    const queries = [];
    const node = {
      iid: '7',
      userNotesCount: 0,
      resolvableDiscussionsCount: 0,
      resolvedDiscussionsCount: 0,
      approvedBy: { nodes: [] },
      reviewers: {
        nodes: [
          { id: 'gid://gitlab/User/1', mergeRequestInteraction: { reviewState: 'REQUESTED_CHANGES' } },
          { id: 'gid://gitlab/User/2', mergeRequestInteraction: null },
        ],
      },
    };
    const client = new FakeClient({}, {
      graphql: (query) => {
        queries.push(query);
        return { project: { mergeRequests: { nodes: [node] } } };
      },
    });

    const states = await fetchMergeRequestStates(client, 'group/project', [7], { withReviewState: true });
    await fetchMergeRequestStates(client, 'group/project', [7]);

    assert.deepEqual(states.get(7).reviewStates, { 1: 'requested_changes' });
    assert.ok(queries[0].includes('reviewState'));
    assert.ok(!queries[1].includes('reviewState'));
  });

  it('returns no states for an inaccessible project', async () => {
    const client = new FakeClient({}, { graphql: () => ({ project: null }) });
    assert.equal((await fetchMergeRequestStates(client, 'group/project', [1])).size, 0);
  });
});

describe('fetchDefaultBranchPipelines', () => {
  it('takes the latest conclusive pipeline, passing paths and branches only as variables', async () => {
    let request = null;
    const client = new FakeClient({}, {
      graphql: (query, variables) => {
        request = { query, variables };
        return {
          p0: {
            pipelines: {
              nodes: [
                { status: 'CANCELED', path: '/a/b/-/pipelines/4', finishedAt: 'u' },
                { status: 'SKIPPED', path: '/a/b/-/pipelines/5', finishedAt: 'v' },
                { status: 'FAILED', path: '/a/b/-/pipelines/3', finishedAt: 't' },
              ],
            },
          },
          p1: { pipelines: { nodes: [{ status: 'CANCELED', path: '/a/c/-/pipelines/6', finishedAt: 'w' }] } },
        };
      },
    });

    const result = await fetchDefaultBranchPipelines(client, [
      { path_with_namespace: 'a/b', default_branch: 'main' },
      { path_with_namespace: 'a/"c', default_branch: 'dev' },
    ]);

    assert.deepEqual(request.variables, { path0: 'a/b', ref0: 'main', path1: 'a/"c', ref1: 'dev' });
    assert.ok(!request.query.includes('a/b') && !request.query.includes('main'));
    assert.deepEqual(result, [
      { status: 'failed', webUrl: 'https://gitlab.example.com/a/b/-/pipelines/3', finishedAt: 't' },
      null,
    ]);
  });
});

describe('fetchDefaultBranchPipelines with partial errors', () => {
  const projects = [
    { path_with_namespace: 'a/b', default_branch: 'main' },
    { path_with_namespace: 'a/c', default_branch: 'main' },
  ];
  const failed = { pipelines: { nodes: [{ status: 'FAILED', path: '/a/c/-/pipelines/1', finishedAt: 't' }] } };

  it('keeps projects that resolved and marks failed aliases as unknown', async () => {
    const client = new FakeClient({}, {
      graphql: () => partialGraphql({ p0: null, p1: failed }, [{ message: 'boom', path: ['p0', 'pipelines'] }]),
    });
    assert.deepEqual(await fetchDefaultBranchPipelines(client, projects), [
      undefined,
      { status: 'failed', webUrl: 'https://gitlab.example.com/a/c/-/pipelines/1', finishedAt: 't' },
    ]);
  });

  it('treats an error without a path as unknown for every project', async () => {
    const client = new FakeClient({}, { graphql: () => partialGraphql({ p0: null, p1: failed }, [{ message: 'boom' }]) });
    assert.deepEqual(await fetchDefaultBranchPipelines(client, projects), [undefined, undefined]);
  });
});

describe('fetchTokenInfo', () => {
  it('reads expiry and scopes of the current token', async () => {
    const client = new FakeClient({ '/personal_access_tokens/self': { expires_at: null, scopes: ['read_api'] } });
    assert.deepEqual(await fetchTokenInfo(client), { expiresAt: null, scopes: ['read_api'] });
  });
});
