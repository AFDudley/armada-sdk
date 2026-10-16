// ABOUTME: Tests for ScopedStore (WS-2, #138) — each wallet's records live under `<area>/<walletTag>/…`, so wallets
// ABOUTME: sharing one adapter can't list, collide with or decrypt each other's records, and the area rules still apply.

import { describe, it, expect } from 'vitest';
import { MemoryStorageAdapter } from './memory';
import { EncryptedStore } from './encrypted';
import { ScopedStore } from './scoped';
import { InvalidRequestError } from '../errors';
import type { StorageAdapter, StorageNamespace } from './index';

const ns: StorageNamespace = { schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 };
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined): string | undefined => (b === undefined ? undefined : new TextDecoder().decode(b));
const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

async function entries(store: StorageAdapter, prefix: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const { key: k, value } of store.list(prefix)) out.push([k, dec(value)!]);
  return out;
}

describe('ScopedStore (WS-2, #138)', () => {
  it('stores a record under its area, then the wallet tag, and reads it back by its unscoped key', async () => {
    const raw = new MemoryStorageAdapter();
    await raw.open(ns);
    const wallet = new ScopedStore(raw, 'tagA');
    await wallet.put('chain/scan-state', enc('s'));
    expect(dec(await raw.get('chain/tagA/scan-state'))).toBe('s');
    expect(dec(await wallet.get('chain/scan-state'))).toBe('s');
  });

  it('gives each wallet its own records: the same name never collides, and list sees only its own', async () => {
    // WHY: wallets shared one flat key space. A fixed-name record of one wallet overwrote another's, and list()
    // over a shared prefix returned both, so an encrypted wallet hit a GCM failure on the other's records.
    const raw = new MemoryStorageAdapter();
    await raw.open(ns);
    const a = new ScopedStore(new EncryptedStore(raw, key(1)), 'tagA');
    const b = new ScopedStore(new EncryptedStore(raw, key(2)), 'tagB');
    await a.put('chain/holds', enc('A'));
    await b.put('chain/holds', enc('B'));
    expect(dec(await a.get('chain/holds'))).toBe('A');
    expect(await entries(a, 'chain/')).toEqual([['chain/holds', 'A']]); // no GCM error on B's record
    // The adapter's own plaintext namespace marker lives under identity/ too; a wallet's list never reaches it.
    await a.put('identity/meta', enc('m'));
    expect(await entries(a, 'identity/')).toEqual([['identity/meta', 'm']]);
  });

  it('binds the full scoped key into the AAD, so a record moved to another wallet tag fails to decrypt', async () => {
    const raw = new MemoryStorageAdapter();
    await raw.open(ns);
    const a = new ScopedStore(new EncryptedStore(raw, key(1)), 'tagA');
    await a.put('chain/x', enc('secret'));
    await raw.put('chain/tagB/x', (await raw.get('chain/tagA/x'))!); // same key bytes, different stored key
    const sameKeyOtherTag = new ScopedStore(new EncryptedStore(raw, key(1)), 'tagB');
    await expect(sameKeyOtherTag.get('chain/x')).rejects.toThrow();
  });

  it('keeps the area rules: a chain reset wipes chain/ records and keeps durable/ ones', async () => {
    const raw = new MemoryStorageAdapter();
    await raw.open(ns);
    const a = new ScopedStore(raw, 'tagA');
    await a.batch([
      { type: 'put', key: 'chain/x', value: enc('c') },
      { type: 'put', key: 'durable/counter', value: enc('7') },
    ]);
    await raw.resetChainState();
    expect(await a.get('chain/x')).toBeUndefined();
    expect(dec(await a.get('durable/counter'))).toBe('7');
  });

  it('scopes update and batch too', async () => {
    const raw = new MemoryStorageAdapter();
    await raw.open(ns);
    const a = new ScopedStore(raw, 'tagA');
    await a.update('durable/counter', (cur) => enc(String(Number(dec(cur) ?? '0') + 1)));
    await a.batch([{ type: 'put', key: 'chain/y', value: enc('y') }, { type: 'del', key: 'chain/y' }]);
    expect(dec(await raw.get('durable/tagA/counter'))).toBe('1');
    expect(await raw.get('chain/tagA/y')).toBeUndefined();
  });

  it('rejects a key or list prefix with no area segment', async () => {
    const a = new ScopedStore(new MemoryStorageAdapter(), 'tagA');
    await expect(a.put('scan-state', enc('x'))).rejects.toBeInstanceOf(InvalidRequestError);
    expect(() => a.list('chain')).toThrow(InvalidRequestError);
  });
});
