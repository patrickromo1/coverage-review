import { afterEach, expect, it, vi } from 'vitest';
import { loadSemanticSuite, runSemanticSuite } from '../../src/evals/run-semantic.js';
import { semanticDependencies } from '../../src/evals/semantic-fixture.js';
import { aggregateScores, scoreReview, type ExpectedBehavior } from '../../src/evals/scoring.js';
import { executeReview } from '../../src/core/review/execute-review.js';
import { dependencies, proposal } from '../helpers/review.js';

afterEach(() => vi.unstubAllGlobals());
const behavior: ExpectedBehavior = { id: 'boundary', missing: true, file: 'a.ts', side: 'head', startLine: 1, endLine: 1, terms: [['boundary']], acceptableLevels: ['unit'] };
async function result() { return executeReview('base', 'head', dependencies(), { mode: 'scripted', propose: async (request) => proposal(request, true) }); }
it('matches one-to-one, penalizes duplicates, and scores level separately', async () => {
  const review = await result();
  review.findings.push(structuredClone(review.findings[0]!));
  const score = scoreReview(review, [behavior]);
  expect(score).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 0, precision: 0.5, recall: 1, testLevelAccuracy: 1, falsePositiveRate: null });
  review.findings = [review.findings[0]!]; review.findings[0]!.suggestedTestLevel = 'e2e';
  expect(scoreReview(review, [behavior])).toMatchObject({ truePositives: 1, testLevelAccuracy: 0 });
});
it('uses maximum matching when constraints overlap', async () => {
  const review = await result();
  review.findings.push({ ...review.findings[0]!, description: 'Other behavior', reasoning: 'Other', suggestedTests: [{ description: 'Other', expectedOutcome: 'Other' }] });
  const broad = { ...behavior, id: 'broad', terms: [['boundary', 'other']] };
  expect(scoreReview(review, [broad, behavior]).truePositives).toBe(2);
});
it('uses predefined negative opportunities for FPR, preserves failed runs, and defines zero denominators', async () => {
  const review = await result();
  const negative = { ...behavior, id: 'cosmetic', missing: false };
  expect(scoreReview(review, [negative])).toMatchObject({ falsePositiveRate: 1, falsePositives: 1, recall: null });
  review.findings = []; review.analysisStatus = 'failed'; review.verdict = 'needs-review';
  const failed = scoreReview(review, [behavior, { ...negative, file: 'b.ts' }]);
  expect(failed).toMatchObject({ recall: 0, precision: null, falseNegativeRate: 1, unresolvedNegatives: 1, trueNegatives: 0 });
  expect(aggregateScores([failed])).toMatchObject({ failedRuns: 1, falseNegatives: 1, runs: 1 });
  expect(scoreReview(review, [])).toMatchObject({ precision: null, recall: null, falsePositiveRate: null, falseNegativeRate: null, testLevelAccuracy: null });
});
it('runs all offline semantic fixtures without network and retains conservative uncertainty verdicts', async () => {
  const fetch = vi.fn(() => { throw new Error('Network forbidden'); }); vi.stubGlobal('fetch', fetch);
  const suite = await loadSemanticSuite();
  const report = await runSemanticSuite(suite, { ids: suite.fixtures.map((fixture) => fixture.id), repeats: 1, concurrency: 2, mode: 'offline' });
  expect(report.aggregate).toMatchObject({ runs: 13, truePositives: 6, falsePositives: 0, falseNegatives: 0, partialRuns: 6 });
  expect(report.cases.find((entry) => entry.fixtureId === 'missing-evidence')?.result.verdict).toBe('needs-review');
  expect(fetch).not.toHaveBeenCalled();
});
it('never exposes annotations or other fixtures through snapshots and bounds live selection', async () => {
  const suite = await loadSemanticSuite();
  const fixture = suite.fixtures[0]!;
  const { dependencies: deps, headSha } = semanticDependencies(fixture);
  expect(await deps.repository.readSource(headSha, 'expected.json')).toMatchObject({ status: 'missing' });
  expect(await deps.repository.readSource(headSha, 'scripts.json')).toMatchObject({ status: 'missing' });
  await expect(deps.repository.readSource('main', fixture.sourcePath)).rejects.toThrow();
  await expect(runSemanticSuite(suite, { ids: [fixture.id], repeats: 6, concurrency: 1, mode: 'offline' })).rejects.toThrow();
  await expect(runSemanticSuite(suite, { ids: ['unknown'], repeats: 1, concurrency: 1, mode: 'offline' })).rejects.toThrow();
  const report = await runSemanticSuite(suite, { ids: [fixture.id], repeats: 2, concurrency: 1, mode: 'live', model: 'mock',
    createAgent: () => ({ mode: 'provider', propose: async () => { throw new Error('PRIVATE_FAILURE'); } }) });
  expect(report.aggregate).toMatchObject({ runs: 2, failedRuns: 2, falseNegatives: 2, recall: 0 });
  expect(JSON.stringify(report)).not.toContain('PRIVATE_FAILURE');
  const constructionFailure = await runSemanticSuite(suite, { ids: [fixture.id], repeats: 1, concurrency: 1, mode: 'live', model: 'mock',
    createAgent: () => { throw new Error('PRIVATE_CONSTRUCTION_FAILURE'); } });
  expect(constructionFailure.aggregate).toMatchObject({ runs: 1, failedRuns: 1, falseNegatives: 1 });
});
