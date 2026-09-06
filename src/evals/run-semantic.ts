import { OpenAIConfigSchema, UsageSchema, type OpenAIConfig } from '../agent/openai/openai-review-agent.js';
import { AgentFailure } from '../agent/failure.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ReviewLimitsSchema, type ReviewAgent, type ReviewAgentRequest, type ReviewLimits } from '../agent/review-agent.js';
import { ScriptedReviewAgent } from '../agent/scripted-review-agent.js';
import { executeReview } from '../core/review/execute-review.js';
import { ExpectedBehaviorSchema, aggregateScores, scoreReview } from './scoring.js';
import { SemanticFixtureSchema, semanticDependencies } from './semantic-fixture.js';
import { PROMPT_VERSION } from '../agent/openai/instructions.js';

export async function loadSemanticSuite() {
  const root = new URL('../../evals/fixtures/semantic/v1/', import.meta.url);
  // Production build lives under dist/evals at the same relative depth.
  const read = async (name: string) => JSON.parse(await readFile(new URL(name, root), 'utf8')) as unknown;
  const fixtures = z.array(SemanticFixtureSchema).min(1).max(50).parse(await read('inputs.json'));
  const expected = z.record(z.string(), z.array(ExpectedBehaviorSchema)).parse(await read('expected.json'));
  const scripts = z.record(z.string(), z.array(z.strictObject({
    description: z.string(), reasoning: z.string(), expectedOutcome: z.string(),
    level: z.enum(['unit', 'integration', 'e2e']), lowerLevelReason: z.string().nullable(),
  }))).parse(await read('scripts.json'));
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length || fixtures.some((fixture) => !expected[fixture.id] || !scripts[fixture.id])) throw new Error('Incomplete semantic suite');
  return { fixtures, expected, scripts };
}
type Suite = Awaited<ReturnType<typeof loadSemanticSuite>>;
export function scriptedSemanticAgent(scripts: Suite['scripts'][string]): ReviewAgent {
  return new ScriptedReviewAgent((request: ReviewAgentRequest) => ({
    schemaVersion: '1', summary: 'Scripted semantic harness case; not model quality evidence.', analysisStatus: 'complete',
    reviewedFiles: request.evidence.files.map((file) => file.path), limitations: [],
    findings: scripts.map((script) => ({
      file: request.evidence.files[0]!.path, line: 1, side: 'head', severity: 'medium',
      description: script.description, reasoning: script.reasoning, suggestedTestLevel: script.level,
      existingCoverage: { status: 'partial', description: 'Candidate tests lack the relevant assertion.', testFiles: [] },
      suggestedTests: [{ description: script.description, expectedOutcome: script.expectedOutcome }],
      evidenceRefs: request.references.filter((ref) => ref.kind === 'diff').map((ref) => ref.id),
      ...(script.lowerLevelReason === null ? {} : { lowerLevelReason: script.lowerLevelReason }),
    })),
  }));
}
export async function runSemanticSuite(suite: Suite, options: {
  ids: string[]; repeats: number; concurrency: number; limits?: Partial<ReviewLimits>;
  mode: 'offline' | 'live'; model?: string; providerConfig?: OpenAIConfig;
  createAgent?: () => ReviewAgent & { usage?: unknown };
}) {
  const limits = ReviewLimitsSchema.parse(options.limits ?? {});
  const providerConfig = options.providerConfig ? OpenAIConfigSchema.parse(options.providerConfig) : null;
  z.enum(['offline', 'live']).parse(options.mode);
  z.array(z.string()).min(1).max(20).parse(options.ids);
  z.number().int().min(1).max(5).parse(options.repeats);
  z.number().int().min(1).max(4).parse(options.concurrency);
  if (new Set(options.ids).size !== options.ids.length || options.ids.some((id) => !suite.fixtures.some((fixture) => fixture.id === id))) throw new Error('Unknown or duplicate fixture selection');
  if (options.mode === 'live' && (!options.createAgent || !options.model)) throw new Error('Live eval needs explicit model and agent factory');
  const jobs = options.ids.flatMap((id) => Array.from({ length: options.repeats }, (_value, repeat) => ({ id, repeat })));
  const results = new Array<Awaited<ReturnType<typeof runCase>>>(jobs.length);
  async function runCase(job: { id: string; repeat: number }) {
    const fixture = suite.fixtures.find((entry) => entry.id === job.id)!;
    const { baseSha, headSha, dependencies } = semanticDependencies(fixture);
    let agent: ReviewAgent & { usage?: unknown };
    try { agent = options.mode === 'offline' ? scriptedSemanticAgent(suite.scripts[job.id]!) : options.createAgent!(); }
    catch { agent = { mode: 'provider', propose: async () => { throw new AgentFailure('provider-error'); } }; }
    const result = await executeReview(baseSha, headSha, dependencies, agent, { ...limits, ...(fixture.mode ? { reviewMode: fixture.mode } : {}) });
    return { fixtureId: job.id, fixtureVersion: fixture.version, repeat: job.repeat,
      model: options.mode === 'offline' ? null : options.model, promptVersion: PROMPT_VERSION, configurationVersion: '1',
      policyVersion: result.provenance.policyVersion, usage: UsageSchema.safeParse(agent.usage).data ?? null,
      result, score: scoreReview(result, suite.expected[job.id]!) };
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, async () => {
    while (next < jobs.length) { const index = next++; results[index] = await runCase(jobs[index]!); }
  }));
  return { schemaVersion: '1', mode: options.mode, configuration: { repeats: options.repeats, concurrency: options.concurrency, provider: providerConfig },
    qualityEvidence: options.mode === 'offline' ? 'Scripted harness validation only' : 'Measured live model results',
    cases: results, aggregate: aggregateScores(results.map((entry) => entry.score)) };
}
