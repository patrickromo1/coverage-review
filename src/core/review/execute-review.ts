import { ReviewTrace } from './trace.js';
import { AgentFailure } from '../../agent/failure.js';
import { createEvidenceTools } from './evidence-tools.js';
import { proposalSchema, ReviewLimitsSchema, type ReviewAgent, type ReviewLimits } from '../../agent/review-agent.js';
import { collectEvidence, type EvidenceCollectorDependencies } from '../evidence/collect-evidence.js';
import { evidenceLimitations, rejectionReason, verdictFor } from './policy.js';
import { evidenceReferences } from './references.js';
import { ReviewResultSchema, type ReviewResult } from './result.js';

class ReviewTimeout extends Error {}
async function withinDeadline<T>(operation: () => Promise<T>, remainingMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (remainingMs <= 0) { controller.abort(); throw new ReviewTimeout(); }
    const expiresAt = Date.now() + remainingMs;
    const value = await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ReviewTimeout()); }, Math.max(0, remainingMs));
      }),
    ]);
    if (Date.now() >= expiresAt) { controller.abort(); throw new ReviewTimeout(); }
    return value;
  } finally { clearTimeout(timer); }
}

export async function executeReview(
  baseSha: string, headSha: string, dependencies: EvidenceCollectorDependencies,
  agent: ReviewAgent, options: Partial<ReviewLimits> & { readonly executionMode?: 'local' | 'github' } = {}, trace = new ReviewTrace(),
): Promise<ReviewResult> {
  const { executionMode = 'local', ...limitOptions } = options;
  const limits = ReviewLimitsSchema.parse(limitOptions);
  const started = Date.now();
  const deadline = started + limits.timeoutMs;
  const controller = new AbortController();
  const result: ReviewResult = {
    schemaVersion: '1', summary: 'Review could not be completed.', findings: [], verdict: 'needs-review', analysisStatus: 'failed',
    scope: { baseSha, headSha, resolved: false, changedFiles: [], reviewedFiles: [], files: [] },
    limitations: [], rejectedFindings: [], evidenceReferences: [],
    provenance: { executorVersion: '1', policyVersion: '1', evidenceSchemaVersion: '1', agentMode: agent.mode, executionMode, limits },
  };
  let toolSession: ReturnType<typeof createEvidenceTools> | undefined;
  let stage: 'evidence' | 'agent' = 'evidence';
  try {
    const evidenceStarted = Date.now();
    let evidence;
    try {
      evidence = await withinDeadline(() => collectEvidence(baseSha, headSha, dependencies), deadline - Date.now(), controller);
      result.scope = { ...evidence.comparison, resolved: true, changedFiles: evidence.files.map((file) => file.path), reviewedFiles: [],
        files: evidence.files.map((file) => ({ path: file.path, status: file.status, ...(file.previousPath ? { previousPath: file.previousPath } : {}) })) };
      result.evidenceReferences = evidenceReferences(evidence);
      result.limitations = evidenceLimitations(evidence);
      await trace.emit('evidence', evidenceStarted, result.limitations.length ? 'partial' : 'ok', { files: evidence.files.length });
    } catch (error) {
      await trace.emit('evidence', evidenceStarted, 'error', { files: evidence?.files.length ?? 0 });
      throw error;
    }
    stage = 'agent';
    toolSession = createEvidenceTools(evidence, result.evidenceReferences, dependencies.repository, controller.signal, agent.evidenceLimits);
    const agentStarted = Date.now();
    let raw: unknown;
    try {
      raw = await withinDeadline(() => agent.propose({
        evidence: structuredClone(evidence), references: structuredClone(result.evidenceReferences), limits: { ...limits }, signal: controller.signal, tools: toolSession!.tools,
      }), deadline - Date.now(), controller);
      await trace.emit('agent', agentStarted, toolSession.stats().incomplete ? 'partial' : 'ok', { toolCalls: toolSession.stats().calls, readBytes: toolSession.stats().bytes });
    } catch (error) {
      await trace.emit('agent', agentStarted, 'error', { toolCalls: toolSession.stats().calls, readBytes: toolSession.stats().bytes });
      throw error;
    }
    if (agent.mode === 'provider' && !toolSession.stats().inspectionComplete) result.limitations.push({ code: 'agent-incomplete', message: 'Provider did not fully inspect changed-file evidence, source, and every discovered candidate test.' });
    if (toolSession.stats().incomplete) result.limitations.push({ code: 'evidence-incomplete', message: 'Tool inspection was unavailable, truncated, invalid, or exhausted a budget.' });
    const parsed = proposalSchema(limits).safeParse(raw);
    if (!parsed.success) {
      // Do not echo arbitrary provider text, source, exception messages, or prompts.
      result.rejectedFindings = [...new Set(parsed.error.issues.flatMap((issue) =>
        issue.path[0] === 'findings' && typeof issue.path[1] === 'number' ? [issue.path[1]] : [],
      ))].map((index) => ({ index, reason: 'Finding failed proposal schema validation; the entire proposal was rejected.' }));
      result.limitations.push({ code: 'invalid-proposal', message: 'Agent output failed proposal schema or configured limits; no findings were accepted.' });
      return ReviewResultSchema.parse(result);
    }
    const proposal = parsed.data;
    result.summary = proposal.summary;
    const changed = new Set(result.scope.changedFiles);
    const reviewed = new Set(proposal.reviewedFiles);
    result.scope.reviewedFiles = result.scope.changedFiles.filter((file) => reviewed.has(file));
    if (reviewed.size !== proposal.reviewedFiles.length || reviewed.size !== changed.size || [...reviewed].some((file) => !changed.has(file))) {
      result.limitations.push({ code: 'scope-incomplete', message: 'Proposal must account for every changed file exactly once without extra paths.' });
    }
    if (proposal.analysisStatus !== 'complete' || proposal.limitations.length) {
      result.limitations.push({ code: 'agent-incomplete', message: 'Agent reported incomplete analysis or limitations (including any exhausted budget).' });
    }
    proposal.findings.forEach((finding, index) => {
      const reason = rejectionReason(finding, evidence, result.evidenceReferences);
      if (reason) result.rejectedFindings.push({ index, reason });
      else result.findings.push(finding);
    });
    if (result.rejectedFindings.length) result.limitations.push({ code: 'finding-rejected', message: 'One or more proposed findings failed evidence or acceptance validation.' });
    result.analysisStatus = result.limitations.length ? 'partial' : 'complete';
    result.verdict = verdictFor(result.findings.length, result.analysisStatus);
  } catch (error) {
    result.limitations.push({
      code: error instanceof ReviewTimeout ? 'timeout' : stage === 'evidence' ? 'evidence-unavailable' : error instanceof AgentFailure ? error.code : 'agent-failure',
      message: error instanceof ReviewTimeout ? `Review deadline exceeded during ${stage}.` : `${stage === 'evidence' ? 'Evidence collection' : 'Agent execution'} failed.`,
    });
  } finally {
    controller.abort(); toolSession?.close();
    await trace.emit('review', started, result.analysisStatus === 'failed' ? 'error' : result.analysisStatus === 'partial' ? 'partial' : 'ok', { findings: result.findings.length, files: result.scope.changedFiles.length });
  }
  return ReviewResultSchema.parse(result);
}
