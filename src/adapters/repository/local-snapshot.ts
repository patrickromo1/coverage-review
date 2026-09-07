import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, DiffProvider } from '../../core/diff/diff-provider.js';
import { assertRepositoryPath, type Repository, type SourceRead } from '../../core/repository/repository.js';
import { readBoundedFile } from '../files/bounded-file.js';

const execute = promisify(execFile);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Entry = { mode: string; digest: string; read: SourceRead };
type Snapshot = Map<string, Entry>;
export interface CapturedLocalReview { baseSha: string; headSha: string; diff: DiffProvider; repository: Repository; mode: 'staged' | 'unstaged'; metrics: { requests: number; readBytes: number; filesScanned: number } }

/** Captures data only; never writes Git objects, commits, index entries, or working-tree files. */
export async function captureLocalReview(root: string, mode: 'staged' | 'unstaged', signal?: AbortSignal,
  afterCapture?: () => Promise<void>): Promise<CapturedLocalReview> {
  if (mode !== 'staged' && mode !== 'unstaged') throw new Error('Invalid local snapshot mode');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 30_000);
  const check = () => controller.signal.throwIfAborted();
  let bytes = 0; let requests = 0; let filesScanned = 0;
  const git = async (args: string[], cwd = root, maxBuffer = 4 * 1024 * 1024): Promise<Buffer> => {
    check(); if (++requests > 10_000) throw new Error('Snapshot request budget exhausted');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    try {
      return (await execute('git', ['--no-replace-objects', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], {
        cwd, encoding: 'buffer', maxBuffer, timeout: 30_000, signal: controller.signal,
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
      })).stdout;
    } catch (error) {
      if (args[0] === 'diff' && typeof error === 'object' && error && 'code' in error && error.code === 1 && 'stdout' in error && Buffer.isBuffer(error.stdout)) return error.stdout;
      throw new Error('Snapshot Git read failed');
    }
  };
  const entries = (buffer: Buffer, index: boolean) => {
    const records = buffer.toString('utf8').split('\0');
    if (records.pop() !== '' || records.length > 2000) throw new Error('Snapshot file enumeration incomplete or exceeds 2000 files');
    filesScanned += records.length;
    return records.map((record) => {
      const match = index ? /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t(.+)$/.exec(record) : /^(\d{6}) blob ([a-f0-9]{40,64})\t(.+)$/.exec(record);
      if (!match || (index && match[3] !== '0')) throw new Error('Unresolved index conflicts or unsupported tree entries');
      const path = match[index ? 4 : 3]!; assertRepositoryPath(path);
      if (/^[.]git(?:\/|$)/i.test(path)) throw new Error('Git administrative paths are unsupported');
      return { mode: match[1]!, oid: match[2]!, path };
    });
  };
  const readWorkingSymlink = async (path: string): Promise<Buffer | undefined> => {
    const canonicalRoot = await realpath(root);
    const parts = path.split('/');
    let current = canonicalRoot;
    const parents: Array<{ path: string; dev: bigint; ino: bigint }> = [];
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      let named;
      try { named = await lstat(current, { bigint: true }); }
      catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
      if (named.isSymbolicLink()) throw new Error('Symbolic link parent is unsupported');
      parents.push({ path: current, dev: named.dev, ino: named.ino });
    }
    const leaf = join(canonicalRoot, path);
    let before;
    try { before = await lstat(leaf, { bigint: true }); }
    catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
    if (!before.isSymbolicLink()) return undefined;
    const target = await readlink(leaf, { encoding: 'buffer' });
    const after = await lstat(leaf, { bigint: true });
    for (const parent of parents) {
      const named = await lstat(parent.path, { bigint: true });
      if (named.isSymbolicLink() || named.dev !== parent.dev || named.ino !== parent.ino) throw new Error('Symbolic link parent changed during capture');
    }
    if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('Symbolic link changed during capture');
    }
    return target;
  };
  const charge = (content: Buffer) => {
    bytes += content.length;
    if (content.length > 32 * 1024 || bytes > 32 * 1024 * 1024) throw new Error('Snapshot byte budget exhausted');
  };
  const make = async (records: ReturnType<typeof entries>, working: boolean): Promise<Snapshot> => {
    const map: Snapshot = new Map();
    for (const entry of records) {
      check();
      if (entry.mode === '120000') {
        const content = working ? await readWorkingSymlink(entry.path) : await git(['cat-file', 'blob', entry.oid], root, 32 * 1024 + 1);
        if (content === undefined) {
          const named = await lstat(join(root, entry.path)).catch((error: unknown) => {
            if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return undefined;
            throw error;
          });
          if (!named) continue;
          if (!named.isFile()) throw new Error('Tracked symbolic link changed to an unsupported file type');
          const replacement = await readBoundedFile(root, entry.path, 32 * 1024, controller.signal);
          charge(replacement);
          const mode = (named.mode & 0o111) ? '100755' : '100644';
          map.set(entry.path, { mode, digest: hash(replacement), read: replacement.includes(0) || !Buffer.from(replacement.toString('utf8')).equals(replacement) ? { status: 'binary', reason: 'Snapshot contains NUL bytes' } : { status: 'available', content: replacement.toString('utf8') } });
          continue;
        }
        charge(content);
        map.set(entry.path, { mode: entry.mode, digest: hash(content), read: { status: 'unsupported', reason: 'Symbolic link snapshot entry is not followed' } });
        continue;
      }
      if (entry.mode === '160000') {
        let digest = entry.oid;
        if (working) {
          let named;
          try { named = await lstat(join(root, entry.path)); }
          catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') continue; throw error; }
          if (!named.isDirectory()) throw new Error('Tracked submodule changed to an unsupported file type');
          const state = await git(['diff', '--raw', '-z', '--ignore-submodules=none', '--', entry.path]);
          if (state.length) digest = hash(Buffer.concat([Buffer.from(entry.oid), state]));
        }
        map.set(entry.path, { mode: entry.mode, digest, read: { status: 'unsupported', reason: 'Submodule snapshot entry is not followed' } });
        continue;
      }
      if (!['100644', '100755'].includes(entry.mode)) {
        throw new Error('Unsupported snapshot entry mode');
      }
      let content: Buffer;
      let fileMode = entry.mode;
      if (working) {
        try { content = await readBoundedFile(root, entry.path, 32 * 1024, controller.signal); fileMode = ((await lstat(join(root, entry.path))).mode & 0o111) ? '100755' : '100644'; }
        catch (error) {
          if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') continue;
          throw new Error('Tracked working-tree capture failed (unsafe, changed, unavailable, or oversized file)');
        }
      } else content = await git(['cat-file', 'blob', entry.oid], root, 32 * 1024 + 1);
      charge(content);
      map.set(entry.path, { mode: fileMode, digest: hash(content), read: content.includes(0) || !Buffer.from(content.toString('utf8')).equals(content) ? { status: 'binary', reason: 'Snapshot contains NUL bytes' } : { status: 'available', content: content.toString('utf8') } });
    }
    return map;
  };
  const identity = (map: Snapshot) => `local:${hash(JSON.stringify([...map].sort(([a], [b]) => a < b ? -1 : 1).map(([path, entry]) => [path, entry.mode, entry.digest])))}`;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      check();
      const head = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim();
      const index = await git(['ls-files', '--stage', '-z']);
      const indexEntries = entries(index, true);
      const base = mode === 'staged' ? await make(entries(await git(['ls-tree', '-r', '-z', head]), false), false) : await make(indexEntries, false);
      const target = await make(indexEntries, mode === 'unstaged');
      await afterCapture?.(); check();
      const verification = mode === 'unstaged' ? await make(indexEntries, true) : target;
      const endIndex = await git(['ls-files', '--stage', '-z']);
      const endHead = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).toString('utf8').trim();
      if (!index.equals(endIndex) || head !== endHead || identity(target) !== identity(verification)) continue;
      const baseSha = mode === 'staged' ? head : identity(base); const headSha = identity(target);
      const files: ChangedFile[] = [];
      const removed = [...base.keys()].filter((path) => !target.has(path));
      const added = [...target.keys()].filter((path) => !base.has(path));
      const renamed = new Set<string>();
      for (const path of added) {
        const matches = removed.filter((old) => !renamed.has(old) && base.get(old)!.digest === target.get(path)!.digest && base.get(old)!.mode === target.get(path)!.mode);
        if (matches.length === 1) { renamed.add(matches[0]!); files.push({ path, previousPath: matches[0]!, status: 'renamed' }); }
        else files.push({ path, status: 'added' });
      }
      for (const path of removed) if (!renamed.has(path)) files.push({ path, status: 'deleted' });
      for (const [path, value] of target) {
        const previous = base.get(path);
        if (previous && (previous.digest !== value.digest || previous.mode !== value.mode)) files.push({ path, status: previous.mode === value.mode ? 'modified' : 'type-changed' });
      }
      files.sort((a, b) => a.path < b.path ? -1 : 1);
      if (files.length > 500) throw new Error('Local changed-file capture exceeds 500 files');
      const patches = new Map<string, string>();
      const temp = await mkdtemp(join(tmpdir(), 'coverage-snapshot-'));
      try {
        for (const file of files) {
          check();
          const a = base.get(file.previousPath ?? file.path)?.read; const b = target.get(file.path)?.read;
          if (a?.status === 'binary' || b?.status === 'binary') { patches.set(file.path, 'Binary files a and b differ\n'); continue; }
          if ((a && a.status !== 'available') || (b && b.status !== 'available')) continue;
          await writeFile(join(temp, 'base'), a?.content ?? '', { mode: 0o600 });
          await writeFile(join(temp, 'head'), b?.content ?? '', { mode: 0o600 });
          const patch = await git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--', 'base', 'head'], temp, 256 * 1024);
          // Only hunks are needed; fixed temporary filenames never enter provenance.
          patches.set(file.path, patch.toString('utf8'));
        }
      } finally { await rm(temp, { recursive: true, force: true }); }
      const get = (id: string) => { if (id === baseSha) return base; if (id === headSha) return target; throw new Error('Snapshot outside captured comparison'); };
      const comparison = (a: string, b: string) => { if (a !== baseSha || b !== headSha) throw new Error('Mismatched snapshot comparison'); };
      return { mode, baseSha, headSha, metrics: { requests, readBytes: bytes, filesScanned },
        repository: {
          async listFiles(id, abort) { abort?.throwIfAborted(); return { status: 'available', paths: [...get(id).keys()].sort() }; },
          async readSource(id, path, abort, maxBytes = 32 * 1024) {
            abort?.throwIfAborted(); assertRepositoryPath(path);
            if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid read limit');
            const read = get(id).get(path)?.read ?? { status: 'missing' as const, reason: 'Path absent from captured snapshot' };
            return read.status === 'available' && Buffer.byteLength(read.content) > maxBytes ? { status: 'truncated', reason: 'Snapshot source exceeds read limit' } : structuredClone(read);
          },
        },
        diff: {
          async compare(a, b, abort) { abort?.throwIfAborted(); comparison(a, b); return { baseSha, headSha, files: structuredClone(files) }; },
          async getFileDiff(a, b, path, abort) { abort?.throwIfAborted(); comparison(a, b); assertRepositoryPath(path); const patch = patches.get(path); if (patch === undefined) throw new Error('Snapshot diff unavailable'); return patch; },
        },
      };
    }
    throw new Error('Concurrent changes prevented stable local capture after two attempts');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
