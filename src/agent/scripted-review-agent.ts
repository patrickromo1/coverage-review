import type { ReviewAgent, ReviewAgentRequest } from './review-agent.js';

/** Explicit offline data or script; deliberately permits malformed output for failure fixtures. */
export class ScriptedReviewAgent implements ReviewAgent {
  readonly mode = 'scripted' as const;
  constructor(private readonly script: unknown | ((request: ReviewAgentRequest) => unknown | Promise<unknown>)) {}
  async propose(request: ReviewAgentRequest): Promise<unknown> {
    return typeof this.script === 'function' ? this.script(request) : structuredClone(this.script);
  }
}
