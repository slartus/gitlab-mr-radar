import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatNotification, notificationTarget } from '../src/notifications.js';
import { SECTION_IDS, collectNotificationEvents } from '../src/view.js';

const BASE_URL = 'https://gitlab.example.com';
const NOW = Date.parse('2026-03-10T15:00:00');

const mrItem = (key, extra = {}) => ({
  key,
  title: `MR ${key}`,
  webUrl: `${BASE_URL}/group/project/-/merge_requests/${key}`,
  updatedAt: '2026-03-10T10:00:00Z',
  approvedByMe: false,
  draft: false,
  ...extra,
});

const dashboard = (sections, extra = {}) => ({
  baseUrl: BASE_URL,
  username: 'me',
  filters: null,
  sections: { ...Object.fromEntries(SECTION_IDS.map((id) => [id, []])), ...sections },
  ...extra,
});
const eventsOf = (events) => events.map(({ type, item }) => `${type}:${item.key}`);
const changes = (previous, next, userState = {}) => eventsOf(collectNotificationEvents(previous, next, userState, NOW));

describe('collectNotificationEvents', () => {
  it('reports new MRs for review, mentions, approvals and threads', () => {
    const previous = dashboard({ reviewing: [mrItem('1')] });
    const next = dashboard({
      reviewing: [mrItem('1'), mrItem('2'), mrItem('3', { draft: true })],
      mentioned: [mrItem('4', { mentionCount: 1 })],
      awaitingApproval: [mrItem('5')],
      threads: [mrItem('6', { threadsAwaitingReply: 1 })],
    });
    assert.deepEqual(changes(previous, next), [
      'review:2',
      'mention:4',
      'approval:5',
      'thread:6',
    ]);
  });

  it('reports MRs newly assigned to me', () => {
    const previous = dashboard({ assigned: [mrItem('1')] });
    const next = dashboard({ assigned: [mrItem('1'), mrItem('2'), mrItem('3', { approvedByMe: true })] });
    assert.deepEqual(changes(previous, next), ['assigned:2']);
    assert.deepEqual(changes({ ...previous, assignedUnavailable: true }, next), []);
  });

  it('stays silent when an MR moves out of my assigned MRs because they could not be loaded', () => {
    const previous = dashboard({ assigned: [mrItem('1')] });
    const next = dashboard(
      { awaitingApproval: [mrItem('1')], mentioned: [mrItem('1', { mentionCount: 1 })] },
      { assignedUnavailable: true },
    );
    assert.deepEqual(changes(previous, next), []);
  });

  it('skips sections the previous dashboard did not have', () => {
    const previous = { baseUrl: BASE_URL, username: 'me', filters: null, sections: { reviewing: [] } };
    const next = dashboard({ assigned: [mrItem('1')], reviewing: [mrItem('2')] });
    assert.deepEqual(changes(previous, next), ['review:2']);
  });

  it('reports a review again when my approval was reset', () => {
    const previous = dashboard({ reviewing: [mrItem('1', { approvedByMe: true })] });
    const next = dashboard({ reviewing: [mrItem('1')] });
    assert.deepEqual(changes(previous, next), ['review:1']);
  });

  it('reports repeated mentions and new replies in known threads', () => {
    const previous = dashboard({
      mentioned: [
        mrItem('1', { mentionCount: 1, mentionedAt: '2026-03-10T10:00:00Z' }),
        mrItem('4', { mentionCount: 1, mentionedAt: '2026-03-10T10:00:00Z' }),
      ],
      threads: [mrItem('2', { threadsAwaitingReply: 1 }), mrItem('3', { threadsAwaitingReply: 2 })],
    });
    const next = dashboard({
      mentioned: [
        mrItem('1', { mentionCount: 2, mentionedAt: '2026-03-10T10:00:00Z' }),
        mrItem('4', { mentionCount: 1, mentionedAt: '2026-03-10T12:00:00Z' }),
      ],
      threads: [mrItem('2', { threadsAwaitingReply: 2 }), mrItem('3', { threadsAwaitingReply: 1 })],
    });
    assert.deepEqual(changes(previous, next), ['mention:1', 'mention:4', 'thread:2']);
  });

  it('reports a newly failed pipeline and an MR that became mergeable', () => {
    const failed = (id, extra = {}) => ({ status: 'failed', id, onlyIgnoredFailures: false, ...extra });
    const previous = dashboard({
      authored: [
        mrItem('1', { pipeline: { status: 'running', id: 1 } }),
        mrItem('2', { pipeline: failed(2) }),
        mrItem('3', { pipeline: failed(3) }),
        mrItem('4', { status: 'not_approved' }),
        mrItem('5', { status: 'mergeable' }),
      ],
    });
    const next = dashboard({
      authored: [
        mrItem('1', { pipeline: failed(1) }),
        mrItem('2', { pipeline: failed(2) }),
        mrItem('3', { pipeline: failed(30) }),
        mrItem('4', { status: 'mergeable' }),
        mrItem('5', { status: 'mergeable' }),
        mrItem('6', { pipeline: failed(6, { onlyIgnoredFailures: true }) }),
        mrItem('7', { status: 'mergeable' }),
      ],
    });
    assert.deepEqual(changes(previous, next), [
      'ciFailed:1',
      'ciFailed:3',
      'mergeable:4',
    ]);
  });

  it('reports a default branch that turned red', () => {
    const branch = (key) => ({
      key,
      title: `group/${key}`,
      webUrl: `${BASE_URL}/group/${key}/-/pipelines/1`,
      updatedAt: 't',
    });
    const previous = dashboard({ brokenBranches: [branch('a')] });
    const next = dashboard({ brokenBranches: [branch('a'), branch('b')] });
    assert.deepEqual(changes(previous, next), ['branchBroken:b']);
    assert.deepEqual(changes({ ...previous, defaultBranchesUnavailable: true }, next), []);
  });

  it('stays silent about snoozed MRs, including when the snooze expires', () => {
    const userState = { snoozed: { 2: { until: '2026-03-10T16:00:00' }, 3: { until: '2026-03-10T14:00:00' } } };
    const previous = dashboard({ reviewing: [mrItem('3')] });
    const next = dashboard({ reviewing: [mrItem('2'), mrItem('3')] });
    assert.deepEqual(changes(previous, next, userState), []);
  });

  it('compares an MR snoozed until change with its real previous state', () => {
    const userState = { snoozed: { 1: { updatedAt: '2026-03-10T10:00:00Z' }, 2: { updatedAt: '2026-03-10T10:00:00Z' } } };
    const failed = { status: 'failed', id: 1, onlyIgnoredFailures: false };
    const previous = dashboard({ authored: [mrItem('1', { pipeline: failed })], awaitingApproval: [mrItem('2')] });
    const next = dashboard({
      authored: [mrItem('1', { pipeline: failed, updatedAt: '2026-03-10T11:00:00Z' })],
      awaitingApproval: [mrItem('2', { updatedAt: '2026-03-10T11:00:00Z' })],
    });
    assert.deepEqual(changes(previous, next, userState), []);
  });

  it('skips rules whose source was unavailable on either side', () => {
    const failed = { status: 'failed', id: 1, onlyIgnoredFailures: false };
    const previous = dashboard(
      { authored: [mrItem('1', { pipeline: null })] },
      { pipelinesUnavailable: true, mentionsUnavailable: true },
    );
    const next = dashboard({ authored: [mrItem('1', { pipeline: failed })], mentioned: [mrItem('2', { mentionCount: 1 })] });
    assert.deepEqual(changes(previous, next), []);
  });

  it('reports only changes of known MRs after an incomplete refresh', () => {
    const previous = dashboard({ threads: [mrItem('1', { threadsAwaitingReply: 1 })] }, { skippedMrs: 1 });
    const next = dashboard({
      reviewing: [mrItem('2')],
      threads: [mrItem('1', { threadsAwaitingReply: 2 }), mrItem('3', { threadsAwaitingReply: 1 })],
    });
    assert.deepEqual(changes(previous, next), ['thread:1']);
  });

  it('stays silent on the first refresh and when the user, instance or filters change', () => {
    const next = dashboard({ reviewing: [mrItem('1')] });
    assert.deepEqual(changes(undefined, next), []);
    assert.deepEqual(changes({ error: 'x' }, next), []);
    assert.deepEqual(changes(dashboard({}, { username: 'other' }), next), []);
    assert.deepEqual(changes(dashboard({}, { baseUrl: 'https://other.example.com' }), next), []);
    assert.deepEqual(changes(dashboard({}, { filters: { selectedProjectIds: [1] } }), next), []);
  });
});

describe('formatNotification', () => {
  const events = [
    { type: 'review', item: mrItem('1') },
    { type: 'review', item: mrItem('2') },
    { type: 'mention', item: mrItem('3', { mentionUrl: `${BASE_URL}/x#note_1` }) },
  ];

  it('hides MR titles unless details are enabled', () => {
    const notification = formatNotification(events, { showDetails: false, iconUrl: 'icon.png' });
    assert.equal(notification.type, 'basic');
    assert.equal(notification.message, 'на ревью: 2 · упоминаний: 1');
    assert.ok(!JSON.stringify(notification).includes('MR 1'));
    assert.equal(notification.priority, 1);
  });

  it('lists MR titles when details are enabled', () => {
    const notification = formatNotification(events, { showDetails: true, iconUrl: 'icon.png' });
    assert.equal(notification.type, 'list');
    assert.deepEqual(notification.items[2], { title: 'Упоминание', message: 'MR 3' });
  });
});

describe('notificationTarget', () => {
  it('opens the MR, or the mention note, when the notification is about one MR', () => {
    assert.equal(notificationTarget([{ type: 'review', item: mrItem('1') }], BASE_URL), mrItem('1').webUrl);
    assert.equal(
      notificationTarget([{ type: 'mention', item: mrItem('1', { mentionUrl: `${BASE_URL}/x#note_1` }) }], BASE_URL),
      `${BASE_URL}/x#note_1`,
    );
  });

  it('has no single target for several MRs or links outside GitLab', () => {
    assert.equal(
      notificationTarget([{ type: 'review', item: mrItem('1') }, { type: 'review', item: mrItem('2') }], BASE_URL),
      null,
    );
    assert.equal(
      notificationTarget([{ type: 'review', item: mrItem('1', { webUrl: 'https://evil.example/x' }) }], BASE_URL),
      null,
    );
  });
});
