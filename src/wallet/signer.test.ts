// ABOUTME: Custody-boundary tests — ExternalSigner conformance (same batch, same verifiable sigs as
// ABOUTME: LocalSigner) and view-only identity parity vs the keyset vector.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initPoseidonPromise, verifyEDDSA } from '../core/index';
import { LocalSigner } from './local-signer';
import { deriveKeyset } from './derive';
import { ExternalSigner } from './external-signer';
import { deriveViewOnlyIdentity } from './view-only';
import type { SpendSignRequest } from './index';
import { SignerContractViolationError } from '../errors';

interface KeysetVector {
  rootSecret: string;
  keyset: {
    masterPublicKey: string;
    nullifyingKey: string;
    spendingPublicKey: [string, string];
    viewingPublicKey: string;
    viewingPrivateKey: string;
    shieldedAddress: string;
  };
}
const V: KeysetVector = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../test/vectors/keyset-vectors.json'), 'utf8'),
).vectors[0];

const bigToHex = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const bytesToHex = (b: Uint8Array): string => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (hex: string): Uint8Array => {
  const s = hex.replace(/^0x/, '');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const req = (message: bigint): SpendSignRequest => ({
  message,
  context: {
    nullifiers: [], commitmentsOut: [], merkleRoot: 0n,
    commitmentCiphertext: [],
    boundParams: {
      treeNumber: 0, minGasPrice: 0n, unshield: 0, chainID: 0n,
      adaptContract: '0x0000000000000000000000000000000000000000',
      adaptParams: `0x${'00'.repeat(32)}`,
    },
    summary: { tokenAddress: '0x0000000000000000000000000000000000000000', inputTotal: 0n, outputs: [], changeValue: 0n },
  },
});

beforeAll(async () => {
  await initPoseidonPromise;
});

describe('ExternalSigner (custody boundary is swappable)', () => {
  it('delegates to a backend and matches LocalSigner byte-for-byte + verifies', async () => {
    const local = await LocalSigner.fromRootSecret(hexToBytes(V.rootSecret));
    // ExternalSigner backed by the same local signing material — simulates an out-of-process signer.
    const external = new ExternalSigner(
      (requests) => local.signBatch(requests),
      () => local.getSpendingPublicKey(),
    );
    const pubkey = await external.getSpendingPublicKey();
    expect(pubkey.map(bigToHex)).toEqual(V.keyset.spendingPublicKey);

    const messages = [111n, 222n, 333n];
    const localSigs = await local.signBatch(messages.map(req));
    const externalSigs = await external.signBatch(messages.map(req));
    expect(externalSigs).toEqual(localSigs);
    externalSigs.forEach((sig, i) => {
      expect(verifyEDDSA(messages[i]!, { R8: [sig.R8[0], sig.R8[1]], S: sig.S }, pubkey)).toBe(true);
    });
  });

  it('rejects a backend that returns the wrong number of signatures', async () => {
    const bad = new ExternalSigner(
      async () => [], // returns 0 signatures
      async () => [1n, 2n],
    );
    await expect(bad.signBatch([req(1n), req(2n)])).rejects.toBeInstanceOf(SignerContractViolationError);
  });

  it('forwards the abort signal to its backend (#140)', async () => {
    // WHY: a backend waiting on human approval had no way to learn the proof was cancelled.
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const external = new ExternalSigner(
      async (requests, options) => { seen = options?.signal; return requests.map(() => ({ R8: [1n, 2n], S: 3n })); },
      async () => [1n, 2n],
    );
    await external.signBatch([req(1n)], { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});

describe('view-only identity (SPEC §4.2.2)', () => {
  it('reproduces the keyset vector viewing/mpk/address from viewing key material', async () => {
    const spendingPublicKey: [bigint, bigint] = [BigInt(V.keyset.spendingPublicKey[0]), BigInt(V.keyset.spendingPublicKey[1])];
    const identity = await deriveViewOnlyIdentity(hexToBytes(V.keyset.viewingPrivateKey), spendingPublicKey);
    expect(bytesToHex(identity.viewingPublicKey)).toBe(V.keyset.viewingPublicKey);
    expect(bigToHex(identity.nullifyingKey)).toBe(V.keyset.nullifyingKey);
    expect(bigToHex(identity.masterPublicKey)).toBe(V.keyset.masterPublicKey);
    expect(identity.shieldedAddress).toBe(V.keyset.shieldedAddress);
  });
});

describe('LocalSigner key custody (#140)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('fromKeyset takes the keyset\'s spend key as its only copy, so dispose() zeroes it', async () => {
    // WHY: the wallet kept the keyset's spend key and LocalSigner derived a second copy; dispose() zeroed only its own,
    // leaving the wallet's copy in memory. Taking the derived buffer means there's one copy, and dispose() wipes it.
    const keyset = await deriveKeyset(new Uint8Array(32).fill(0x11));
    const signer = LocalSigner.fromKeyset(keyset);
    expect(await signer.getSpendingPublicKey()).toEqual(keyset.spendingPublicKey);
    expect(keyset.spendingPrivateKey.some((b) => b !== 0)).toBe(true);
    signer.dispose();
    expect(keyset.spendingPrivateKey.every((b) => b === 0)).toBe(true);
  });
});
