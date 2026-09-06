import { z } from 'zod';
import type { ReviewAgent, ReviewAgentRequest } from '../review-agent.js';
import { AgentFailure } from '../failure.js';
import { EvidenceToolLimitsSchema } from '../../core/review/evidence-tools.js';
import { ReviewTrace } from '../../core/review/trace.js';
import { mapOpenAIProposal } from './schema.js';
import { REVIEW_INSTRUCTIONS } from './instructions.js';

export const OpenAIConfigSchema = EvidenceToolLimitsSchema.extend({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  maxTurns: z.number().int().min(1).max(30).default(8),
  maxOutputTokens: z.number().int().min(256).max(32_768).default(4096),
  maxOutputBytes: z.number().int().min(1024).max(1_048_576).default(262_144),
});
export type OpenAIConfig = z.infer<typeof OpenAIConfigSchema>;
export const UsageSchema = z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), requests: z.number().int().nonnegative() });
/** The only injectable provider execution seam. No SDK types cross it. */
export interface SdkExecutionRequest {
  config: OpenAIConfig; instructions: string; input: string; signal: AbortSignal;
  inspect: (args: unknown) => Promise<unknown>;
}
export type SdkExecute = (request: SdkExecutionRequest) => Promise<{ output: unknown; usage?: z.infer<typeof UsageSchema>; refused?: boolean }>;

export class OpenAIReviewAgent implements ReviewAgent {
  readonly mode = 'provider' as const;
  readonly config: OpenAIConfig;
  readonly evidenceLimits;
  usage: z.infer<typeof UsageSchema> | undefined;
  constructor(config: z.input<typeof OpenAIConfigSchema>, private readonly execute: SdkExecute,
    private readonly trace = new ReviewTrace()) {
    this.config = OpenAIConfigSchema.parse(config);
    this.evidenceLimits = EvidenceToolLimitsSchema.parse({ maxToolCalls: this.config.maxToolCalls,
      maxReadBytes: this.config.maxReadBytes, maxToolBytes: this.config.maxToolBytes, maxLines: this.config.maxLines });
  }
  async propose(request: ReviewAgentRequest): Promise<unknown> {
    const started = Date.now();
    this.usage = undefined;
    let status: 'ok' | 'error' = 'error';
    // Only the bounded manifest is initially sent, not the full collected evidence/report paths.
    const input = JSON.stringify({ files: request.evidence.files.map(({ path }) => path), limits: request.limits });
    try {
      if (request.signal.aborted) throw new AgentFailure('timeout');
      if (!request.tools) throw new AgentFailure('provider-error');
      if (Buffer.byteLength(input) > this.config.maxToolBytes) throw new AgentFailure('budget-exhausted');
      const response = await this.execute({ config: this.config, instructions: REVIEW_INSTRUCTIONS, input,
        signal: request.signal, inspect: (args) => request.tools!.inspect(args) });
      if (request.signal.aborted) throw new AgentFailure('timeout');
      if (response.usage) this.usage = UsageSchema.parse(response.usage);
      if (response.refused) throw new AgentFailure('refusal');
      if (Buffer.byteLength(JSON.stringify(response.output) ?? '') > this.config.maxOutputBytes) throw new AgentFailure('budget-exhausted');
      const proposal = mapOpenAIProposal(response.output, request.limits);
      status = 'ok';
      return proposal;
    } catch (error) {
      if (error instanceof AgentFailure) throw error;
      if (request.signal.aborted) throw new AgentFailure('timeout');
      if (error instanceof z.ZodError) throw new AgentFailure('invalid-proposal');
      throw new AgentFailure('provider-error');
    } finally { await this.trace.emit('provider', started, status, this.usage ?? {}, input); }
  }
}
