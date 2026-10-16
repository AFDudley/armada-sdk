// ABOUTME: ScopedStore (SPEC §4.3, WS-2) — one wallet's view of a shared StorageAdapter: every key `<area>/<rest>` is
// ABOUTME: stored as `<area>/<tag>/<rest>`, so wallets can't list, collide with or decrypt each other's records.

import type { StorageAdapter, StorageNamespace, StorageOp, StorageWriteOptions } from './index';
import { InvalidRequestError } from '../errors';

/**
 * Scopes every key under a per-wallet tag, inserted after the key's first segment (its area: `chain/`, `identity/`,
 * `durable/`). Keeping the area first keeps the adapter's reset rules working: a chain reset still wipes every
 * wallet's `chain/` records and keeps their `durable/` ones. `list()` sees only this wallet's records and returns
 * them under their unscoped keys.
 *
 * Wrap an `EncryptedStore` with it (not the other way round), so the encryption layer sees the full stored key and
 * binds it, tag included, as the AAD: a record copied to another wallet's scope fails to decrypt. The tag is the
 * wallet's opaque record id (`walletRecordId`), never its 0zk address — keys are stored in plaintext.
 */
export class ScopedStore implements StorageAdapter {
  constructor(
    private readonly inner: StorageAdapter,
    private readonly tag: string,
  ) {}

  private scoped(key: string): string {
    const slash = key.indexOf('/');
    if (slash <= 0) throw new InvalidRequestError(`ScopedStore: key "${key}" has no area segment (e.g. "chain/…")`);
    return `${key.slice(0, slash + 1)}${this.tag}/${key.slice(slash + 1)}`;
  }

  private unscoped(stored: string): string {
    const slash = stored.indexOf('/');
    return `${stored.slice(0, slash + 1)}${stored.slice(slash + 1 + this.tag.length + 1)}`;
  }

  open(namespace: StorageNamespace): Promise<{ reset: boolean }> {
    return this.inner.open(namespace);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.inner.get(this.scoped(key));
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    return this.inner.put(this.scoped(key), value);
  }

  async del(key: string): Promise<void> {
    return this.inner.del(this.scoped(key));
  }

  async update(
    key: string,
    fn: (current: Uint8Array | undefined) => Uint8Array | undefined,
    options?: StorageWriteOptions,
  ): Promise<Uint8Array | undefined> {
    return this.inner.update(this.scoped(key), fn, options);
  }

  async batch(ops: readonly StorageOp[], options?: StorageWriteOptions): Promise<void> {
    return this.inner.batch(
      ops.map((op) => ({ ...op, key: this.scoped(op.key) })),
      options,
    );
  }

  // Validates the prefix before iterating, so a prefix with no area segment throws at the call.
  list(prefix: string): AsyncIterable<{ key: string; value: Uint8Array }> {
    const scopedPrefix = this.scoped(prefix);
    const inner = this.inner;
    const unscoped = (stored: string): string => this.unscoped(stored);
    return (async function* () {
      for await (const { key, value } of inner.list(scopedPrefix)) yield { key: unscoped(key), value };
    })();
  }

  resetChainState(): Promise<void> {
    return this.inner.resetChainState();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
