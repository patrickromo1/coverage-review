import { z } from 'zod';
import { assertRepositoryPath } from '../repository/repository.js';

const text = z.string().trim().min(1);
const path = z.string().min(1).refine((value) => {
  try { assertRepositoryPath(value); return true; } catch { return false; }
}, 'Expected a repository-relative path');
const testLevel = z.enum(['unit', 'integration', 'e2e']);

export const CoverageFindingSchema = z.strictObject({
  file: path,
  line: z.number().int().positive().optional(),
  side: z.enum(['base', 'head']).default('head'),
  severity: z.enum(['low', 'medium', 'high']),
  description: text,
  existingCoverage: z.strictObject({
    status: z.enum(['unknown', 'none', 'partial', 'covered']),
    description: text,
    testFiles: z.array(path),
  }),
  suggestedTestLevel: testLevel,
  reasoning: text,
  suggestedTests: z.array(z.strictObject({
    description: text,
    expectedOutcome: text,
  })).min(1),
});

export const CoverageReviewSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  summary: text,
  findings: z.array(CoverageFindingSchema),
  verdict: z.enum(['adequate', 'needs-tests', 'needs-review']),
});

export type CoverageFinding = z.infer<typeof CoverageFindingSchema>;
export type CoverageReview = z.infer<typeof CoverageReviewSchema>;
