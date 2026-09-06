import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertRepositoryPath } from '../../core/repository/repository.js';

/** Reject symlinks in every path component; open without following a leaf symlink. */
export async function readBoundedFile(root: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  assertRepositoryPath(path); signal?.throwIfAborted();
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const part of path.split('/')) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are unsupported');
  }
  if (await realpath(current) !== resolve(canonicalRoot, path)) throw new Error('Path containment changed');
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    const named = await lstat(current, { bigint: true });
    if (named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink() || await realpath(current) !== resolve(canonicalRoot, path)) throw new Error('Path changed during capture');
    if (!before.isFile()) throw new Error('Expected a regular file');
    if (before.size > BigInt(maxBytes)) throw new Error('File byte budget exhausted');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (await realpath(current) !== resolve(canonicalRoot, path)) throw new Error('Path changed during capture');
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('File changed during capture');
    if (size > maxBytes) throw new Error('File byte budget exhausted');
    signal?.throwIfAborted();
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
