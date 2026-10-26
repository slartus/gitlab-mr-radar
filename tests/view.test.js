import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { failureUrl, isHttpsUrl, isUnderBaseUrl } from '../src/links.js';
import { SECTION_IDS, deriveView } from '../src/view.js';

const BASE_URL = 'https://gitlab.example.com';

describe('deriveView', () => {
  it('counts unique MRs waiting for me and my failed pipelines', () => {
    const { counts } = deriveView({
      sections: {
        reviewing: [
          { key: 'a', approvedByMe: false, draft: false },
          { key: 'b', approvedByMe: true, draft: false },
          { key: 'c', approvedByMe: false, draft: true },
        ],
        mentioned: [{ key: 'd' }],
        awaitingApproval: [{ key: 'e' }],
        threads: [{ key: 'a' }, { key: 'f' }],
        authored: [
          { key: 'f', pipeline: { status: 'failed', onlyIgnoredFailures: false } },
          { key: 'g', pipeline: { status: 'failed', onlyIgnoredFailures: true } },
          { key: 'h', pipeline: { status: 'success' } },
          { key: 'i', pipeline: null },
        ],
      },
    });
    assert.deepEqual(counts, { waiting: 4, failedCi: 1 });
  });

  it('fills missing sections with empty lists', () => {
    const { sections, counts } = deriveView({ sections: { reviewing: [] } });
    assert.deepEqual(Object.keys(sections), SECTION_IDS);
    assert.ok(Object.values(sections).every((items) => items.length === 0));
    assert.deepEqual(counts, { waiting: 0, failedCi: 0 });
  });
});

describe('links', () => {
  it('accepts only https URLs', () => {
    assert.equal(isHttpsUrl('https://ci.example.com/job/1'), true);
    assert.equal(isHttpsUrl('http://ci.example.com/job/1'), false);
    assert.equal(isHttpsUrl('javascript:alert(1)'), false);
    assert.equal(isHttpsUrl('not a url'), false);
    assert.equal(isHttpsUrl(undefined), false);
  });

  it('keeps GitLab links inside the configured instance', () => {
    assert.equal(isUnderBaseUrl(`${BASE_URL}/group/project`, BASE_URL), true);
    assert.equal(isUnderBaseUrl(`${BASE_URL}.evil.com/x`, BASE_URL), false);
    assert.equal(isUnderBaseUrl(null, BASE_URL), false);
  });

  it('resolves failure links by kind', () => {
    assert.equal(failureUrl({ kind: 'job', webUrl: `${BASE_URL}/-/jobs/1` }, BASE_URL), `${BASE_URL}/-/jobs/1`);
    assert.equal(failureUrl({ kind: 'job', webUrl: 'https://evil.com/x' }, BASE_URL), BASE_URL);
    assert.equal(failureUrl({ kind: 'external', webUrl: 'https://jenkins.example.com/1' }, BASE_URL), 'https://jenkins.example.com/1');
    assert.equal(failureUrl({ kind: 'external', webUrl: 'http://jenkins.example.com/1' }, BASE_URL), null);
  });
});
