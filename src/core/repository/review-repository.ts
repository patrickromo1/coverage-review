import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertRepositoryPath, type Repository, type RepositoryFileListing, type SourceRead } from './repository.js';

export const RepositoryBudgetSchema = z.strictObject({
  maxFiles: z.number().int().min(1).max(20_000).default(20_000),
  maxReads: z.number().int().min(1).max(10_000).default(4_000),
  maxReadBytes: z.number().int().min(1024).max(64 * 1024 * 1024).default(16 * 1024 * 1024),
  maxFileBytes: z.number().int().min(1024).max(1024 * 1024).default(32 * 1024),
  maxCacheBytes: z.number().int().min(0).max(16 * 1024 * 1024).default(4 * 1024 * 1024),
});
const PageSchema = z.strictObject({
  snapshot: z.string().min(1).max(128), prefix: z.string().max(4096).default(''),
  size: z.number().int().min(1).max(500).default(100), cursor: z.string().max(1024).optional(),
});

/** One review owns this bounded cache. Never share across repositories or executions. */
export class ReviewRepository implements Repository {
  private readonly limits;
  private readonly reads = new Map<string, SourceRead>();
  private readonly listings = new Map<string, RepositoryFileListing>();
  private cacheBytes = 0;
  private active = 0;
  private readonly counters = { filesScanned: 0, reads: 0, readBytes: 0, reservedBytes: 0, cacheHits: 0, truncated: 0, pages: 0 };
  constructor(private readonly repository: Repository, private readonly snapshots: readonly string[], options: z.input<typeof RepositoryBudgetSchema> = {}) {
    this.limits = RepositoryBudgetSchema.parse(options);
    if (snapshots.length > 2) throw new Error('Only two review snapshots are allowed');
  }
  stats() { return { ...this.counters }; }
  private check(snapshot: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.snapshots.some((allowed) => allowed === snapshot || (/^[a-fA-F0-9]{40,64}$/.test(allowed) && allowed.toLowerCase() === snapshot.toLowerCase()))) throw new Error('Snapshot outside review');
  }
  async listFiles(snapshot: string, signal?: AbortSignal): Promise<RepositoryFileListing> {
    this.check(snapshot, signal);
    const cached = this.listings.get(snapshot);
    if (cached) { this.counters.cacheHits++; return structuredClone(cached); }
    const listing = await this.repository.listFiles(snapshot, signal);
    this.check(snapshot, signal);
    const paths = [...new Set(listing.paths)].sort();
    for (const path of paths) assertRepositoryPath(path);
    this.counters.filesScanned += paths.length;
    const truncated = listing.status === 'truncated' || paths.length > this.limits.maxFiles;
    const result: RepositoryFileListing = { status: truncated ? 'truncated' : 'available', paths: paths.slice(0, this.limits.maxFiles),
      ...(truncated ? { reason: 'Repository enumeration budget exhausted or upstream listing incomplete' } : {}) };
    if (truncated) this.counters.truncated++;
    this.listings.set(snapshot, result);
    return structuredClone(result);
  }
  async page(raw: z.input<typeof PageSchema>, signal?: AbortSignal) {
    const query = PageSchema.parse(raw);
    this.check(query.snapshot, signal);
    if (query.prefix) assertRepositoryPath(query.prefix);
    if (++this.counters.pages > 400) throw new Error('Repository page budget exhausted');
    const listing = await this.listFiles(query.snapshot, signal);
    const paths = listing.paths.filter((path) => !query.prefix || path === query.prefix || path.startsWith(`${query.prefix}/`));
    const binding = createHash('sha256').update(JSON.stringify([query.snapshot, query.prefix, query.size, paths])).digest('hex');
    let offset = 0;
    if (query.cursor) {
      const match = /^page1:([a-f0-9]{64}):([1-9][0-9]*)$/.exec(query.cursor);
      if (!match || match[1] !== binding || !Number.isSafeInteger(Number(match[2]))) throw new Error('Invalid or mismatched cursor');
      offset = Number(match[2]);
      if (offset >= paths.length || offset % query.size !== 0) throw new Error('Invalid cursor offset');
    }
    return { status: listing.status, paths: paths.slice(offset, offset + query.size), total: paths.length,
      nextCursor: offset + query.size < paths.length ? `page1:${binding}:${offset + query.size}` : null };
  }
  async readSource(snapshot: string, path: string, signal?: AbortSignal, maxBytes = this.limits.maxFileBytes): Promise<SourceRead> {
    this.check(snapshot, signal); assertRepositoryPath(path);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid source limit');
    const bytes = Math.min(maxBytes, this.limits.maxFileBytes);
    const key = JSON.stringify([snapshot, path, bytes]);
    const cached = this.reads.get(key);
    if (cached) { this.counters.cacheHits++; return structuredClone(cached); }
    if (this.active >= 4 || this.counters.reads >= this.limits.maxReads || this.counters.reservedBytes + bytes > this.limits.maxReadBytes) {
      this.counters.truncated++;
      return { status: 'truncated', reason: 'Cumulative repository read budget exhausted' };
    }
    this.counters.reads++; this.counters.reservedBytes += bytes;
    this.active++;
    let result: SourceRead;
    try { result = await this.repository.readSource(snapshot, path, signal, bytes); }
    finally { this.active--; }
    this.check(snapshot, signal);
    const size = result.status === 'available' ? Buffer.byteLength(result.content) : 0;
    this.counters.readBytes += size;
    if (size > bytes) { this.counters.truncated++; return { status: 'truncated', reason: 'Repository exceeded reserved source bytes' }; }
    if (this.reads.size < this.limits.maxReads && this.cacheBytes + size + key.length + 256 <= this.limits.maxCacheBytes) {
      this.cacheBytes += size + key.length + 256; this.reads.set(key, structuredClone(result));
    }
    return result;
  }
}
