import type { ReviewResult } from './result.js';

export function formatReviewJson(result: ReviewResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
export function formatReview(result: ReviewResult): string {
  return [
    `${result.provenance.agentMode === 'scripted' ? 'OFFLINE SCRIPTED REVIEW' : 'COVERAGE REVIEW'}: ${result.verdict} (${result.analysisStatus})`,
    result.summary,
    `Scope: ${result.scope.reviewedFiles.length}/${result.scope.changedFiles.length} changed files`,
    ...result.findings.map((finding) => `- [${finding.severity}] ${finding.file}:${finding.line} (${finding.side}): ${finding.description} [${finding.suggestedTestLevel}]`),
    ...result.limitations.map((limitation) => `! ${limitation.code}${limitation.file ? ` (${limitation.file})` : ''}: ${limitation.message}`),
    ...result.rejectedFindings.map((finding) => `! Rejected finding ${finding.index + 1}: ${finding.reason}`),
    '',
  ].join('\n');
}
