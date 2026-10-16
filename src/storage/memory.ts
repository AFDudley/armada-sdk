// ABOUTME: In-memory StorageAdapter (SPEC §4.3) — the reference/test adapter and the ephemeral-wallet
// ABOUTME: backing. Deployment-binding: opening under a changed namespace auto-resets chain-derived state.

import type { StorageAdapter, StorageNamespace, StorageOp } from './index';
import { NAMESPACE_KEY, isPreserved, encodeNamespace, bytesEqual, assertSameBinding, assertNotClosed } from './namespace';

export class MemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, Uint8Array>();
  // The namespace this adapter is open under, until close().
  private bound: Uint8Array | undefined;
  // Set by close(), cleared by open(): a closed adapter rejects every other call.
  private closed = false;

  private assertOpen(): void {
    assertNotClosed('MemoryStorageAdapter', this.closed);
  }

  async open(namespace: StorageNamespace): Promise<{ reset: boolean }> {
    const nsBytes = encodeNamespace(namespace);
    if (assertSameBinding('MemoryStorageAdapter', this.bound, nsBytes)) return { reset: false };
    this.closed = false;
    const previous = this.store.get(NAMESPACE_KEY);
    const reset = previous !== undefined && !bytesEqual(previous, nsBytes);
    if (reset) {
      // Deployment changed under a preserved identity → reset chain-derived state (SPEC §4.3).
      await this.resetChainState();
    }
    this.store.set(NAMESPACE_KEY, nsBytes);
    this.bound = nsBytes;
    return { reset };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.assertOpen();
    const value = this.store.get(key);
    return value === undefined ? undefined : value.slice();
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.assertOpen();
    this.store.set(key, value.slice());
  }

  async del(key: string): Promise<void> {
    this.assertOpen();
    this.store.delete(key);
  }

  // Synchronous, so atomic: nothing else runs between the read and the write.
  async update(
    key: string,
    fn: (current: Uint8Array | undefined) => Uint8Array | undefined,
  ): Promise<Uint8Array | undefined> {
    this.assertOpen();
    const current = this.store.get(key);
    const next = fn(current === undefined ? undefined : current.slice());
    if (next === undefined) this.store.delete(key);
    else this.store.set(key, next.slice());
    return next;
  }

  async batch(ops: readonly StorageOp[]): Promise<void> {
    this.assertOpen();
    for (const op of ops) {
      if (op.type === 'put') this.store.set(op.key, op.value.slice());
      else this.store.delete(op.key);
    }
  }

  // Key order, like IndexedDB and Level (insertion order would hide ordering bugs).
  async *list(prefix: string): AsyncIterable<{ key: string; value: Uint8Array }> {
    this.assertOpen();
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    for (const key of keys) yield { key, value: this.store.get(key)!.slice() };
  }

  async resetChainState(): Promise<void> {
    this.assertOpen();
    for (const key of [...this.store.keys()]) {
      if (!isPreserved(key)) this.store.delete(key);
    }
  }

  // Unbind and refuse further calls until reopened; the data stays, so a closed-then-reopened adapter behaves like the persistent ones (a new instance on the
  // same store, or a redeploy reopening it under a new namespace).
  async close(): Promise<void> {
    this.bound = undefined;
    this.closed = true;
  }
}
