import { ReviewRepository } from '../repository/review-repository.js';
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
  agent: ReviewAgent, options: Partial<ReviewLimits> & { readonly executionMode?: 'local' | 'github'; readonly reviewMode?: 'staged' | 'unstaged' } = {}, trace = new ReviewTrace(),
): Promise<ReviewResult> {
  const { executionMode = 'local', reviewMode, ...limitOptions } = options;
  const limits = ReviewLimitsSchema.parse(limitOptions);
  if (reviewMode && (!['staged', 'unstaged'].includes(reviewMode) || executionMode === 'github')) throw new Error('Invalid review mode for execution context');
  if (!reviewMode && (baseSha.startsWith('local:') || headSha.startsWith('local:'))) throw new Error('Local identities require explicit snapshot capture mode');
  dependencies = { ...dependencies, repository: new ReviewRepository(dependencies.repository, [baseSha, headSha]) };
  const started = Date.now();
  const deadline = started + limits.timeoutMs;
  const controller = new AbortController();
  const result: ReviewResult = {
    schemaVersion: reviewMode ? '2' : '1', summary: 'Review could not be completed.', findings: [], verdict: 'needs-review', analysisStatus: 'failed',
    scope: { baseSha, headSha, resolved: false, changedFiles: [], reviewedFiles: [], files: [] },
    limitations: [], rejectedFindings: [], evidenceReferences: [],
    provenance: { executorVersion: '2', policyVersion: '2', evidenceSchemaVersion: reviewMode ? '2' : '1', agentMode: agent.mode, executionMode, limits, ...(reviewMode ? { snapshotMode: reviewMode } : {}) },
  };
  let toolSession: ReturnType<typeof createEvidenceTools> | undefined;
  let stage: 'evidence' | 'agent' = 'evidence';
  try {
    const evidenceStarted = Date.now();
    let evidence;
    try {
      evidence = await withinDeadline(async () => {
        if (reviewMode) {
          if (!dependencies.captureLocal) throw new Error('Local capture adapter unavailable');
          const captured = await dependencies.captureLocal(reviewMode, controller.signal);
          if (!/^local:[a-f0-9]{64}$/.test(captured.headSha) || !(reviewMode === 'staged' ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/ : /^local:[a-f0-9]{64}$/).test(captured.baseSha)) throw new Error('Invalid captured snapshot identity');
          if (captured.metrics) await trace.emit('capture', evidenceStarted, 'ok', captured.metrics);
          baseSha = captured.baseSha; headSha = captured.headSha;
          dependencies = { ...dependencies, diff: captured.diff, repository: new ReviewRepository(captured.repository, [baseSha, headSha]) };
        }
        return collectEvidence(baseSha, headSha, dependencies, controller.signal, trace);
      }, deadline - Date.now(), controller);
      if (dependencies.repository instanceof ReviewRepository) await trace.emit('collection', evidenceStarted, dependencies.repository.stats().truncated ? 'partial' : 'ok', { ...dependencies.repository.stats(), requests: dependencies.diff.stats?.().requests ?? 0 });
      result.scope = { ...evidence.comparison, resolved: true, changedFiles: evidence.files.map((file) => file.path), reviewedFiles: [],
        evidenceScope: {
          collectedFiles: evidence.files.filter((file) => !(file.source.status === 'truncated' && file.source.reason === 'File omitted by collection budget')).map((file) => file.path),
          omittedFiles: evidence.files.filter((file) => file.source.status === 'truncated' && file.source.reason === 'File omitted by collection budget').map((file) => file.path),
          unavailableFiles: evidence.files.filter((file) => ['missing', 'unsupported'].includes(file.source.status) || file.diff.status === 'unsupported').map((file) => file.path),
          truncatedFiles: evidence.files.filter((file) => file.source.status === 'truncated' || file.diff.status === 'truncated').map((file) => file.path),
        },
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
    const validationStarted = Date.now();
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
    await trace.emit('validation', validationStarted, result.limitations.length ? 'partial' : 'ok', { findings: result.findings.length });
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
