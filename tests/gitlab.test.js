import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { compareVersions, normalizeBaseUrl, parseCheckNames } from '../src/config.js';
import { GitLabClient, GitLabError, fetchPipelineFailures } from '../src/gitlab.js';
import { FakeClient } from './helpers.js';

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

    assert.deepEqual(await new GitLabClient(BASE_URL, 't').get('/user'), { id: 1 });
    assert.equal(attempt, 2);
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
