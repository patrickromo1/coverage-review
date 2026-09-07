import { expect, it, vi } from 'vitest';
import { ReviewTrace, type TraceSpan } from '../../src/core/review/trace.js';
import { executeReview } from '../../src/core/review/execute-review.js';
import { OpenAIReviewAgent } from '../../src/agent/openai/openai-review-agent.js';
import { dependencies, proposal } from '../helpers/review.js';

it('exports nothing by default and excludes sensitive sentinel strings from metadata', async () => {
  const spans: TraceSpan[] = [];
  const trace = new ReviewTrace({ exportSpan: (span) => { spans.push(span); } });
  await trace.emit('provider', Date.now(), 'ok', { inputTokens: 5 }, 'PRIVATE_PROMPT_SOURCE_SECRET');
  const deps = dependencies();
  await executeReview('base', 'head', deps, { mode: 'scripted', propose: async (request) => ({ ...proposal(request), summary: 'PRIVATE_MODEL_OUTPUT' }) }, {}, trace);
  const serialized = JSON.stringify(spans);
  expect(serialized).not.toMatch(/PRIVATE|a\.ts|\/private\/report|export const/);
  expect(spans.map((span) => span.name)).toEqual(['provider', 'discovery', 'coverage', 'collection', 'evidence', 'agent', 'validation', 'review']);
  expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
});
it('requires a separate sensitive-content opt-in and makes exporter failure non-fatal', async () => {
  const exportSpan = vi.fn();
  await new ReviewTrace({ exportSpan, includeSensitiveContent: true }).emit('provider', Date.now(), 'ok', {}, 'EXPLICIT_SENSITIVE');
  expect(exportSpan.mock.calls[0]![0].sensitive).toBe('EXPLICIT_SENSITIVE');
  const trace = new ReviewTrace({ exportSpan: async () => { throw new Error('PRIVATE_EXPORT_ERROR'); } });
  const review = await executeReview('base', 'head', dependencies(), { mode: 'scripted', propose: async (request) => proposal(request) }, {}, trace);
  expect(review.verdict).toBe('adequate'); expect(JSON.stringify(review)).not.toContain('PRIVATE_EXPORT_ERROR');
});
it('records allowlisted provider usage without prompts, repository paths, or raw output', async () => {
  const exportSpan = vi.fn(); const trace = new ReviewTrace({ exportSpan });
  const agent = new OpenAIReviewAgent({ model: 'test' }, async () => ({ output: { schemaVersion: '1', summary: 'PRIVATE_MODEL', analysisStatus: 'partial', reviewedFiles: [], limitations: ['PRIVATE_LIMITATION'], findings: [] }, usage: { inputTokens: 2, outputTokens: 3, requests: 1 } }), trace);
  await executeReview('base', 'head', dependencies(), agent, {}, trace);
  expect(JSON.stringify(exportSpan.mock.calls)).not.toMatch(/PRIVATE|a\.ts|openai|source/i);
  expect(exportSpan.mock.calls.find(([span]) => span.name === 'provider')?.[0].attributes.inputTokens).toBe(2);
});
it('emits error spans for failed evidence and agent stages', async () => {
  const evidenceSpans: TraceSpan[] = [];
  const evidenceDependencies = dependencies();
  evidenceDependencies.diff.compare = async () => { throw new Error('PRIVATE_EVIDENCE_FAILURE'); };
  await executeReview('base', 'head', evidenceDependencies, { mode: 'scripted', propose: async () => { throw new Error('not reached'); } }, {},
    new ReviewTrace({ exportSpan: (span) => { evidenceSpans.push(span); } }));
  expect(evidenceSpans.map(({ name, status }) => [name, status])).toEqual([['evidence', 'error'], ['review', 'error']]);

  const agentSpans: TraceSpan[] = [];
  await executeReview('base', 'head', dependencies(), { mode: 'scripted', propose: async () => { throw new Error('PRIVATE_AGENT_FAILURE'); } }, {},
    new ReviewTrace({ exportSpan: (span) => { agentSpans.push(span); } }));
  expect(agentSpans.map(({ name, status }) => [name, status])).toEqual([['discovery', 'ok'], ['coverage', 'ok'], ['collection', 'ok'], ['evidence', 'ok'], ['agent', 'error'], ['review', 'error']]);
  expect(JSON.stringify([...evidenceSpans, ...agentSpans])).not.toContain('PRIVATE');
});
