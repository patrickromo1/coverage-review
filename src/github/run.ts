import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { LocalGitDiff } from '../adapters/git/local-git-diff.js';
import { LcovCoverageProvider, UnavailableCoverageProvider } from '../adapters/coverage/lcov-coverage-provider.js';
import { LocalRepository } from '../adapters/repository/local-repository.js';
import { OpenAIConfigSchema, OpenAIReviewAgent, type SdkExecute } from '../agent/openai/openai-review-agent.js';
import type { ReviewAgent } from '../agent/review-agent.js';
import { ReviewLimitsSchema } from '../agent/review-agent.js';
import { ScriptedReviewAgent } from '../agent/scripted-review-agent.js';
import { executeReview } from '../core/review/execute-review.js';
import { ReviewResultSchema, type ReviewResult } from '../core/review/result.js';
import { SupportedTestDiscovery } from '../core/test-discovery/supported-test-discovery.js';
import { ReviewConfigSchema } from '../core/config/review-config.js';
import { MultipleCoverageProvider } from '../adapters/coverage/multiple-coverage-provider.js';
import { readBoundedFile } from '../adapters/files/bounded-file.js';
import { parseBoundedJson } from '../core/coverage/bounded-json.js';
import { ReviewTrace } from '../core/review/trace.js';
import { writeActionOutputs } from './actions-output.js';
import { CiReviewArtifactSchema } from './artifact.js';
import { publishCheck } from './checks.js';
import { FullShaSchema, type GitHubClient, type GitHubReviewContext, type PublishingStatus } from './domain.js';
import { readGitHubEvent } from './event.js';
import { GitHubRestClient } from './rest-client.js';
import { resolveWorkspaceInput, writeAtomicWorkspaceJson } from './workspace-files.js';

const execute = promisify(execFile);

export const githubUsage = `Usage: coverage-review-github (--offline-review <proposal.json> | --review --provider openai --model <model-id>) [options]

Options:
  --config <path>               Bounded data-only workspace config for packages and multiple reports
  --lcov <path>                 LCOV produced by an earlier workflow step
  --coverage-commit <SHA>      Full commit SHA represented by LCOV
  --result <path>               JSON artifact path within GITHUB_WORKSPACE (default: coverage-review-result.json)
  --publish-check               Publish the stable coverage-review Check Run
  --timeout-ms <n>              Shared evidence/agent deadline
  --help

Repository, pull-request number, base, and head are accepted only from validated GitHub event metadata.
pull_request_target, merge_group, manual, and unsupported events produce a needs-review artifact without inspecting code.
Fork pull requests permit explicit offline scripted mode only; live provider mode is never silently substituted.
`;

export interface GitHubRunDependencies {
  readonly trace?: ReviewTrace;
  readonly client?: GitHubClient;
  readonly sdkExecute?: SdkExecute;
  readonly resolveMergeBase?: (workspace: string, baseSha: string, headSha: string, signal: AbortSignal) => Promise<string>;
}

function skippedResult(context: GitHubReviewContext, reason: string, comparisonBaseSha?: string): ReviewResult {
  return ReviewResultSchema.parse({
    schemaVersion: '1', summary: 'GitHub review was not run.', findings: [], verdict: 'needs-review', analysisStatus: 'failed',
    scope: { baseSha: comparisonBaseSha ?? context.baseSha ?? 'unresolved', headSha: context.headSha ?? 'unresolved', resolved: false, changedFiles: [], reviewedFiles: [], files: [] },
    limitations: [{ code: 'agent-incomplete', message: reason }], rejectedFindings: [], evidenceReferences: [],
    provenance: { executorVersion: '1', policyVersion: '1', evidenceSchemaVersion: '1', agentMode: 'none', executionMode: 'github', limits: ReviewLimitsSchema.parse({}) },
  });
}

async function localMergeBase(workspace: string, baseSha: string, headSha: string, signal: AbortSignal): Promise<string> {
  const base = FullShaSchema.parse(baseSha); const head = FullShaSchema.parse(headSha);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await execute('git', ['--no-replace-objects', 'merge-base', base, head], {
    cwd: workspace, encoding: 'utf8', timeout: 15_000, signal,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
  });
  return FullShaSchema.parse(stdout.trim());
}

async function readBoundedJson(path: string, maxBytes = 1_048_576): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`JSON input must be a regular file no larger than ${maxBytes} bytes`);
    const bytes = await readFile(handle);
    try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new Error('JSON input is malformed'); }
  } finally { await handle.close(); }
}

async function comparisonBase(context: GitHubReviewContext, client: GitHubClient | undefined, workspace: string, signal: AbortSignal,
  resolver: NonNullable<GitHubRunDependencies['resolveMergeBase']>): Promise<string> {
  if (!context.baseSha || !context.headSha || !context.pullRequestNumber) throw new Error('Trusted pull-request commits are unavailable');
  if (client) {
    try {
      const metadata = await client.getPullRequest(context.owner, context.repository, context.pullRequestNumber, signal);
      if (metadata.baseSha !== context.baseSha || metadata.headSha !== context.headSha
        || metadata.baseRepository.toLowerCase() !== context.repositorySlug.toLowerCase()
        || metadata.headRepository.toLowerCase() !== context.headRepositorySlug?.toLowerCase()) {
        throw new Error('GitHub API pull-request metadata does not match the event payload');
      }
      const comparison = await client.compareCommits(context.owner, context.repository, context.baseSha, context.headSha, signal);
      if (comparison.baseSha !== context.baseSha || comparison.headSha !== context.headSha) throw new Error('GitHub comparison does not match trusted event commits');
      return comparison.mergeBaseSha;
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.message.includes('does not match'))) throw error;
    }
  }
  return resolver(workspace, context.baseSha, context.headSha, signal);
}

export async function runGitHubAction(args: string[], environment: NodeJS.ProcessEnv = process.env, dependencies: GitHubRunDependencies = {}) {
  const { values } = parseArgs({ args, options: {
    'offline-review': { type: 'string' }, review: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' },
    config: { type: 'string' }, lcov: { type: 'string' }, 'coverage-commit': { type: 'string' }, result: { type: 'string', default: 'coverage-review-result.json' },
    'publish-check': { type: 'boolean' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  }, strict: true, allowPositionals: false });
  if (values.help) return { help: githubUsage } as const;
  if (values.config && (values.lcov || values['coverage-commit'])) throw new Error('--config cannot combine with legacy coverage flags');
  const trace = dependencies.trace ?? new ReviewTrace();
  const workspace = environment.GITHUB_WORKSPACE;
  const eventPath = environment.GITHUB_EVENT_PATH;
  const eventName = environment.GITHUB_EVENT_NAME;
  const repository = environment.GITHUB_REPOSITORY;
  if (!workspace || !eventPath || !eventName || !repository) throw new Error('GitHub Actions context variables are required');
  const offline = values['offline-review'] !== undefined;
  const live = !!values.review;
  if (offline === live) throw new Error('Select exactly one of --offline-review or explicit --review');
  if (!live && (values.provider || values.model)) throw new Error('Provider configuration requires --review');
  if (live && (values.provider !== 'openai' || !values.model)) throw new Error('--review requires --provider openai and --model <model-id>');
  if (values['coverage-commit']) FullShaSchema.parse(values['coverage-commit']);
  const reviewLimits = ReviewLimitsSchema.parse(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {});
  const context = await readGitHubEvent(eventPath, eventName, repository);
  const token = environment.GITHUB_TOKEN;
  const client = dependencies.client ?? (token ? new GitHubRestClient({ token }) : undefined);
  const githubSignal = AbortSignal.timeout(Math.min(330_000, reviewLimits.timeoutMs + 30_000));
  let base: string | undefined;
  let result: ReviewResult | undefined;
  if (!context.safeToAnalyze) result = skippedResult(context, context.reason ?? 'This event is not safe to analyze.');
  else if (context.fork && live) result = skippedResult(context, 'Live provider review is disabled for untrusted fork pull requests because secrets are unavailable.');
  else if (live && !environment.OPENAI_API_KEY) result = skippedResult(context, 'Explicit live review was requested but OPENAI_API_KEY is unavailable.');
  else {
    try {
      base = await comparisonBase(context, client, workspace, githubSignal, dependencies.resolveMergeBase ?? localMergeBase);
      const reviewConfig = values.config ? ReviewConfigSchema.parse(parseBoundedJson((await readBoundedFile(workspace, values.config, 65_536, githubSignal)).toString('utf8'), 65_536)) : undefined;
      const lcovPath = values.lcov ? await resolveWorkspaceInput(workspace, values.lcov) : undefined;
      let agent: ReviewAgent;
      if (offline) {
        const proposalPath = await resolveWorkspaceInput(workspace, values['offline-review']!);
        agent = new ScriptedReviewAgent(await readBoundedJson(proposalPath));
      } else {
        const config = OpenAIConfigSchema.parse({ model: values.model });
        agent = new OpenAIReviewAgent(config, dependencies.sdkExecute ?? (async (request) => (await import('../agent/openai/sdk-execution.js')).executeOpenAISdk(request)));
      }
      result = await executeReview(base, context.headSha!, {
        diff: new LocalGitDiff(workspace), repository: new LocalRepository(workspace), testDiscovery: new SupportedTestDiscovery(reviewConfig),
        coverage: reviewConfig ? new MultipleCoverageProvider(workspace, reviewConfig.reports) : lcovPath ? new LcovCoverageProvider(workspace, lcovPath, values['coverage-commit']) : new UnavailableCoverageProvider(),
      }, agent, { ...reviewLimits, executionMode: 'github' }, trace);
    } catch {
      result = skippedResult(context, 'GitHub comparison or bounded workspace input validation failed.', base);
    }
  }
  if (!result) throw new Error('GitHub review did not produce a result');
  const publishingStarted = Date.now();
  let publishing: PublishingStatus = { status: 'not-requested' };
  if (values['publish-check']) {
    publishing = !token && !dependencies.client ? { status: 'failed', reason: 'missing-token' }
      : context.kind !== 'pull-request' ? { status: 'failed', reason: 'invalid-response' }
      : await publishCheck(client!, context, result, githubSignal);
  }
  await trace.emit('publishing', publishingStarted, publishing.status === 'failed' ? 'error' : 'ok', { findings: publishing.status === 'published' ? publishing.annotationsPublished : 0 });
  const artifact = CiReviewArtifactSchema.parse({ schemaVersion: '1', kind: 'coverage-review-result', context,
    ...(base ? { comparisonBaseSha: base } : {}), review: result, publishing });
  const resultPath = await writeAtomicWorkspaceJson(workspace, values.result!, artifact);
  if (environment.GITHUB_OUTPUT) await writeActionOutputs(environment.GITHUB_OUTPUT, {
    verdict: result.verdict, 'analysis-status': result.analysisStatus, 'findings-count': result.findings.length,
    'rejected-findings-count': result.rejectedFindings.length, 'result-path': relative(await realpath(workspace), resultPath),
    'reviewed-base-sha': result.scope.baseSha, 'reviewed-head-sha': result.scope.headSha, 'publishing-status': publishing.status,
  });
  return artifact;
}
