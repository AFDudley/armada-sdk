// ABOUTME: Node StorageAdapter (SPEC §4.3) over an injected abstract-level DB (classic-level in prod,
// ABOUTME: memory-level in tests). The consumer brings the DB, so the SDK stays browser-safe + dep-free.

import { StorageConflictError } from '../errors';
import type { StorageAdapter, StorageNamespace, StorageOp, StorageWriteOptions } from './index';
import { NAMESPACE_KEY, isPreserved, encodeNamespace, bytesEqual, assertSameBinding, assertNotClosed } from './namespace';

/**
 * The minimal `abstract-level` surface `LevelStorageAdapter` needs. `classic-level` (Node LevelDB),
 * `memory-level`, and any other abstract-level database satisfy it. The SDK does NOT depend on a level
 * package — the consumer constructs the DB (bringing the native binary) and injects it, keeping the SDK
 * browser-safe and free of native deps. Construct with binary value encoding, e.g.
 * `new ClassicLevel(path, { keyEncoding: 'utf8', valueEncoding: 'view' })`.
 */
export interface AbstractLevelLike {
  readonly status: string; // 'open' | 'closed' | 'opening' | 'closing'
  open(): Promise<void>;
  close(): Promise<void>;
  get(key: string, options?: object): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array, options?: object): Promise<void>;
  del(key: string, options?: object): Promise<void>;
  batch(
    ops: Array<{ type: 'put'; key: string; value: Uint8Array } | { type: 'del'; key: string }>,
    options?: object,
  ): Promise<void>;
  iterator(options?: object): { all(): Promise<[string, Uint8Array][]> };
}

// Force binary keys/values per call, so the adapter works regardless of the DB's default encoding.
const ENC = { keyEncoding: 'utf8', valueEncoding: 'view' } as const;

// Whether an open() failure is the on-disk lock another process holds. abstract-level 3.x wraps it: the thrown
// error is LEVEL_DATABASE_NOT_OPEN, and its `cause` carries LEVEL_LOCKED (WS-4) — so walk the cause chain.
function lockedCause(err: unknown): string | undefined {
  for (let e: unknown = err; e !== undefined && e !== null; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: string }).code ?? '';
    const message = e instanceof Error ? e.message : String(e);
    if (/lock/i.test(code) || /lock/i.test(message)) return code || message;
  }
  return undefined;
}

/**
 * Node-persistent StorageAdapter over an abstract-level DB, with the shared namespace/reset semantics. Writes run
 * one at a time through an in-process queue, so `update` is atomic against every other write; the database's own
 * on-disk lock keeps a second process out entirely.
 */
export class LevelStorageAdapter implements StorageAdapter {
  // The namespace this adapter is open under, until close().
  private bound: Uint8Array | undefined;
  // The tail of the write queue: each write starts once the previous one has settled.
  private writes: Promise<unknown> = Promise.resolve();
  // Set by close(), cleared by open(): a closed adapter rejects every other call.
  private closed = false;

  constructor(private readonly db: AbstractLevelLike) {}

  private assertOpen(): void {
    assertNotClosed('LevelStorageAdapter', this.closed);
  }

  private serialized<T>(write: () => Promise<T>): Promise<T> {
    try {
      this.assertOpen();
    } catch (err) {
      return Promise.reject(err);
    }
    const run = this.writes.then(write, write);
    this.writes = run.catch(() => undefined);
    return run;
  }

  async open(namespace: StorageNamespace): Promise<{ reset: boolean }> {
    const nsBytes = encodeNamespace(namespace);
    if (assertSameBinding('LevelStorageAdapter', this.bound, nsBytes)) return { reset: false };
    this.closed = false;
    if (this.db.status !== 'open') {
      try {
        await this.db.open();
      } catch (err) {
        // classic-level locks its on-disk directory; a second process opening it fails. Surface advisory-lock
        // conflicts as the typed error (SPEC §4.3) rather than an opaque one.
        const locked = lockedCause(err);
        if (locked !== undefined) {
          throw new StorageConflictError(`LevelStorageAdapter: database is locked by another process (${locked})`, { cause: err });
        }
        throw err;
      }
    }
    const previous = await this.get(NAMESPACE_KEY);
    const reset = previous !== undefined && !bytesEqual(previous, nsBytes);
    if (reset) await this.resetChainState();
    await this.put(NAMESPACE_KEY, nsBytes);
    this.bound = nsBytes;
    return { reset };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.assertOpen();
    const v = await this.db.get(key, ENC);
    return v === undefined ? undefined : new Uint8Array(v);
  }

  put(key: string, value: Uint8Array): Promise<void> {
    return this.serialized(() => this.db.put(key, value, ENC));
  }

  del(key: string): Promise<void> {
    return this.serialized(() => this.db.del(key, ENC));
  }

  update(
    key: string,
    fn: (current: Uint8Array | undefined) => Uint8Array | undefined,
    options?: StorageWriteOptions,
  ): Promise<Uint8Array | undefined> {
    return this.serialized(async () => {
      const current = await this.db.get(key, ENC);
      const next = fn(current === undefined ? undefined : new Uint8Array(current));
      const sync = { ...ENC, sync: options?.durable === true };
      if (next === undefined) await this.db.del(key, sync);
      else await this.db.put(key, next, sync);
      return next;
    });
  }

  batch(ops: readonly StorageOp[], options?: StorageWriteOptions): Promise<void> {
    return this.serialized(() =>
      this.db.batch(
        ops.map((op) => (op.type === 'put' ? { type: 'put' as const, key: op.key, value: op.value } : { type: 'del' as const, key: op.key })),
        { ...ENC, sync: options?.durable === true },
      ),
    );
  }

  async *list(prefix: string): AsyncIterable<{ key: string; value: Uint8Array }> {
    this.assertOpen();
    // Half-open range [prefix, prefix+￿]; keys are ASCII paths (chain/ identity/ durable/), so the
    // sentinel can't clip a real key (same convention as the IndexedDB adapter).
    const entries = await this.db.iterator({ gte: prefix, lte: `${prefix}￿`, ...ENC }).all();
    for (const [key, value] of entries) yield { key, value: new Uint8Array(value) };
  }

  resetChainState(): Promise<void> {
    return this.serialized(async () => {
      const entries = await this.db.iterator(ENC).all();
      for (const [key] of entries) {
        if (!isPreserved(key)) await this.db.del(key, ENC);
      }
    });
  }

  async close(): Promise<void> {
    if (this.db.status === 'open') await this.db.close();
    this.bound = undefined;
    this.closed = true;
  }
}
