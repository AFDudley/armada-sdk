// ABOUTME: The StorageAdapter contract (SPEC §4.3, #138), run against every adapter — Memory, IndexedDB (fake-indexeddb)
// ABOUTME: and Level (memory-level): key-ordered listing, atomic update/batch, reset rules, and namespace rebinding.

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { MemoryLevel } from 'memory-level';
import { MemoryStorageAdapter } from './memory';
import { IndexedDBStorageAdapter } from './indexeddb';
import { LevelStorageAdapter, type AbstractLevelLike } from './level';
import { StorageConflictError } from '../errors';
import type { StorageAdapter, StorageNamespace } from './index';

const ns = (deployBlock = 1): StorageNamespace => ({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock });
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined): string | undefined => (b === undefined ? undefined : new TextDecoder().decode(b));

let dbCount = 0;
const ADAPTERS: [string, () => StorageAdapter][] = [
  ['Memory', () => new MemoryStorageAdapter()],
  // Node has no Web Locks API; the opt-out is exactly what a test harness without it is for.
  ['IndexedDB', () => new IndexedDBStorageAdapter(`contract-${(dbCount += 1)}`, { dangerouslySkipLock: true })],
  ['Level', () => new LevelStorageAdapter(new MemoryLevel({ keyEncoding: 'utf8', valueEncoding: 'view' }) as unknown as AbstractLevelLike)],
];

async function keysOf(store: StorageAdapter, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const { key } of store.list(prefix)) keys.push(key);
  return keys;
}

describe.each(ADAPTERS)('%s adapter — StorageAdapter contract (#138)', (_name, make) => {
  async function opened(): Promise<StorageAdapter> {
    const store = make();
    await store.open(ns());
    return store;
  }

  it('lists the entries under a prefix in key order, whatever order they were written in', async () => {
    // WHY: journal and sweep code will rely on key order; the Memory adapter returned insertion order, so an
    // ordering bug would pass every test and fail on IndexedDB or Level (WS-9).
    const store = await opened();
    for (const k of ['chain/c', 'chain/a', 'other/x', 'chain/b']) await store.put(k, enc(k));
    expect(await keysOf(store, 'chain/')).toEqual(['chain/a', 'chain/b', 'chain/c']);
    await store.close();
  });

  it('update creates, transforms and deletes a record, returning what it stored', async () => {
    const store = await opened();
    expect(dec(await store.update('chain/n', (cur) => enc(`${cur === undefined ? 'new' : 'old'}`)))).toBe('new');
    expect(dec(await store.update('chain/n', (cur) => enc(`${dec(cur)}+1`)))).toBe('new+1');
    expect(dec(await store.get('chain/n'))).toBe('new+1');
    expect(await store.update('chain/n', () => undefined)).toBeUndefined();
    expect(await store.get('chain/n')).toBeUndefined();
    await store.close();
  });

  it('update is atomic: concurrent read-modify-writes of one key all land', async () => {
    // WHY: the §6.2 claim-seed counter is a read-modify-write; two that interleave hand out the same seed, and two
    // recipients can then claim each other's funds.
    const store = await opened();
    const increment = (cur: Uint8Array | undefined): Uint8Array => enc(String(Number(dec(cur) ?? '0') + 1));
    await Promise.all(Array.from({ length: 25 }, () => store.update('durable/counter', increment)));
    expect(dec(await store.get('durable/counter'))).toBe('25');
    await store.close();
  });

  it('batch applies its puts and deletes together, in order, durably when asked', async () => {
    const store = await opened();
    await store.put('chain/old', enc('x'));
    await store.batch(
      [
        { type: 'put', key: 'chain/a', value: enc('1') },
        { type: 'put', key: 'chain/b', value: enc('2') },
        { type: 'del', key: 'chain/old' },
        { type: 'del', key: 'chain/a' },
      ],
      { durable: true },
    );
    expect(await keysOf(store, 'chain/')).toEqual(['chain/b']);
    expect(dec(await store.get('chain/b'))).toBe('2');
    await store.close();
  });

  it('resetChainState wipes chain-derived records and keeps identity/ and durable/', async () => {
    const store = await opened();
    await store.batch([
      { type: 'put', key: 'chain/x', value: enc('c') },
      { type: 'put', key: 'identity/w', value: enc('i') },
      { type: 'put', key: 'durable/counter', value: enc('7') },
    ]);
    await store.resetChainState();
    expect(await store.get('chain/x')).toBeUndefined();
    expect(dec(await store.get('identity/w'))).toBe('i');
    expect(dec(await store.get('durable/counter'))).toBe('7');
    await store.close();
  });

  it('an open adapter refuses to rebind to a different namespace, instead of wiping its chain state', async () => {
    // WHY: re-opening the same adapter object under another deployment silently ran the deployment-change reset,
    // wiping the chain state of the instance still using it (WS-5).
    const store = await opened();
    await store.put('chain/x', enc('kept'));
    await expect(store.open(ns(999))).rejects.toBeInstanceOf(StorageConflictError);
    expect(dec(await store.get('chain/x'))).toBe('kept');
    await expect(store.open(ns())).resolves.toEqual({ reset: false }); // the same namespace is a harmless no-op
    await store.close();
  });
});
