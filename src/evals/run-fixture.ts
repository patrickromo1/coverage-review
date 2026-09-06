import { ScriptedReviewAgent } from '../agent/scripted-review-agent.js';
import type { ReviewAgentRequest, ReviewLimits } from '../agent/review-agent.js';
import type { EvidenceCollectorDependencies } from '../core/evidence/collect-evidence.js';
import { executeReview } from '../core/review/execute-review.js';

/** Offline fixture entrypoint uses the production executor and injected evidence adapters. */
export function runReviewFixture(fixture: {
  baseSha: string; headSha: string; dependencies: EvidenceCollectorDependencies;
  proposal: unknown | ((request: ReviewAgentRequest) => unknown | Promise<unknown>);
  limits?: Partial<ReviewLimits>;
}) {
  return executeReview(fixture.baseSha, fixture.headSha, fixture.dependencies, new ScriptedReviewAgent(fixture.proposal), fixture.limits);
}
