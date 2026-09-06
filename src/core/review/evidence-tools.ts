import { z } from 'zod';
import type { CoverageEvidence } from '../evidence/schema.js';
import { assertRepositoryPath, type Repository } from '../repository/repository.js';
import type { EvidenceReference } from './references.js';
import { AgentFailure } from '../../agent/failure.js';

export const EvidenceToolLimitsSchema = z.strictObject({
  maxToolCalls: z.number().int().min(1).max(200).default(30),
  maxReadBytes: z.number().int().min(1024).max(16_777_216).default(2_097_152),
  maxToolBytes: z.number().int().min(1024).max(262_144).default(32_768),
  maxLines: z.number().int().min(1).max(1000).default(200),
});
export type EvidenceToolLimits = z.infer<typeof EvidenceToolLimitsSchema>;
export const EvidenceToolArgsSchema = z.strictObject({
  kind: z.enum(['evidence', 'diff', 'source', 'test']),
  file: z.string().min(1).max(4096),
  side: z.enum(['base', 'head']),
  testPath: z.string().max(4096).nullable(),
  startLine: z.number().int().positive(),
  lineCount: z.number().int().positive().max(1000),
});
export const EvidenceToolResultSchema = z.strictObject({
  status: z.enum(['available', 'missing', 'binary', 'unsupported', 'truncated', 'unavailable']),
  content: z.string(),
  references: z.array(z.string().regex(/^ev1:[a-f0-9]{64}$/)).max(4),
});
export type EvidenceToolResult = z.infer<typeof EvidenceToolResultSchema>;
export interface EvidenceTools { inspect(args: unknown): Promise<EvidenceToolResult> }

/** Fixed executor-owned scope. No new references are minted by tool reads. */
export function createEvidenceTools(evidence: CoverageEvidence, refs: readonly EvidenceReference[], repository: Repository,
  signal: AbortSignal, options: Partial<EvidenceToolLimits> = {}) {
  const limits = EvidenceToolLimitsSchema.parse(options);
  let calls = 0;
  let bytes = 0;
  let closed = false;
  let incomplete = false;
  const inspected = new Set<string>();
  const check = () => { if (closed || signal.aborted) throw new AgentFailure('timeout'); };
  const tools: EvidenceTools = {
    async inspect(raw) {
      check();
      if (++calls > limits.maxToolCalls) { incomplete = true; throw new AgentFailure('budget-exhausted'); }
      const parsed = EvidenceToolArgsSchema.safeParse(raw);
      if (!parsed.success) { incomplete = true; throw new AgentFailure('invalid-proposal'); }
      const args = parsed.data;
      try { assertRepositoryPath(args.file); if (args.testPath !== null) assertRepositoryPath(args.testPath); }
      catch { incomplete = true; throw new AgentFailure('invalid-proposal'); }
      const file = evidence.files.find((entry) => entry.path === args.file);
      if (!file || args.lineCount > limits.maxLines || (args.kind !== 'test' && args.testPath !== null) ||
        (args.kind === 'test' && (args.side !== 'head' || !file.candidateTests.some((test) => test.path === args.testPath)))) {
        incomplete = true; throw new AgentFailure('invalid-proposal');
      }
      const kind = args.kind === 'test' ? 'tests' : args.kind;
      const references = refs.filter((ref) => ref.file === file.path && (kind === 'evidence' || ref.kind === kind)).map((ref) => ref.id);
      let status: EvidenceToolResult['status'] = 'available';
      let content: string;
      if (args.kind === 'evidence' || args.kind === 'diff') {
        // File-local evidence excludes the coverage report's absolute filesystem path.
        content = JSON.stringify(args.kind === 'diff' ? file.diff : { file, comparison: evidence.comparison,
          discovery: { status: evidence.testDiscovery.status, diagnosticCount: evidence.testDiscovery.diagnostics.length },
          coverageReport: { status: evidence.coverageReport.status, freshness: evidence.coverageReport.provenance?.freshness ?? null },
        });
        if (file.diff.status !== 'available') status = file.diff.status;
      } else {
        check();
        const path = args.kind === 'test' ? args.testPath! : args.side === 'base' ? file.previousPath ?? file.path : file.path;
        // Reserve before asynchronous IO, so concurrent invocations cannot oversubscribe the budget.
        if (bytes + limits.maxToolBytes * 2 > limits.maxReadBytes) { incomplete = true; throw new AgentFailure('budget-exhausted'); }
        bytes += limits.maxToolBytes;
        let read;
        try { read = await repository.readSource(args.side === 'base' ? evidence.comparison.baseSha : evidence.comparison.headSha, path, signal, limits.maxToolBytes); }
        catch { check(); read = { status: 'unavailable' as const }; }
        check();
        const valid = z.union([
          z.strictObject({ status: z.literal('available'), content: z.string() }),
          z.object({ status: z.enum(['missing', 'binary', 'unsupported', 'truncated', 'unavailable']) }),
        ]).safeParse(read);
        if (!valid.success) { incomplete = true; throw new AgentFailure('invalid-proposal'); }
        status = valid.data.status;
        content = valid.data.status === 'available' ? valid.data.content : `Committed evidence is ${status}.`;
        // Charge full blobs, including rereads, before slicing; concurrent calls share counters.
        if (Buffer.byteLength(content) > limits.maxToolBytes) { status = 'truncated'; content = 'Committed source exceeds read limit.'; }
        if (bytes > limits.maxReadBytes) { incomplete = true; throw new AgentFailure('budget-exhausted'); }
        if (status === 'available') {
          const lines = content.split('\n');
          if (args.startLine > lines.length) status = 'missing';
          else if (args.startLine !== 1 || args.lineCount < lines.length) status = 'truncated';
          content = lines.slice(args.startLine - 1, args.startLine - 1 + args.lineCount).map((line, index) => `${args.startLine + index}: ${line}`).join('\n');
        }
      }
      let result = EvidenceToolResultSchema.parse({ status, content, references });
      if (Buffer.byteLength(JSON.stringify(result)) > limits.maxToolBytes) result = { status: 'truncated', content: 'Evidence exceeds tool output limit; request a smaller source range.', references };
      bytes += Buffer.byteLength(JSON.stringify(result));
      if (bytes > limits.maxReadBytes) { incomplete = true; throw new AgentFailure('budget-exhausted'); }
      if (result.status !== 'available') incomplete = true;
      else inspected.add(`${file.path}:${args.kind === 'test' ? args.testPath : args.kind === 'source' ? `source:${args.side}` : args.kind}`);
      return EvidenceToolResultSchema.parse(result);
    },
  };
  return { tools, close: () => { closed = true; }, stats: () => ({ calls, bytes, incomplete, inspectionComplete: evidence.files.every((file) =>
    inspected.has(`${file.path}:evidence`) && inspected.has(`${file.path}:source:${file.source.side}`) &&
    file.candidateTests.every((test) => inspected.has(`${file.path}:${test.path}`))) }) };
}
