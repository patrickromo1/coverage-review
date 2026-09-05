import { expect, it } from 'vitest';
import { CoverageFindingSchema, CoverageReviewSchema } from '../../src/core/review/schema.js';

const finding = {
  file: 'src/validate.ts', line: 4, severity: 'medium', description: 'Missing boundary assertion',
  existingCoverage: { status: 'unknown', description: 'No report provided', testFiles: [] },
  suggestedTestLevel: 'unit', reasoning: 'Validation can be exercised in isolation',
  suggestedTests: [{ description: 'Reject an empty value', expectedOutcome: 'Returns a validation error' }],
};

it('accepts structured findings and all review verdicts', () => {
  expect(CoverageFindingSchema.parse(finding).side).toBe('head');
  for (const verdict of ['adequate', 'needs-tests', 'needs-review']) {
    expect(CoverageReviewSchema.safeParse({ schemaVersion: '1', summary: 'Review', findings: [], verdict }).success).toBe(true);
  }
});
it.each([
  { line: 0 }, { line: 1.5 }, { file: '../secret' }, { severity: 'critical' },
  { suggestedTestLevel: 'manual' }, { suggestedTests: [] }, { description: ' ' }, { extra: true },
])('rejects invalid finding fields %j', (override) => {
  expect(CoverageFindingSchema.safeParse({ ...finding, ...override }).success).toBe(false);
});
it('rejects unknown versions and malformed nested coverage', () => {
  expect(CoverageReviewSchema.safeParse({ schemaVersion: '2', summary: 'Review', findings: [], verdict: 'adequate' }).success).toBe(false);
  expect(CoverageFindingSchema.safeParse({ ...finding, existingCoverage: 'covered' }).success).toBe(false);
});
