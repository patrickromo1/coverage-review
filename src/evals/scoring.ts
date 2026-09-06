import { z } from 'zod';
import type { ReviewResult } from '../core/review/result.js';

export const ExpectedBehaviorSchema = z.strictObject({
  id: z.string().min(1), missing: z.boolean(), file: z.string().min(1),
  side: z.enum(['base', 'head']), startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  // All groups must occur, with at least one literal phrase from each group.
  terms: z.array(z.array(z.string().min(1)).min(1)).min(1),
  acceptableLevels: z.array(z.enum(['unit', 'integration', 'e2e'])).min(1),
}).refine((value) => value.endLine >= value.startLine);
export type ExpectedBehavior = z.infer<typeof ExpectedBehaviorSchema>;
type Finding = ReviewResult['findings'][number];
const inLocation = (finding: Finding, behavior: ExpectedBehavior) => finding.file === behavior.file && finding.side === behavior.side && finding.line >= behavior.startLine && finding.line <= behavior.endLine;
function matches(finding: Finding, behavior: ExpectedBehavior) {
  const text = [finding.description, finding.reasoning, ...finding.suggestedTests.flatMap((test) => [test.description, test.expectedOutcome])].join(' ').toLowerCase();
  return inLocation(finding, behavior) && behavior.terms.every((group) => group.some((term) => text.includes(term.toLowerCase())));
}
export interface ScoreCounts {
  truePositives: number; falsePositives: number; falseNegatives: number;
  negativeOpportunities: number; falseAlarms: number; trueNegatives: number; unresolvedNegatives: number;
  correctLevels: number;
}
export function metrics(counts: ScoreCounts) {
  const ratio = (n: number, d: number) => d === 0 ? null : n / d;
  return { ...counts, precision: ratio(counts.truePositives, counts.truePositives + counts.falsePositives),
    recall: ratio(counts.truePositives, counts.truePositives + counts.falseNegatives),
    falsePositiveRate: ratio(counts.falseAlarms, counts.negativeOpportunities),
    falseNegativeRate: ratio(counts.falseNegatives, counts.truePositives + counts.falseNegatives),
    testLevelAccuracy: ratio(counts.correctLevels, counts.truePositives) };
}
export function scoreReview(result: ReviewResult, rawExpected: ExpectedBehavior[]) {
  const expected = z.array(ExpectedBehaviorSchema).parse(rawExpected);
  if (new Set(expected.map((value) => value.id)).size !== expected.length) throw new Error('Duplicate behavior identifier');
  const positives = expected.filter((value) => value.missing);
  const negatives = expected.filter((value) => !value.missing);
  // Maximum cardinality bipartite matching, deterministic input order; each finding and behavior used once.
  const assigned = new Map<number, number>();
  function assign(findingIndex: number, visited: Set<number>): boolean {
    for (let index = 0; index < positives.length; index++) {
      if (visited.has(index) || !matches(result.findings[findingIndex]!, positives[index]!)) continue;
      visited.add(index);
      const previous = assigned.get(index);
      if (previous === undefined || assign(previous, visited)) { assigned.set(index, findingIndex); return true; }
    }
    return false;
  }
  result.findings.forEach((_finding, index) => assign(index, new Set()));
  const falseAlarms = negatives.filter((negative) => result.findings.some((finding) => inLocation(finding, negative))).length;
  const remainingNegatives = negatives.length - falseAlarms;
  return { ...metrics({ truePositives: assigned.size, falsePositives: result.findings.length - assigned.size,
    falseNegatives: positives.length - assigned.size, negativeOpportunities: negatives.length, falseAlarms,
    trueNegatives: result.analysisStatus === 'complete' ? remainingNegatives : 0,
    unresolvedNegatives: result.analysisStatus === 'complete' ? 0 : remainingNegatives,
    correctLevels: [...assigned].filter(([behavior, finding]) => positives[behavior]!.acceptableLevels.includes(result.findings[finding]!.suggestedTestLevel)).length,
  }), matches: [...assigned].map(([behavior, finding]) => ({ behaviorId: positives[behavior]!.id, findingIndex: finding })),
    rejectedFindings: result.rejectedFindings.length, analysisStatus: result.analysisStatus, verdict: result.verdict };
}
export function aggregateScores(scores: ReturnType<typeof scoreReview>[]) {
  const counts: ScoreCounts = { truePositives: 0, falsePositives: 0, falseNegatives: 0, negativeOpportunities: 0, falseAlarms: 0, trueNegatives: 0, unresolvedNegatives: 0, correctLevels: 0 };
  for (const score of scores) for (const key of Object.keys(counts) as (keyof ScoreCounts)[]) counts[key] += score[key];
  return { ...metrics(counts), runs: scores.length,
    failedRuns: scores.filter((score) => score.analysisStatus === 'failed').length,
    partialRuns: scores.filter((score) => score.analysisStatus === 'partial').length,
    rejectedFindings: scores.reduce((sum, score) => sum + score.rejectedFindings, 0),
    verdicts: Object.fromEntries(['adequate', 'needs-review', 'needs-tests'].map((verdict) => [verdict, scores.filter((score) => score.verdict === verdict).length])) };
}
