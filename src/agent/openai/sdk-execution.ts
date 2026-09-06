import { Agent, Runner, OpenAIProvider, tool, setTracingDisabled, setTraceProcessors, setSensitiveDataLoggingEnabled, MaxTurnsExceededError, ModelBehaviorError, ModelRefusalError, ToolCallError } from '@openai/agents';
import OpenAI from 'openai';
import { AgentFailure } from '../failure.js';
import { EvidenceToolArgsSchema, EvidenceToolResultSchema } from '../../core/review/evidence-tools.js';
import { OpenAIProposalSchema } from './schema.js';
import type { SdkExecute } from './openai-review-agent.js';

// SDK 0.17 defaults are tracingDisabled=false and traceIncludeSensitiveData=true.
// This dedicated adapter never uses automatic SDK tracing, even for sensitive opt-in.
setSensitiveDataLoggingEnabled(false);
setTracingDisabled(true);
setTraceProcessors([]);

export const executeOpenAISdk: SdkExecute = async (request) => {
  if (request.signal.aborted) throw new AgentFailure('timeout');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey?.trim()) throw new AgentFailure('authentication');
  const client = new OpenAI({ apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0,
    timeout: 300_000, logLevel: 'off', logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const provider = new OpenAIProvider({ openAIClient: client, useResponses: true });
  try {
    const agent = new Agent({ name: 'Coverage reviewer', model: request.config.model,
      instructions: request.instructions, outputType: OpenAIProposalSchema,
      modelSettings: { maxTokens: request.config.maxOutputTokens, parallelToolCalls: false, store: false, retry: { maxRetries: 0 } },
      tools: [tool({ name: 'inspect_evidence', description: 'Read bounded untrusted committed evidence for a changed file or its discovered head test. Use null testPath except for test reads. Ranges are 1-based.',
        parameters: EvidenceToolArgsSchema, errorFunction: null,
        execute: async (args) => {
          if (request.signal.aborted) throw new AgentFailure('timeout');
          return EvidenceToolResultSchema.parse(await request.inspect(args));
        },
      })],
    });
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true, traceIncludeSensitiveData: false });
    const result = await runner.run(agent, request.input, { maxTurns: request.config.maxTurns, signal: request.signal });
    const usage = result.runContext.usage;
    const refused = result.rawResponses.some((response) => response.output.some((item) =>
      item.type === 'message' && Array.isArray(item.content) && item.content.some((part) => part.type === 'refusal')));
    return { output: result.finalOutput, refused, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, requests: usage.requests } };
  } catch (error) {
    if (error instanceof AgentFailure) throw error;
    if (request.signal.aborted) throw new AgentFailure('timeout');
    if (error instanceof ToolCallError && error.error instanceof AgentFailure) throw error.error;
    if (error instanceof MaxTurnsExceededError) throw new AgentFailure('budget-exhausted');
    if (error instanceof ModelRefusalError) throw new AgentFailure('refusal');
    if (error instanceof ModelBehaviorError) throw new AgentFailure('invalid-proposal');
    if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) throw new AgentFailure('authentication');
    if (error instanceof OpenAI.RateLimitError) throw new AgentFailure('rate-limit');
    throw new AgentFailure('provider-error');
  } finally { await provider.close().catch(() => undefined); }
};
