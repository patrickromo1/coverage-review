import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { assertRepositoryPath, type Repository } from '../../core/repository/repository.js';

/** Intended for a stable local checkout; not a sandbox for concurrent hostile mutations. */
export class LocalRepository implements Repository {
  constructor(private readonly root: string, private readonly maxBytes = 1_048_576) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
  }

  async readSource(path: string): Promise<string> {
    assertRepositoryPath(path);
    const root = await realpath(this.root);
    const target = await realpath(resolve(root, path));
    const inside = relative(root, target);
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) {
      throw new Error('Source path escapes repository');
    }
    const file = await open(target, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Source path must be a regular file');
      if (stat.size > this.maxBytes) throw new Error('Source exceeds read limit');
      const buffer = Buffer.alloc(this.maxBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > this.maxBytes) throw new Error('Source exceeds read limit');
      return buffer.subarray(0, total).toString('utf8');
    } finally {
      await file.close();
    }
  }
}
