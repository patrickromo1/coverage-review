/** Safe, provider-independent categories; never carry provider messages or payloads. */
export type AgentFailureCode = 'authentication' | 'rate-limit' | 'provider-error' | 'refusal' | 'invalid-proposal' | 'budget-exhausted' | 'timeout';
export class AgentFailure extends Error {
  constructor(readonly code: AgentFailureCode) { super(`Review agent failed: ${code}.`); }
}
