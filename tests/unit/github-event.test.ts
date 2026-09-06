import { expect, it } from 'vitest';
import { parseGitHubEvent } from '../../src/github/event.js';

const base = 'a'.repeat(40); const head = 'b'.repeat(40);
function payload(headRepository = 'octo/repo') {
  return { repository: { full_name: 'octo/repo', name: 'repo', owner: { login: 'octo' } }, number: 7,
    pull_request: { base: { sha: base, repo: { full_name: 'octo/repo' } }, head: { sha: head, repo: { full_name: headRepository } } } };
}

it('derives trusted PR commits and detects forks', () => {
  expect(parseGitHubEvent('pull_request', 'octo/repo', payload('contributor/repo'))).toMatchObject({
    kind: 'pull-request', pullRequestNumber: 7, baseSha: base, headSha: head, fork: true, safeToAnalyze: true,
  });
});

it('never treats pull_request_target as safe analysis', () => {
  expect(parseGitHubEvent('pull_request_target', 'octo/repo', payload())).toMatchObject({ kind: 'pull-request-target', safeToAnalyze: false });
});

it.each([
  ['workflow_dispatch', { repository: payload().repository }, 'manual'],
  ['merge_group', { repository: payload().repository, merge_group: { base_sha: base, head_sha: head } }, 'merge-group'],
  ['push', { repository: payload().repository }, 'unsupported'],
])('distinguishes %s events', (event, value, kind) => {
  expect(parseGitHubEvent(event, 'octo/repo', value)).toMatchObject({ kind, safeToAnalyze: false });
});

it('rejects repository mismatches and abbreviated SHAs', () => {
  expect(() => parseGitHubEvent('pull_request', 'evil/repo', payload())).toThrow(/does not match/);
  const value = payload(); value.pull_request.head.sha = 'abc';
  expect(() => parseGitHubEvent('pull_request', 'octo/repo', value)).toThrow();
});
