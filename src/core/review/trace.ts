import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const count = z.number().int().nonnegative();
export const TraceSpanSchema = z.strictObject({
  traceId: z.string().uuid(), spanId: z.string().uuid(),
  name: z.enum(['evidence', 'agent', 'review', 'provider']),
  durationMs: z.number().nonnegative(), status: z.enum(['ok', 'partial', 'error']),
  attributes: z.strictObject({
    files: count.optional(), findings: count.optional(), toolCalls: count.optional(), readBytes: count.optional(),
    inputTokens: count.optional(), outputTokens: count.optional(), requests: count.optional(),
  }),
  sensitive: z.string().max(262_144).optional(),
});
export type TraceSpan = z.infer<typeof TraceSpanSchema>;
export interface TraceOptions {
  exportSpan?: (span: TraceSpan) => void | Promise<void>;
  includeSensitiveContent?: boolean;
}
/** Allowlisted metadata, no SDK exporter. Export is bounded and non-fatal. */
export class ReviewTrace {
  private readonly traceId = randomUUID();
  constructor(private readonly options: TraceOptions = {}) {}
  async emit(name: TraceSpan['name'], start: number, status: TraceSpan['status'], attributes: TraceSpan['attributes'] = {}, sensitive?: string) {
    if (!this.options.exportSpan) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const span = TraceSpanSchema.parse({ traceId: this.traceId, spanId: randomUUID(), name,
        durationMs: Math.max(0, Date.now() - start), status, attributes,
        ...(this.options.includeSensitiveContent && sensitive ? { sensitive: sensitive.slice(0, 262_144) } : {}),
      });
      await Promise.race([Promise.resolve().then(() => this.options.exportSpan!(span)), new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); })]);
    } catch { /* Observability must not change review results or expose exporter errors. */ }
    finally { clearTimeout(timer); }
  }
}
