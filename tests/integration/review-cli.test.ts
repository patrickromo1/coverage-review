import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { LocalGitDiff } from '../../src/adapters/git/local-git-diff.js';
import { LocalRepository } from '../../src/adapters/repository/local-repository.js';
import { LcovCoverageProvider } from '../../src/adapters/coverage/lcov-coverage-provider.js';
import { TypeScriptTestDiscovery } from '../../src/core/test-discovery/typescript-test-discovery.js';
import { runCli } from '../../src/cli/run.js';
import { runReviewFixture } from '../../src/evals/run-fixture.js';
import { collectEvidence } from '../../src/core/evidence/collect-evidence.js';
import { evidenceReferences } from '../../src/core/review/references.js';
import { ReviewLimitsSchema } from '../../src/agent/review-agent.js';
import { formatReview } from '../../src/core/review/format-review.js';
import { proposal } from '../helpers/review.js';

const execute = promisify(execFile);
const cases = z.array(z.object({
  name: z.string(), before: z.string(), after: z.string(), testLevel: z.enum(['unit', 'e2e']),
  hits: z.number().nullable(), finding: z.boolean(), verdict: z.string(), analysisStatus: z.string(),
})).parse(JSON.parse(await readFile(new URL('../../evals/fixtures/review/cases.json', import.meta.url), 'utf8')));

it.each(cases)('runs $name through the same executor in CLI and fixtures without executing repository code', async (fixture) => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-review-executor-'));
  const git = async (...args: string[]) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })).stdout.trim();
  try {
    await git('init', '-q'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
    await mkdir(join(root, 'tests', fixture.testLevel), { recursive: true });
    // If any analysis executes this fixture test, it fails. Discovery may only read it.
    await writeFile(join(root, 'tests', fixture.testLevel, 'a.test.ts'), "import '../../a.js';\nthrow new Error('DO NOT EXECUTE FIXTURE TESTS');\n");
    await writeFile(join(root, 'a.ts'), `${fixture.before}\n`);
    await git('add', '.'); await git('commit', '-qm', 'Base');
    const baseSha = await git('rev-parse', 'HEAD');
    await writeFile(join(root, 'a.ts'), `${fixture.after}\n`);
    await git('add', '.'); await git('commit', '-qm', 'Head');
    const headSha = await git('rev-parse', 'HEAD');
    const report = join(root, 'lcov.info');
    await writeFile(report, `SF:a.ts\n${fixture.hits === null ? '' : `DA:1,${fixture.hits}\n`}end_of_record\n`);
    const create = () => ({
      diff: new LocalGitDiff(root), repository: new LocalRepository(root), testDiscovery: new TypeScriptTestDiscovery(),
      coverage: new LcovCoverageProvider(root, report, headSha),
    });
    const evidence = await collectEvidence(baseSha, headSha, create());
    const scripted = proposal({ evidence, references: evidenceReferences(evidence), limits: ReviewLimitsSchema.parse({}), signal: new AbortController().signal }, fixture.finding);
    const proposalPath = join(root, 'proposal.json');
    await writeFile(proposalPath, JSON.stringify(scripted));
    const result = await runReviewFixture({ baseSha, headSha, dependencies: create(), proposal: scripted });
    const args = ['--base', baseSha, '--head', headSha, '--repo', root, '--offline-review', proposalPath, '--lcov', report, '--coverage-commit', headSha];
    const output = await runCli([...args, '--json'], () => new LocalGitDiff(root), create);
    expect(JSON.parse(output)).toEqual(result);
    expect(await runCli([...args, '--json'], () => new LocalGitDiff(root), create)).toBe(output);
    expect(result).toMatchObject({ verdict: fixture.verdict, analysisStatus: fixture.analysisStatus, provenance: { agentMode: 'scripted' } });
    expect(await runCli(args, () => new LocalGitDiff(root), create)).toBe(formatReview(result));
    expect(formatReview(result)).toContain('OFFLINE SCRIPTED REVIEW');
    if (fixture.name === 'adequately-tested') {
      const actual = await execute(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args, '--json']);
      expect(JSON.parse(actual.stdout)).toEqual(result);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects conflicting modes, invalid limits, malformed and oversized offline input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coverage-review-proposal-'));
  const create = () => new LocalGitDiff(root);
  const args = ['--base', 'base', '--head', 'head'];
  try {
    await expect(runCli([...args, '--offline-review', 'x', '--evidence'], create)).rejects.toThrow('mutually exclusive');
    await expect(runCli([...args, '--json'], create)).rejects.toThrow('require --offline-review');
    await expect(runCli([...args, '--timeout-ms', '1'], create)).rejects.toThrow('require --offline-review');
    const file = join(root, 'proposal.json');
    const deps = (await import('../helpers/review.js')).dependencies;
    await writeFile(file, '{broken');
    await expect(runCli([...args, '--offline-review', file], create, deps)).rejects.toThrow();
    await writeFile(file, ' '.repeat(1_048_577));
    await expect(runCli([...args, '--offline-review', file], create, deps)).rejects.toThrow('1 MiB');
    await writeFile(file, '{}');
    await expect(runCli([...args, '--offline-review', file, '--max-findings', '0'], create, deps)).rejects.toThrow();
    expect(JSON.parse(await runCli([...args, '--offline-review', file, '--json'], create, deps))).toMatchObject({ verdict: 'needs-review', analysisStatus: 'failed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
