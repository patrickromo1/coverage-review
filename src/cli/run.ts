import { appendFile } from 'node:fs/promises';
import { OpenAIConfigSchema, OpenAIReviewAgent, type SdkExecute } from '../agent/openai/openai-review-agent.js';
import { ReviewTrace } from '../core/review/trace.js';
import { open } from 'node:fs/promises';
import { ScriptedReviewAgent } from '../agent/scripted-review-agent.js';
import { executeReview } from '../core/review/execute-review.js';
import { formatReview, formatReviewJson } from '../core/review/format-review.js';
import { parseArgs } from 'node:util';
import type { DiffProvider } from '../core/diff/diff-provider.js';
import { collectEvidence, type EvidenceCollectorDependencies } from '../core/evidence/collect-evidence.js';

export const usage = `Usage: coverage-review --base <SHA> --head <SHA> [--repo <path>] [--file <path>]
       coverage-review --base <SHA> --head <SHA> [--repo <path>] --evidence [--lcov <path>] [--coverage-commit <SHA>]

       coverage-review --base <SHA> --head <SHA> --offline-review <proposal.json> [--json] [--lcov <path>] [--coverage-commit <SHA>]
       coverage-review --base <SHA> --head <SHA> --review --provider openai --model <model-id> [--json]
       Provider limits: [--max-turns <n>] [--max-tool-calls <n>] [--max-read-bytes <n>] [--max-tool-bytes <n>] [--max-output-tokens <n>]
       Tracing: [--trace-file <jsonl>] [--trace-sensitive] (export disabled by default)
       Live review sends selected committed repository evidence to OpenAI; requires OPENAI_API_KEY.
       Review limits: [--max-findings <n>] [--max-text-length <n>] [--timeout-ms <n>]

Offline review replays a supplied scripted proposal; it does not perform model analysis.
Print changed files as JSON, a single file's patch with --file, or versioned JSON evidence with --evidence.
Requires full commit SHAs. Compares the two commits directly (no merge-base).
Evidence collection reads committed snapshots and never executes repository code or tests.
`;

export async function runCli(
  args: string[],
  createDiff: (root: string) => DiffProvider,
  createEvidence?: (options: { readonly root: string; readonly lcov?: string; readonly coverageCommit?: string }) => EvidenceCollectorDependencies,
  sdkExecute?: SdkExecute,
): Promise<string> {
  const { values } = parseArgs({
    args,
    options: {
      base: { type: 'string' }, head: { type: 'string' },
      repo: { type: 'string', default: '.' }, file: { type: 'string' },
      evidence: { type: 'boolean' }, lcov: { type: 'string' }, 'coverage-commit': { type: 'string' },
      'offline-review': { type: 'string' }, json: { type: 'boolean' },
      'max-findings': { type: 'string' }, 'max-text-length': { type: 'string' }, 'timeout-ms': { type: 'string' },
      review: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' },
      'max-turns': { type: 'string' }, 'max-tool-calls': { type: 'string' }, 'max-read-bytes': { type: 'string' },
      'max-tool-bytes': { type: 'string' }, 'max-output-tokens': { type: 'string' },
      'trace-file': { type: 'string' }, 'trace-sensitive': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return usage;
  if (!values.base || !values.head) throw new Error('Both --base and --head are required. Use --help for usage.');
  const live = !!values.review;
  const providerFlags = [values.provider, values.model, values['max-turns'], values['max-tool-calls'], values['max-read-bytes'], values['max-tool-bytes'], values['max-output-tokens']];
  if (!live && providerFlags.some((value) => value !== undefined)) throw new Error('Provider configuration requires explicit --review');
  if (live && (values.provider !== 'openai' || !values.model)) throw new Error('--review requires --provider openai and --model <model-id>');
  if (values['trace-sensitive'] && !values['trace-file']) throw new Error('--trace-sensitive requires --trace-file');
  const offline = values['offline-review'] !== undefined;
  if ([values.file !== undefined, !!values.evidence, offline, live].filter(Boolean).length > 1) throw new Error('--file, --evidence, --offline-review, and --review are mutually exclusive');
  if (!offline && !live && (values.json || values['max-findings'] !== undefined || values['max-text-length'] !== undefined || values['timeout-ms'] !== undefined)) throw new Error('Review formatting and limits require --offline-review');
  if ((values.lcov !== undefined || values['coverage-commit'] !== undefined) && !values.evidence && !offline && !live) {
    throw new Error('--lcov and --coverage-commit require --evidence or --offline-review');
  }
  if (values['trace-file'] && !offline && !live) throw new Error('Tracing requires a review mode');
  const config = live ? OpenAIConfigSchema.parse({ model: values.model,
    ...(values['max-turns'] === undefined ? {} : { maxTurns: Number(values['max-turns']) }),
    ...(values['max-tool-calls'] === undefined ? {} : { maxToolCalls: Number(values['max-tool-calls']) }),
    ...(values['max-read-bytes'] === undefined ? {} : { maxReadBytes: Number(values['max-read-bytes']) }),
    ...(values['max-tool-bytes'] === undefined ? {} : { maxToolBytes: Number(values['max-tool-bytes']) }),
    ...(values['max-output-tokens'] === undefined ? {} : { maxOutputTokens: Number(values['max-output-tokens']) }),
  }) : undefined;
  if (values.evidence || offline || live) {
    if (!createEvidence) throw new Error('Evidence mode is unavailable');
    const options = {
      root: values.repo,
      ...(values.lcov === undefined ? {} : { lcov: values.lcov }),
      ...(values['coverage-commit'] === undefined ? {} : { coverageCommit: values['coverage-commit'] }),
    };
    if (offline || live) {
      const trace = new ReviewTrace(values['trace-file'] ? { exportSpan: async (span) => { await appendFile(values['trace-file']!, `${JSON.stringify(span)}\n`, { mode: 0o600 }); }, includeSensitiveContent: !!values['trace-sensitive'] } : {});
      const agent = offline ? new ScriptedReviewAgent(await readScriptedProposal(values['offline-review']!))
        : new OpenAIReviewAgent(config!, sdkExecute ?? (async (request) => (await import('../agent/openai/sdk-execution.js')).executeOpenAISdk(request)), trace);
      const result = await executeReview(values.base, values.head, createEvidence(options), agent, {
        ...(values['max-findings'] === undefined ? {} : { maxFindings: Number(values['max-findings']) }),
        ...(values['max-text-length'] === undefined ? {} : { maxTextLength: Number(values['max-text-length']) }),
        ...(values['timeout-ms'] === undefined ? {} : { timeoutMs: Number(values['timeout-ms']) }),
      }, trace);
      return values.json ? formatReviewJson(result) : formatReview(result);
    }
    return `${JSON.stringify(await collectEvidence(values.base, values.head, createEvidence(options)), null, 2)}\n`;
  }
  const diff = createDiff(values.repo);
  if (values.file !== undefined) return diff.getFileDiff(values.base, values.head, values.file);
  return `${JSON.stringify(await diff.compare(values.base, values.head), null, 2)}\n`;
}

/** User-selected proposal input is bounded independently of provider output limits. */
async function readScriptedProposal(path: string): Promise<unknown> {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Scripted proposal must be a regular file');
    const buffer = Buffer.alloc(1_048_577);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 1_048_576) throw new Error('Scripted proposal exceeds 1 MiB');
    return JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
  } finally { await handle.close(); }
}
