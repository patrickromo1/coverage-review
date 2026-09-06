import { expect, it, vi } from 'vitest';
import { ReviewResultSchema, type ReviewResult } from '../../src/core/review/result.js';
import { ReviewLimitsSchema } from '../../src/agent/review-agent.js';
import { checkConclusion, checkSummary, findingAnnotations, MAX_ANNOTATIONS_PER_REQUEST, MAX_TOTAL_ANNOTATIONS, publishCheck } from '../../src/github/checks.js';
import { GitHubReviewContextSchema, type GitHubClient } from '../../src/github/domain.js';

function result(verdict: ReviewResult['verdict'], analysisStatus: ReviewResult['analysisStatus'], count = 0): ReviewResult {
  return ReviewResultSchema.parse({ schemaVersion: '1', summary: 'SECRET model prose', verdict, analysisStatus,
    findings: Array.from({ length: count }, (_, index) => ({ file: 'new.ts', line: index + 1, side: index % 2 ? 'base' : 'head', severity: 'medium',
      description: 'SECRET source blob', existingCoverage: { status: 'none', description: 'SECRET', testFiles: [] },
      suggestedTestLevel: 'unit', reasoning: 'SECRET', suggestedTests: [{ description: 'SECRET', expectedOutcome: 'SECRET' }], evidenceRefs: ['ev1:' + 'a'.repeat(64)] })),
    scope: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), resolved: true, changedFiles: ['new.ts'], reviewedFiles: ['new.ts'] },
    limitations: analysisStatus === 'complete' ? [] : [{ code: 'coverage-uncertain', message: 'SECRET path' }], rejectedFindings: [], evidenceReferences: [],
    provenance: { executorVersion: '1', policyVersion: '1', evidenceSchemaVersion: '1', agentMode: 'scripted', executionMode: 'github', limits: ReviewLimitsSchema.parse({}) } });
}
const context = GitHubReviewContextSchema.parse({ kind: 'pull-request', eventName: 'pull_request', owner: 'octo', repository: 'repo', repositorySlug: 'octo/repo', pullRequestNumber: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), fork: false, safeToAnalyze: true });

it.each([
  ['adequate', 'complete', 'success'], ['needs-tests', 'complete', 'failure'], ['needs-review', 'complete', 'neutral'],
  ['adequate', 'partial', 'neutral'], ['adequate', 'failed', 'neutral'],
] as const)('maps %s/%s conservatively', (verdict, status, expected) => expect(checkConclusion(result(verdict, status))).toBe(expected));

it('maps only accepted findings and does not publish model-authored prose', () => {
  const value = result('needs-tests', 'complete', 1);
  value.rejectedFindings.push({ index: 3, reason: 'SECRET rejected' });
  const annotations = findingAnnotations(value);
  expect(annotations).toHaveLength(1);
  expect(annotations[0]).toMatchObject({ path: 'new.ts', start_line: 1, title: expect.stringContaining('head side') });
  expect(JSON.stringify({ annotations, summary: checkSummary(value) })).not.toContain('SECRET');
});

it('preserves base-side rename locations', () => {
  const value = result('needs-tests', 'complete', 1);
  value.findings[0]!.side = 'base';
  value.scope.files = [{ path: 'new.ts', previousPath: 'old.ts', status: 'renamed' }];
  expect(findingAnnotations(value)[0]).toMatchObject({ path: 'old.ts', title: expect.stringContaining('base side') });
});

it('batches annotations deterministically and keeps publishing failure separate', async () => {
  const client: GitHubClient = { getPullRequest: vi.fn(), compareCommits: vi.fn(),
    createCheckRun: vi.fn(async () => ({ id: 9 })), updateCheckRun: vi.fn(async () => undefined) };
  const review = result('needs-tests', 'complete', MAX_ANNOTATIONS_PER_REQUEST + 1);
  const before = structuredClone(review);
  expect(await publishCheck(client, context, review, new AbortController().signal)).toMatchObject({ status: 'published', annotationsPublished: 51 });
  expect(client.createCheckRun).toHaveBeenCalledOnce(); expect(client.updateCheckRun).toHaveBeenCalledOnce(); expect(review).toEqual(before);
  client.createCheckRun = vi.fn(async () => { throw new Error('Authorization: Bearer SECRET'); });
  expect(await publishCheck(client, context, review, new AbortController().signal)).toEqual({ status: 'failed', reason: 'api-error' });
  expect(review).toEqual(before);
});

it('caps annotations while retaining the complete result', async () => {
  const client: GitHubClient = { getPullRequest: vi.fn(), compareCommits: vi.fn(),
    createCheckRun: vi.fn(async () => ({ id: 10 })), updateCheckRun: vi.fn(async () => undefined) };
  const review = result('needs-tests', 'complete', MAX_TOTAL_ANNOTATIONS + 1);
  expect(await publishCheck(client, context, review, new AbortController().signal)).toMatchObject({
    status: 'published', annotationsPublished: MAX_TOTAL_ANNOTATIONS, annotationsTruncated: 1,
  });
  expect(review.findings).toHaveLength(MAX_TOTAL_ANNOTATIONS + 1);
});
