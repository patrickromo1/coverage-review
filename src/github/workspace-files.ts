import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

export async function resolveWorkspaceInput(workspace: string, input: string): Promise<string> {
  if (hasControlCharacters(input)) throw new Error('Input path contains control characters');
  const root = await realpath(workspace);
  const candidate = resolve(root, input);
  if (!contained(root, candidate)) throw new Error('Input path escapes GITHUB_WORKSPACE');
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink()) throw new Error('Input path must not be a symbolic link');
  if (!stat.isFile()) throw new Error('Input path must be a regular file');
  const actual = await realpath(candidate);
  if (!contained(root, actual)) throw new Error('Input path resolves outside GITHUB_WORKSPACE');
  return actual;
}

export async function writeAtomicWorkspaceJson(workspace: string, output: string, value: unknown, maxBytes = 4 * 1024 * 1024): Promise<string> {
  if (hasControlCharacters(output)) throw new Error('Result path contains control characters');
  const root = await realpath(workspace);
  const target = resolve(root, output);
  if (!contained(root, target) || target === root) throw new Error('Result path escapes GITHUB_WORKSPACE');
  const parent = dirname(target);
  let current = root;
  const segments = relative(root, parent).split(sep).filter(Boolean);
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Result parent must contain only real directories');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  const actualParent = await realpath(parent);
  if (!contained(root, actualParent)) throw new Error('Result parent resolves outside GITHUB_WORKSPACE');
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Result path must not be a symbolic link'); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > maxBytes) throw new Error(`Result artifact exceeds ${maxBytes} bytes`);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(body, 'utf8'); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temporary).catch(() => undefined); throw error; }
  await handle.close();
  try { await rename(temporary, target); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  return target;
}
