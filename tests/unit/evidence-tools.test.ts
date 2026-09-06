import { expect, it, vi } from 'vitest';
import { collectEvidence } from '../../src/core/evidence/collect-evidence.js';
import { createEvidenceTools } from '../../src/core/review/evidence-tools.js';
import { evidenceReferences } from '../../src/core/review/references.js';
import { executeReview } from '../../src/core/review/execute-review.js';
import { dependencies, proposal } from '../helpers/review.js';

const args = { kind: 'source', file: 'a.ts', side: 'head', testPath: null, startLine: 1, lineCount: 200 };
async function setup(options = {}) {
  const deps = dependencies();
  const evidence = await collectEvidence('base', 'head', deps);
  const controller = new AbortController();
  const read = vi.spyOn(deps.repository, 'readSource');
  const session = createEvidenceTools(evidence, evidenceReferences(evidence), deps.repository, controller.signal, options);
  return { deps, evidence, controller, read, session };
}
it('binds reads to resolved commits, limits bytes, and uses only authoritative references', async () => {
  const { session, read } = await setup();
  expect(await session.tools.inspect(args)).toMatchObject({ status: 'available', content: '1: export const a = 2;' });
  expect(read).toHaveBeenLastCalledWith('head', 'a.ts', expect.any(AbortSignal), 32768);
  await session.tools.inspect({ ...args, side: 'base' });
  expect(read).toHaveBeenLastCalledWith('base', 'a.ts', expect.any(AbortSignal), 32768);
  const test = await session.tools.inspect({ ...args, kind: 'test', testPath: 'tests/unit/a.test.ts' });
  expect(test.references).toHaveLength(1);
  expect(read).toHaveBeenLastCalledWith('head', 'tests/unit/a.test.ts', expect.any(AbortSignal), 32768);
});
it.each(['../outside', '/etc/passwd', 'a/../../outside', 'a\\b', 'C:/secret', 'unknown.ts'])('rejects scope escape %s before repository IO', async (file) => {
  const { session, read } = await setup();
  await expect(session.tools.inspect({ ...args, file })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
it('rejects arbitrary refs, unknown tests, wrong sides, invalid line limits, and unknown arguments', async () => {
  const { session, read } = await setup();
  for (const bad of [{ ...args, ref: 'main' }, { ...args, kind: 'test', testPath: 'secret.test.ts' },
    { ...args, kind: 'test', testPath: 'tests/unit/a.test.ts', side: 'base' }, { ...args, startLine: 0 }, { ...args, lineCount: 201 }]) {
    await expect(session.tools.inspect(bad)).rejects.toThrow();
  }
  expect(read).not.toHaveBeenCalled();
});
it('reserves cumulative read budget before concurrent IO and bounds tool calls', async () => {
  const { session, read } = await setup({ maxReadBytes: 65536 });
  const outcomes = await Promise.allSettled([session.tools.inspect(args), session.tools.inspect(args), session.tools.inspect(args)]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(1);
  const limited = await setup({ maxToolCalls: 1 });
  await limited.session.tools.inspect(args);
  await expect(limited.session.tools.inspect(args)).rejects.toMatchObject({ code: 'budget-exhausted' });
});
it('preserves missing, truncated, invalid, and unavailable states without exception payloads', async () => {
  const { session, read } = await setup();
  read.mockResolvedValueOnce({ status: 'missing', reason: 'PRIVATE_REASON' });
  expect(await session.tools.inspect(args)).toMatchObject({ status: 'missing', content: 'Committed evidence is missing.' });
  read.mockResolvedValueOnce({ status: 'available', content: 'one\ntwo\nthree' });
  expect(await session.tools.inspect({ ...args, lineCount: 1 })).toMatchObject({ status: 'truncated', content: '1: one' });
  read.mockRejectedValueOnce(new Error('PRIVATE_EXCEPTION'));
  expect(await session.tools.inspect(args)).toMatchObject({ status: 'unavailable', content: 'Committed evidence is unavailable.' });
  read.mockResolvedValueOnce({ status: 'available', content: 4 } as never);
  await expect(session.tools.inspect(args)).rejects.toThrow();
  expect(session.stats().incomplete).toBe(true);
});
it('cancels new and in-flight tool work, and closes sessions', async () => {
  const { session, controller, read } = await setup();
  read.mockImplementationOnce(async () => { controller.abort(); return { status: 'available', content: 'late' }; });
  await expect(session.tools.inspect(args)).rejects.toMatchObject({ code: 'timeout' });
  await expect(session.tools.inspect(args)).rejects.toMatchObject({ code: 'timeout' });
  expect(read).toHaveBeenCalledTimes(1);
  const second = await setup(); second.session.close();
  await expect(second.session.tools.inspect(args)).rejects.toThrow();
  expect(second.read).not.toHaveBeenCalled();
});
it('provider claims without inspection or after unavailable reads cannot become adequate', async () => {
  for (const inspect of [false, true]) {
    const deps = dependencies();
    const result = await executeReview('base', 'head', deps, { mode: 'provider', propose: async (request) => {
      if (inspect) { vi.spyOn(deps.repository, 'readSource').mockRejectedValue(new Error('unavailable')); await request.tools!.inspect(args); }
      return proposal(request);
    } });
    expect(result.verdict).toBe('needs-review'); expect(result.analysisStatus).toBe('partial');
  }
});

it('maps renamed base source to its old path while retaining canonical references', async () => {
  const { evidence, deps, controller, read } = await setup();
  evidence.files[0]!.status = 'renamed'; evidence.files[0]!.previousPath = 'old.ts';
  const refs = evidenceReferences(evidence);
  const session = createEvidenceTools(evidence, refs, deps.repository, controller.signal);
  const result = await session.tools.inspect({ ...args, side: 'base' });
  expect(read).toHaveBeenLastCalledWith('base', 'old.ts', controller.signal, 32768);
  expect(result.references).toEqual(refs.filter((ref) => ref.file === 'a.ts' && ref.kind === 'source').map((ref) => ref.id));
  await expect(session.tools.inspect({ ...args, file: 'old.ts', side: 'base' })).rejects.toThrow();
});
