import { expect, it, vi } from 'vitest';
import { proposalSchema, ReviewLimitsSchema, ReviewProposalSchema, type ReviewAgentRequest } from '../../src/agent/review-agent.js';
import { ScriptedReviewAgent } from '../../src/agent/scripted-review-agent.js';
import { collectEvidence } from '../../src/core/evidence/collect-evidence.js';
import { executeReview } from '../../src/core/review/execute-review.js';
import { evidenceReferences } from '../../src/core/review/references.js';
import { evidenceLimitations, rejectionReason, verdictFor } from '../../src/core/review/policy.js';
import { ReviewResultSchema } from '../../src/core/review/result.js';
import { dependencies, proposal } from '../helpers/review.js';

async function request(): Promise<ReviewAgentRequest> {
  const evidence = await collectEvidence('base', 'head', dependencies());
  return { evidence, references: evidenceReferences(evidence), limits: ReviewLimitsSchema.parse({}), signal: new AbortController().signal };
}
it('separates strict proposals from verdicts and requires structured fields', async () => {
  const valid = proposal(await request(), true);
  expect(ReviewProposalSchema.safeParse(valid).success).toBe(true);
  for (const override of [{ verdict: 'adequate' }, { schemaVersion: '2' }, { summary: '' }, { analysisStatus: 'failed' }]) {
    expect(ReviewProposalSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  }
  for (const override of [{ file: '../escape' }, { line: 0 }, { line: 1.5 }, { side: 'worktree' }, { suggestedTestLevel: 'manual' }, { evidenceRefs: [] }]) {
    expect(ReviewProposalSchema.safeParse({ ...valid, findings: [{ ...valid.findings[0], ...override }] }).success).toBe(false);
  }
});
it('binds deterministic references to the comparison and fragment, without exporting source', async () => {
  const { evidence } = await request();
  const refs = evidenceReferences(evidence);
  expect(evidenceReferences(structuredClone(evidence))).toEqual(refs);
  evidence.comparison.headSha = 'other';
  expect(evidenceReferences(evidence).some((ref) => refs.some((old) => ref.id === old.id))).toBe(false);
  expect(JSON.stringify(refs)).not.toContain('export const');
});
it.each([
  { file: 'unchanged.ts' }, { line: 2 }, { evidenceRefs: ['ev1:bad'] },
  { existingCoverage: { status: 'covered', description: 'Claim', testFiles: ['invented.test.ts'] } },
  { suggestedTestLevel: 'e2e' }, { suggestedTestLevel: 'integration' },
])('rejects unsupported findings without producing adequate: %j', async (override) => {
  const result = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent((req: ReviewAgentRequest) => {
    const value = proposal(req, true);
    return { ...value, findings: [{ ...value.findings[0], ...override }] };
  }));
  expect(result).toMatchObject({ verdict: 'needs-review', analysisStatus: 'partial', findings: [] });
  expect(result.rejectedFindings).toHaveLength(1);
});
it('validates rename paths, base/head locations, additions and deletions', async () => {
  const req = await request();
  const finding = proposal(req, true).findings[0]!;
  const file = req.evidence.files[0]!;
  file.status = 'renamed'; file.previousPath = 'old.ts';
  let refs = evidenceReferences(req.evidence);
  const ref = () => refs.filter((entry) => entry.kind === 'diff').map((entry) => entry.id);
  expect(rejectionReason({ ...finding, side: 'base', evidenceRefs: ref() }, req.evidence, refs)).toBeUndefined();
  expect(rejectionReason({ ...finding, file: 'old.ts', side: 'base', evidenceRefs: ref() }, req.evidence, refs)).toContain('changed file');
  file.status = 'added'; refs = evidenceReferences(req.evidence);
  expect(rejectionReason({ ...finding, side: 'base', evidenceRefs: ref() }, req.evidence, refs)).toContain('side');
  file.status = 'deleted'; refs = evidenceReferences(req.evidence);
  expect(rejectionReason({ ...finding, side: 'head', evidenceRefs: ref() }, req.evidence, refs)).toContain('side');
  expect(rejectionReason({ ...finding, side: 'base', evidenceRefs: ref() }, req.evidence, refs)).toBeUndefined();
});
it('rejects foreign-file and non-diff references', async () => {
  const req = await request();
  const finding = proposal(req, true).findings[0]!;
  expect(rejectionReason({ ...finding, evidenceRefs: req.references.filter((ref) => ref.kind === 'coverage').map((ref) => ref.id) }, req.evidence, req.references)).toContain('references');
  expect(rejectionReason(finding, req.evidence, req.references.map((ref) => ({ ...ref, file: 'other.ts' })))).toContain('references');
});
it.each(['low', 'medium', 'high'] as const)('accepts valid %s severity findings and derives needs-tests', async (severity) => {
  const result = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent((req: ReviewAgentRequest) => {
    const value = proposal(req, true); value.findings[0]!.severity = severity; return value;
  }));
  expect(result).toMatchObject({ verdict: 'needs-tests', analysisStatus: 'complete' });
  expect(result.findings).toHaveLength(1);
  expect(ReviewResultSchema.safeParse(result).success).toBe(true);
});
it('accepts a higher test level only with explicit lower-level reasoning', async () => {
  const req = await request();
  expect(rejectionReason({ ...proposal(req, true).findings[0]!, suggestedTestLevel: 'integration', lowerLevelReason: 'Requires interaction between modules.' }, req.evidence, req.references)).toBeUndefined();
});
it('covers every verdict transition', () => {
  for (const status of ['complete', 'partial', 'failed'] as const) {
    expect(verdictFor(1, status)).toBe('needs-tests');
    expect(verdictFor(0, status)).toBe(status === 'complete' ? 'adequate' : 'needs-review');
  }
});
it('allows adequate only for a complete proposal and sufficiently complete evidence', async () => {
  const result = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent(proposal));
  expect(result).toMatchObject({ verdict: 'adequate', analysisStatus: 'complete', limitations: [] });
  expect(JSON.stringify(result.provenance)).not.toContain('/private/report');
});
it.each([
  { analysisStatus: 'partial' }, { limitations: ['Budget exhausted'] },
  { reviewedFiles: [] }, { reviewedFiles: ['a.ts', 'a.ts'] }, { reviewedFiles: ['extra.ts'] },
])('treats incomplete scope and agent budgets as partial: %j', async (override) => {
  const result = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent((req: ReviewAgentRequest) => ({ ...proposal(req), ...override })));
  expect(result).toMatchObject({ verdict: 'needs-review', analysisStatus: 'partial' });
});
it.each([null, {}, { verdict: 'adequate' }, 'SECRET PROMPT'])('handles invalid output as a structured failure', async (value) => {
  const result = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent(value));
  expect(result).toMatchObject({ verdict: 'needs-review', analysisStatus: 'failed', limitations: [{ code: 'invalid-proposal' }] });
  expect(JSON.stringify(result)).not.toContain('SECRET');
});
it('distinguishes evidence failure from agent failure without leaking exceptions', async () => {
  const deps = dependencies();
  const failing = new ScriptedReviewAgent(() => { throw new Error('SECRET SOURCE'); });
  expect((await executeReview('base', 'head', deps, failing)).limitations).toContainEqual({ code: 'agent-failure', message: 'Agent execution failed.' });
  deps.diff.compare = async () => { throw new Error('SECRET SOURCE'); };
  const agent = { mode: 'scripted' as const, propose: vi.fn() };
  const result = await executeReview('base', 'head', deps, agent);
  expect(result).toMatchObject({ analysisStatus: 'failed', scope: { resolved: false } });
  expect(result.limitations[0]?.code).toBe('evidence-unavailable');
  expect(agent.propose).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('SECRET');
});
it('times out an agent, aborts its signal, and never returns adequate', async () => {
  let signal: AbortSignal | undefined;
  const result = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent((req: ReviewAgentRequest) => {
    signal = req.signal; return new Promise(() => {});
  }), { timeoutMs: 10 });
  expect(result).toMatchObject({ verdict: 'needs-review', analysisStatus: 'failed' });
  expect(result.limitations.at(-1)?.code).toBe('timeout');
  expect(signal?.aborted).toBe(true);
});
it('bounds evidence collection by the same executor deadline', async () => {
  const deps = dependencies(); deps.diff.compare = () => new Promise(() => {});
  const agent = { mode: 'scripted' as const, propose: vi.fn() };
  const result = await executeReview('base', 'head', deps, agent, { timeoutMs: 10 });
  expect(result.limitations.at(-1)?.code).toBe('timeout');
  expect(agent.propose).not.toHaveBeenCalled();
});
it('isolates authoritative evidence and limits from agent mutation', async () => {
  const result = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent((req: ReviewAgentRequest) => {
    const value = proposal(req, true);
    req.evidence.files[0]!.path = 'evil.ts'; req.limits.maxFindings = 1;
    return value;
  }));
  expect(result.verdict).toBe('needs-tests');
  expect(result.scope.changedFiles).toEqual(['a.ts']);
  expect(result.provenance.limits.maxFindings).toBe(50);
});
it('rejects finding and text overflows without silently truncating output', async () => {
  for (const limits of [{ maxFindings: 1 }, { maxTextLength: 5 }]) {
    const result = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent((req: ReviewAgentRequest) => {
      const value = proposal(req, true); value.findings.push(value.findings[0]!); return value;
    }), limits);
    expect(result).toMatchObject({ verdict: 'needs-review', analysisStatus: 'failed', findings: [] });
  }
  const valid = proposal(await request(), true);
  const schema = proposalSchema(ReviewLimitsSchema.parse({ maxTextLength: 100 }));
  for (const key of ['summary', 'reasoning', 'description'] as const) {
    const changed = structuredClone(valid);
    if (key === 'summary') changed.summary = 'x'.repeat(101);
    else changed.findings[0]![key] = 'x'.repeat(101);
    expect(schema.safeParse(changed).success).toBe(false);
  }
  const large = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent((req: ReviewAgentRequest) => ({ ...proposal(req), summary: 'x'.repeat(5_000) })), { maxTextLength: 6_000 });
  expect(large.analysisStatus).toBe('complete');
  await expect(executeReview('base', 'head', dependencies(), new ScriptedReviewAgent(valid), { timeoutMs: 0 })).rejects.toThrow();
});
it.each(['unavailable', 'unsupported', 'truncated'] as const)('treats %s reports as partial, retaining accepted findings', async (status) => {
  const deps = dependencies(); deps.coverage.getCoverage = async () => ({ status, reason: 'Unavailable fixture evidence' });
  for (const withFinding of [false, true]) {
    const result = await executeReview('base', 'head', deps, new ScriptedReviewAgent((req: ReviewAgentRequest) => proposal(req, withFinding)));
    expect(result.analysisStatus).toBe('partial');
    expect(result.verdict).toBe(withFinding ? 'needs-tests' : 'needs-review');
  }
});
it.each(['stale', 'unverifiable'] as const)('does not treat %s measurements as sufficient', async (freshness) => {
  const deps = dependencies(); const original = deps.coverage.getCoverage;
  deps.coverage.getCoverage = async (req) => {
    const value = await original(req);
    if (value.status === 'available') return { ...value, provenance: { ...value.provenance, freshness } };
    return value;
  };
  expect((await executeReview('base', 'head', deps, new ScriptedReviewAgent(proposal))).verdict).toBe('needs-review');
});
it.each(['missing', 'binary', 'truncated', 'unsupported'] as const)('does not accept adequate for %s source', async (status) => {
  const deps = dependencies(); deps.repository.readSource = async () => ({ status, reason: 'Fixture limitation' });
  expect((await executeReview('base', 'head', deps, new ScriptedReviewAgent(proposal))).analysisStatus).toBe('partial');
});
it.each(['unsupported', 'truncated'] as const)('does not accept adequate for %s diffs or discovery', async (status) => {
  const deps = dependencies(); deps.diff.getFileDiff = async () => { throw new Error(status); };
  expect((await executeReview('base', 'head', deps, new ScriptedReviewAgent(proposal))).analysisStatus).toBe('partial');
  const other = dependencies(); other.testDiscovery.discover = async () => ({ status, diagnostics: [], candidates: [] });
  expect((await executeReview('base', 'head', other, new ScriptedReviewAgent(proposal))).analysisStatus).toBe('partial');
});
it('marks missing file coverage, absent measurements, uncovered branches, unsupported languages and discovery diagnostics partial', async () => {
  const base = (await request()).evidence;
  for (let variant = 0; variant < 7; variant++) {
    const evidence = structuredClone(base); const file = evidence.files[0]!;
    if (variant === 0) file.coverage = { status: 'missing', reason: 'File omitted' };
    if (variant === 1) file.coverage = { status: 'measured', freshness: 'matching', lines: [], branches: [] };
    if (variant === 2 && file.coverage.status === 'measured') file.coverage.branches.push({ line: 1, block: '0', branch: '0', hits: null, covered: null });
    if (variant === 3) file.path = 'source.rs';
    if (variant === 4) evidence.testDiscovery.diagnostics.push('Could not read a test');
    if (variant === 5 && file.diff.status === 'available') file.diff.binary = true;
    if (variant === 6) file.candidateTests[0]!.level = 'e2e';
    expect(evidenceLimitations(evidence).length).toBeGreaterThan(0);
  }
});

it('reports invalid finding indices without echoing invalid fields', async () => {
  const result = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent((req: ReviewAgentRequest) => {
    const value = proposal(req, true);
    return { ...value, findings: [{ ...value.findings[0], file: '../SECRET', suggestedTestLevel: 'manual' }] };
  }));
  expect(result).toMatchObject({ verdict: 'needs-review', analysisStatus: 'failed', rejectedFindings: [{ index: 0 }] });
  expect(JSON.stringify(result)).not.toContain('SECRET');
});
it('does not treat partially measured changed-line ranges as complete', async () => {
  const req = await request();
  const file = req.evidence.files[0]!;
  if (file.diff.status === 'available') file.diff.headChangedLines = [{ start: 1, end: 2 }];
  expect(evidenceLimitations(req.evidence)).toContainEqual(expect.objectContaining({ code: 'coverage-uncertain' }));
});
it('rejects a finding on unavailable or binary diff evidence', async () => {
  const req = await request();
  const finding = proposal(req, true).findings[0]!;
  const file = req.evidence.files[0]!;
  if (file.diff.status === 'available') file.diff.binary = true;
  expect(rejectionReason(finding, req.evidence, req.references)).toContain('text diff');
  file.diff = { status: 'truncated', reason: 'Limit' };
  expect(rejectionReason(finding, req.evidence, req.references)).toContain('text diff');
});
it('rejects a response that returns synchronously after its deadline', async () => {
  const result = await executeReview('base', 'head', dependencies(), new ScriptedReviewAgent((req: ReviewAgentRequest) => {
    const stop = Date.now() + 20;
    while (Date.now() < stop) { /* Simulate a provider blocking the event loop. */ }
    return proposal(req);
  }), { timeoutMs: 10 });
  expect(result).toMatchObject({ verdict: 'needs-review', analysisStatus: 'failed' });
  expect(result.limitations.at(-1)?.code).toBe('timeout');
});
