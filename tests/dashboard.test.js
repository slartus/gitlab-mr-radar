import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { collectDashboard, collectMentions, countThreadsAwaitingReply } from '../src/dashboard.js';
import { GitLabError } from '../src/gitlab.js';
import { deriveView } from '../src/view.js';
import { ALICE, BOB, FakeClient, ME, emptyDashboardRoutes, mr, note, serverError } from './helpers.js';

const approvals = (approvedBy = [], userHasApproved = false) => ({
  approved_by: approvedBy.map((user) => ({ user })),
  user_has_approved: userHasApproved,
});

function mergeRequestsRoute({ authored = [], reviewing = [] }) {
  return (params) => (params.scope === 'created_by_me' ? authored : reviewing);
}

describe('countThreadsAwaitingReply', () => {
  const foreignMr = mr({ iid: 1, author: ALICE });
  const myMr = mr({ iid: 2, author: ME });

  it('counts unresolved threads where I participate and the last note is not mine', () => {
    const discussions = [
      { notes: [note(ME), note(ALICE)] },
      { notes: [note(ALICE), note(ME)] },
      { notes: [note(ME, { resolved: true }), note(ALICE, { resolved: true })] },
      { notes: [note(ALICE), note(BOB)] },
    ];
    assert.equal(countThreadsAwaitingReply(discussions, foreignMr, ME), 1);
  });

  it('treats every unresolved thread on my MR as mine', () => {
    const discussions = [{ notes: [note(ALICE)] }, { notes: [note(BOB), note(ME)] }];
    assert.equal(countThreadsAwaitingReply(discussions, myMr, ME), 1);
  });

  it('ignores system notes and non-resolvable discussions', () => {
    const discussions = [
      { notes: [note(ME), note(ALICE, { system: true })] },
      { notes: [note(ALICE, { resolvable: false })] },
    ];
    assert.equal(countThreadsAwaitingReply(discussions, myMr, ME), 0);
  });
});

describe('collectMentions', () => {
  const todo = (target, author, createdAt, action = 'mentioned') => ({
    action_name: action,
    target,
    author,
    created_at: createdAt,
    target_url: `${target.web_url}#note_${createdAt}`,
  });

  it('groups todos per MR and links to the latest mention', () => {
    const target = mr({ iid: 5, state: 'opened' });
    const items = collectMentions(
      [todo(target, ALICE, '2026-01-01T00:00:00Z'), todo(target, BOB, '2026-01-02T00:00:00Z', 'directly_addressed')],
      new Set(),
    );
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].mentionedBy, ['alice', 'bob']);
    assert.equal(items[0].mentionCount, 2);
    assert.equal(items[0].mentionUrl, `${target.web_url}#note_2026-01-02T00:00:00Z`);
    assert.equal(items[0].mentionedAt, '2026-01-02T00:00:00Z');
    assert.equal(items[0].updatedAt, target.updated_at);
  });

  it('skips closed MRs, other actions and excluded keys', () => {
    const items = collectMentions(
      [
        todo(mr({ iid: 1, state: 'merged' }), ALICE, '2026-01-01T00:00:00Z'),
        todo(mr({ iid: 2, state: 'opened' }), ALICE, '2026-01-01T00:00:00Z', 'assigned'),
        todo(mr({ iid: 3, state: 'opened' }), ALICE, '2026-01-01T00:00:00Z'),
      ],
      new Set(['10!3']),
    );
    assert.deepEqual(items, []);
  });
});

describe('collectDashboard', () => {
  it('sorts MRs into sections', async () => {
    const reviewing = mr({ iid: 1, updatedAt: '2026-01-03T00:00:00Z', user_notes_count: 2 });
    const authored = mr({ iid: 2, author: ME, user_notes_count: 1 });
    const maintained = mr({ iid: 3, author: BOB });
    const approvedMaintained = mr({ iid: 4, author: BOB });
    const draftMaintained = mr({ iid: 5, author: BOB, draft: true });
    const client = new FakeClient({
      ...emptyDashboardRoutes(),
      '/projects': [{ id: 10 }],
      '/merge_requests': mergeRequestsRoute({ authored: [authored], reviewing: [reviewing] }),
      '/projects/10/merge_requests': [reviewing, maintained, approvedMaintained, draftMaintained],
      '/projects/10/merge_requests/1/approvals': approvals(),
      '/projects/10/merge_requests/2/approvals': approvals([ALICE]),
      '/projects/10/merge_requests/3/approvals': approvals(),
      '/projects/10/merge_requests/4/approvals': approvals([ME], true),
      '/projects/10/merge_requests/1/discussions': [{ notes: [note(ME), note(ALICE)] }],
      '/projects/10/merge_requests/2/discussions': [{ notes: [note(BOB)] }],
    });

    const { sections, username, skippedMrs, skippedProjects } = await collectDashboard(client);

    assert.equal(username, 'me');
    assert.equal(skippedMrs, 0);
    assert.equal(skippedProjects, 0);
    assert.deepEqual(sections.reviewing.map((item) => item.key), ['10!1']);
    assert.deepEqual(sections.awaitingApproval.map((item) => item.key), ['10!3']);
    assert.deepEqual(sections.authored.map((item) => item.key), ['10!2']);
    assert.equal(sections.authored[0].approvalsCount, 1);
    assert.deepEqual(sections.threads.map((item) => item.key), ['10!1', '10!2']);
    assert.ok(!client.calls.some((call) => call.path === '/projects/10/merge_requests/3/discussions'));
  });

  it('keeps the dashboard when optional sources fail', async () => {
    const client = new FakeClient({
      ...emptyDashboardRoutes(),
      '/projects': serverError('/projects'),
      '/todos': serverError('/todos'),
    });

    const dashboard = await collectDashboard(client);

    assert.equal(dashboard.projectsUnavailable, true);
    assert.equal(dashboard.mentionsUnavailable, true);
    assert.equal(dashboard.pipelinesUnavailable, true);
    assert.equal(dashboard.watchedProjects, 0);
  });

  it('skips a project or an MR that fails instead of failing the whole dashboard', async () => {
    const client = new FakeClient({
      ...emptyDashboardRoutes(),
      '/projects': [{ id: 10 }, { id: 11 }],
      '/projects/10/merge_requests': serverError('/projects/10/merge_requests'),
      '/projects/11/merge_requests': [mr({ projectId: 11, iid: 1 }), mr({ projectId: 11, iid: 2 })],
      '/projects/11/merge_requests/1/approvals': approvals(),
      '/projects/11/merge_requests/2/approvals': serverError('/projects/11/merge_requests/2/approvals'),
    });

    const dashboard = await collectDashboard(client);

    assert.equal(dashboard.skippedProjects, 1);
    assert.equal(dashboard.skippedMrs, 1);
    assert.deepEqual(dashboard.sections.awaitingApproval.map((item) => item.key), ['11!1']);
  });

  it('fails instead of saving an empty dashboard when every MR fails with 5xx', async () => {
    const client = new FakeClient({
      ...emptyDashboardRoutes(),
      '/merge_requests': mergeRequestsRoute({ authored: [mr({ iid: 1, author: ME })], reviewing: [mr({ iid: 2 })] }),
      '/projects/10/merge_requests/1/approvals': serverError('/projects/10/merge_requests/1/approvals'),
      '/projects/10/merge_requests/2/approvals': serverError('/projects/10/merge_requests/2/approvals'),
    });
    await assert.rejects(collectDashboard(client), { status: 500 });
  });

  it('fails when every maintained project fails with 5xx', async () => {
    const client = new FakeClient({
      ...emptyDashboardRoutes(),
      '/projects': [{ id: 10 }],
      '/projects/10/merge_requests': serverError('/projects/10/merge_requests'),
    });
    await assert.rejects(collectDashboard(client), { status: 500 });
  });

  it('fails when every project fails and at least one of them with 5xx', async () => {
    const client = new FakeClient({
      ...emptyDashboardRoutes(),
      '/projects': [{ id: 10 }, { id: 11 }],
      '/projects/10/merge_requests': new GitLabError(403, '403 Forbidden', '/projects/10/merge_requests'),
      '/projects/11/merge_requests': serverError('/projects/11/merge_requests'),
    });
    await assert.rejects(collectDashboard(client), { status: 500 });
  });

  it('skips projects without access even when all of them are forbidden', async () => {
    const client = new FakeClient({
      ...emptyDashboardRoutes(),
      '/projects': [{ id: 10 }],
      '/projects/10/merge_requests': new GitLabError(403, '403 Forbidden', '/projects/10/merge_requests'),
    });
    const dashboard = await collectDashboard(client);
    assert.equal(dashboard.skippedProjects, 1);
  });

  it('fails on rate limiting of an optional source', async () => {
    const client = new FakeClient({
      ...emptyDashboardRoutes(),
      '/projects': new GitLabError(429, 'Rate limited', '/projects'),
    });
    await assert.rejects(collectDashboard(client), { status: 429 });
  });

  it('does not repeat MRs under review in mentions', async () => {
    const reviewing = mr({ iid: 1, state: 'opened' });
    const client = new FakeClient({
      ...emptyDashboardRoutes(),
      '/merge_requests': mergeRequestsRoute({ reviewing: [reviewing] }),
      '/projects/10/merge_requests/1/approvals': approvals(),
      '/todos': [
        { action_name: 'mentioned', target: reviewing, author: ALICE, created_at: '2026-01-01T00:00:00Z' },
      ],
    });
    const { sections } = await collectDashboard(client);
    assert.deepEqual(sections.reviewing.map((item) => item.key), ['10!1']);
    assert.deepEqual(sections.mentioned, []);
  });

  it('fails when a required source fails', async () => {
    const client = new FakeClient({ ...emptyDashboardRoutes(), '/merge_requests': serverError('/merge_requests') });
    await assert.rejects(collectDashboard(client), { status: 500 });
  });

  it('limits maintained projects to the selected ones', async () => {
    const client = new FakeClient({
      ...emptyDashboardRoutes(),
      '/projects': [{ id: 10 }, { id: 11 }],
      '/projects/11/merge_requests': [],
    });

    const dashboard = await collectDashboard(client, { selectedProjectIds: [11] });

    assert.equal(dashboard.watchedProjects, 1);
    assert.ok(!client.calls.some((call) => call.path === '/projects/10/merge_requests'));
  });

  it('attaches pipeline failures and marks pipelines that failed only on ignored checks', async () => {
    const failed = mr({ iid: 1, author: ME });
    const ignoredOnly = mr({ iid: 2, author: ME });
    const pipeline = (id) => ({
      id: `gid://gitlab/Ci::Pipeline/${id}`,
      sha: `sha${id}`,
      status: 'FAILED',
      path: `/group/project/-/pipelines/${id}`,
      project: { fullPath: 'group/project' },
    });
    const job = (id, name) => ({ id, name, stage: 'test', failure_reason: 'script_failure', web_url: 'u' });
    const client = new FakeClient(
      {
        ...emptyDashboardRoutes(),
        '/merge_requests': mergeRequestsRoute({ authored: [failed, ignoredOnly] }),
        '/projects/10/merge_requests/1/approvals': approvals(),
        '/projects/10/merge_requests/2/approvals': approvals(),
        '/projects/group%2Fproject/pipelines/101/jobs': [job(1, 'unit')],
        '/projects/group%2Fproject/pipelines/102/jobs': [job(2, 'Approves')],
        '/projects/group%2Fproject/pipelines/101/bridges': [],
        '/projects/group%2Fproject/pipelines/102/bridges': [],
      },
      {
        graphql: () => ({
          currentUser: {
            authoredMergeRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { iid: '1', project: { fullPath: 'group/project' }, headPipeline: pipeline(101) },
                { iid: '2', project: { fullPath: 'group/project' }, headPipeline: pipeline(102) },
              ],
            },
          },
        }),
      },
    );

    const { sections } = await collectDashboard(client, { ignoredCheckNames: ['approves'] });
    const byKey = Object.fromEntries(sections.authored.map((item) => [item.key, item.pipeline]));

    assert.equal(byKey['10!1'].status, 'failed');
    assert.equal(byKey['10!1'].onlyIgnoredFailures, false);
    assert.deepEqual(byKey['10!1'].failures.map((failure) => failure.name), ['unit']);
    assert.equal(byKey['10!2'].onlyIgnoredFailures, true);
  });

  it('keeps a failed pipeline in the badge when its jobs cannot be loaded', async () => {
    const client = new FakeClient(
      {
        ...emptyDashboardRoutes(),
        '/merge_requests': mergeRequestsRoute({ authored: [mr({ iid: 1, author: ME })] }),
        '/projects/10/merge_requests/1/approvals': approvals(),
        '/projects/group%2Fproject/pipelines/101/jobs': serverError('/jobs'),
      },
      {
        graphql: () => ({
          currentUser: {
            authoredMergeRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  iid: '1',
                  project: { fullPath: 'group/project' },
                  headPipeline: { id: 'gid://gitlab/Ci::Pipeline/101', sha: 's', status: 'FAILED', path: '/p/101' },
                },
              ],
            },
          },
        }),
      },
    );

    const dashboard = await collectDashboard(client);
    const [item] = dashboard.sections.authored;

    assert.equal(item.pipeline.failures, null);
    assert.equal(item.pipeline.onlyIgnoredFailures, false);
    assert.equal(deriveView(dashboard).counts.failedCi, 1);
  });
});
