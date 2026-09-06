import { afterEach, expect, it, vi } from 'vitest';
import { OpenAIReviewAgent } from '../../src/agent/openai/openai-review-agent.js';
import { OpenAIProposalSchema, mapOpenAIProposal } from '../../src/agent/openai/schema.js';
import { ReviewLimitsSchema } from '../../src/agent/review-agent.js';
import { executeReview } from '../../src/core/review/execute-review.js';
import { AgentFailure } from '../../src/agent/failure.js';
import { runCli } from '../../src/cli/run.js';
import { dependencies, proposal } from '../helpers/review.js';
import { z } from 'zod';

afterEach(() => vi.unstubAllEnvs());
const wire = { schemaVersion: '1', summary: 'Review.', analysisStatus: 'complete', reviewedFiles: ['a.ts'], limitations: [], findings: [] };
it('passes explicit model, prompt, abort signal and bounded tools into the replaceable SDK seam', async () => {
  const execute = vi.fn(async (request) => {
    expect(request.config).toMatchObject({ model: 'test-model', maxTurns: 8, maxToolCalls: 30 });
    expect(request.instructions).toContain('untrusted');
    expect(request.input).not.toContain('/private/report');
    for (const kind of ['evidence', 'source', 'test']) await request.inspect({ kind, file: 'a.ts', side: 'head', testPath: kind === 'test' ? 'tests/unit/a.test.ts' : null, startLine: 1, lineCount: 200 });
    return { output: wire, usage: { inputTokens: 20, outputTokens: 10, requests: 1 } };
  });
  const agent = new OpenAIReviewAgent({ model: 'test-model' }, execute);
  const result = await executeReview('base', 'head', dependencies(), agent);
  expect(result.verdict).toBe('adequate'); expect(result.provenance.agentMode).toBe('provider');
  expect(agent.usage?.inputTokens).toBe(20); expect(execute.mock.calls[0]![0].signal.aborted).toBe(true);
});
it('uses a strict required-key wire schema and maps nullable lower-level reason explicitly', async () => {
  const json = z.toJSONSchema(OpenAIProposalSchema);
  expect(json.additionalProperties).toBe(false);
  const finding = await executeReview('base', 'head', dependencies(), { mode: 'scripted', propose: (request) => Promise.resolve(proposal(request, true)) });
  const input = { ...wire, findings: [{ ...finding.findings[0], lowerLevelReason: null }] };
  expect(mapOpenAIProposal(input, ReviewLimitsSchema.parse({})).findings[0]).not.toHaveProperty('lowerLevelReason');
  expect(() => mapOpenAIProposal({ ...wire, findings: [finding.findings[0]] }, ReviewLimitsSchema.parse({}))).toThrow();
  expect(() => mapOpenAIProposal({ ...input, verdict: 'adequate' }, ReviewLimitsSchema.parse({}))).toThrow();
});
it.each(['authentication', 'rate-limit', 'provider-error', 'refusal', 'budget-exhausted', 'timeout'] as const)('reports safe structured %s failures with no fallback', async (code) => {
  const run = vi.fn(async () => { throw new AgentFailure(code); });
  const result = await executeReview('base', 'head', dependencies(), new OpenAIReviewAgent({ model: 'test' }, run));
  expect(result.analysisStatus).toBe('failed'); expect(result.verdict).toBe('needs-review');
  expect(result.limitations.some((value) => value.code === code)).toBe(true); expect(run).toHaveBeenCalledTimes(1);
});
it('rejects invalid output and forged references in the shared executor', async () => {
  const deps = dependencies();
  const scripted = await executeReview('base', 'head', deps, { mode: 'scripted', propose: async (request) => proposal(request, true) });
  const bad = { ...wire, findings: [{ ...scripted.findings[0], lowerLevelReason: null, evidenceRefs: ['ev1:' + '0'.repeat(64)] }] };
  const result = await executeReview('base', 'head', deps, new OpenAIReviewAgent({ model: 'test' }, async () => ({ output: bad })));
  expect(result.findings).toHaveLength(0); expect(result.rejectedFindings).toHaveLength(1); expect(result.verdict).toBe('needs-review');
  for (const output of [null, { ...wire, summary: '' }, { ...wire, findings: [{ file: 'a.ts' }] }]) {
    const invalid = await executeReview('base', 'head', deps, new OpenAIReviewAgent({ model: 'test' }, async () => ({ output })));
    expect(invalid.analysisStatus).toBe('failed'); expect(invalid.limitations.at(-1)?.code).toBe('invalid-proposal');
  }
});
it('bounds output bytes and propagates the original deadline to SDK work', async () => {
  const output = await executeReview('base', 'head', dependencies(), new OpenAIReviewAgent({ model: 'test', maxOutputBytes: 1024 }, async () => ({ output: { ...wire, summary: 'x'.repeat(2000) } })));
  expect(output.limitations.at(-1)?.code).toBe('budget-exhausted');
  let signal: AbortSignal | undefined;
  const result = await executeReview('base', 'head', dependencies(), new OpenAIReviewAgent({ model: 'test' }, async (request) => {
    signal = request.signal;
    await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { output: wire };
  }), { timeoutMs: 20 });
  expect(signal?.aborted).toBe(true); expect(result.analysisStatus).toBe('failed'); expect(result.verdict).toBe('needs-review');
});
it('requires explicit live CLI mode and validates configuration before provider calls', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  const deps = dependencies(); const run = vi.fn(async () => ({ output: wire }));
  const prefix = ['--base', 'base', '--head', 'head'];
  for (const flags of [['--model', 'test'], ['--review'], ['--review', '--provider', 'other', '--model', 'test'],
    ['--review', '--provider', 'openai', '--model', 'test', '--max-turns', '0'],
    ['--review', '--provider', 'openai', '--model', 'test', '--evidence']]) {
    await expect(runCli([...prefix, ...flags], () => deps.diff, () => deps, run)).rejects.toThrow();
  }
  expect(await runCli(['--help'], () => deps.diff, () => deps, run)).toContain('--review'); expect(run).not.toHaveBeenCalled();
  const result = JSON.parse(await runCli([...prefix, '--review', '--provider', 'openai', '--model', 'test', '--json'], () => deps.diff, () => deps, run));
  expect(result.provenance.agentMode).toBe('provider'); expect(run).toHaveBeenCalledOnce();
});
