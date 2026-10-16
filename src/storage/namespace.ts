// ABOUTME: Shared storage-namespace helpers (SPEC §4.3) — deployment-binding key encoding and the
// ABOUTME: identity/durable key prefixes that survive resetChainState. One source for every adapter.

import type { StorageNamespace } from './index';
import { InstanceClosedError, StorageConflictError } from '../errors';

// Chain-derived state (merkle, TXOs, scan checkpoints) lives outside these prefixes and is wiped by
// resetChainState. `identity/` holds wallet-identity records; `durable/` holds other rootSecret-scoped
// records that MUST survive a redeploy — notably the §6.2 claim-seed counter, whose reset would cause
// catastrophic seed reuse. Both are preserved across redeploys.
export const IDENTITY_PREFIX = 'identity/';
export const DURABLE_PREFIX = 'durable/';
export const NAMESPACE_KEY = 'identity/__namespace__';

/** Keys that survive resetChainState (deployment change) — identity + durable rootSecret-scoped records. */
export function isPreserved(key: string): boolean {
  return key.startsWith(IDENTITY_PREFIX) || key.startsWith(DURABLE_PREFIX);
}

const textEncoder = new TextEncoder();

/** Deployment-binding marker: a store whose stored marker differs on open resets chain-derived state. */
export function encodeNamespace(ns: StorageNamespace): Uint8Array {
  return textEncoder.encode(`${ns.schemaVersion}|${ns.chainId}|${ns.poolAddress.toLowerCase()}|${ns.deployBlock}`);
}

/**
 * Guard against rebinding an open adapter (WS-5). Returns `true` when the adapter is already open under this same
 * namespace (re-opening is a no-op), `false` when it isn't open yet, and throws `StorageConflictError` when it's
 * open under a different one — re-running the deployment-change reset would wipe the chain state of whoever is
 * using it.
 */
export function assertSameBinding(adapter: string, bound: Uint8Array | undefined, requested: Uint8Array): boolean {
  if (bound === undefined) return false;
  if (bytesEqual(bound, requested)) return true;
  throw new StorageConflictError(
    `${adapter}: already open under another deployment namespace; close it (or use a separate store) before opening another`,
  );
}

/** Throw `InstanceClosedError` for a call on a closed adapter (one that hasn't been opened again since). */
export function assertNotClosed(adapter: string, closed: boolean): void {
  if (closed) throw new InstanceClosedError(`${adapter}: used after close() (open() it again first)`);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
