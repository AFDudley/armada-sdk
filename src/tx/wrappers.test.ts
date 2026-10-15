// ABOUTME: Tests for the wrapper calldata builders (§4.6) — each embeds a proved Transaction that the
// ABOUTME: wrapper-aware decodeTransact round-trips back, and the selectors match the deployed contracts.

import { describe, it, expect } from 'vitest';
import { Interface, ZeroAddress } from 'ethers';
import {
  buildAtomicCrossChainUnshieldCalldata,
  buildLendAndShieldCalldata,
  buildRedeemAndShieldCalldata,
  buildGaslessShieldCalldata,
  decodeGaslessShieldCalldata,
  buildGaslessCrossChainShieldCalldata,
  decodeGaslessCrossChainShieldCalldata,
} from './wrappers';
import { hashShieldRequests } from './gasless-shield';
import { hashShieldData, type ShieldData } from './gasless-cross-chain-shield';
import type { ShieldRequest } from './shield';
import { InvalidRequestError } from '../errors';
import { decodeTransact } from './decode';
import type { TransactionData } from './serialize';
import type { CommitmentCiphertextV2 } from '../sync/index';

const b32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const POOL = `0x${'11'.repeat(20)}` as const;
const ADAPTER = `0x${'22'.repeat(20)}` as const;
const CT: CommitmentCiphertextV2 = {
  ciphertext: [b32(1n), b32(2n), b32(3n), b32(4n)],
  blindedSenderViewingKey: new Uint8Array(32).fill(5),
  blindedReceiverViewingKey: new Uint8Array(32).fill(6),
  memo: '0x',
  annotationData: '0x',
};
const tx = (): TransactionData => ({
  proof: { a: ['1', '2'], b: [['3', '4'], ['5', '6']], c: ['7', '8'] },
  merkleRoot: 111n,
  nullifiers: [9n, 10n],
  commitments: [11n, 12n],
  boundParams: { treeNumber: 0, minGasPrice: 0n, unshield: 0, chainID: 31337n, adaptContract: ZeroAddress as `0x${string}`, adaptParams: b32(0n) as `0x${string}`, commitmentCiphertext: [CT] },
});
const shieldCt = { encryptedBundle: [b32(7n), b32(8n), b32(9n)] as [string, string, string], shieldKey: b32(10n) };

// decodeTransact recovers the embedded transaction's public fields regardless of the wrapper.
const expectRecovered = (data: string): void => {
  const selector = data.slice(0, 10);
  const [decoded] = decodeTransact(data);
  expect(decoded!.nullifiers).toEqual([9n, 10n]);
  expect(decoded!.commitments).toEqual([11n, 12n]);
  expect(decoded!.merkleRoot).toBe(111n);
  expect(decoded!.boundParams.chainID).toBe(31337n);
  expect(decoded!.commitmentCiphertexts).toHaveLength(1);
  return void selector;
};

describe('wrapper calldata builders (§4.6)', () => {
  it('atomicCrossChainUnshield — selector 0x2bcba06a, embedded Transaction round-trips', () => {
    const { to, data } = buildAtomicCrossChainUnshieldCalldata(tx(), {
      poolAddress: POOL, destinationDomain: 3, finalRecipient: `0x${'ab'.repeat(20)}`, maxFee: 500n, uniqueNonce: 7n,
    });
    expect(to).toBe(POOL);
    expect(data.slice(0, 10)).toBe('0x2bcba06a');
    expectRecovered(data);
  });

  it('lendAndShield — selector 0xf2987ad1, targets the adapter, round-trips', () => {
    const { to, data } = buildLendAndShieldCalldata(tx(), { adapterAddress: ADAPTER, npk: 42n, shieldCiphertext: shieldCt });
    expect(to).toBe(ADAPTER);
    expect(data.slice(0, 10)).toBe('0xf2987ad1');
    expectRecovered(data);
  });

  it('redeemAndShield — selector 0x7e220759, two-note fee params, round-trips', () => {
    const { to, data } = buildRedeemAndShieldCalldata(tx(), {
      adapterAddress: ADAPTER, npk: 42n, shieldCiphertext: shieldCt, feeNpk: 43n, feeShieldCiphertext: shieldCt, feeAmount: 1000n,
    });
    expect(to).toBe(ADAPTER);
    expect(data.slice(0, 10)).toBe('0x7e220759');
    expectRecovered(data);
  });

  it('decodeTransact throws on an unrecognized selector', () => {
    expect(() => decodeTransact('0xdeadbeef')).toThrow(/unrecognized selector/);
  });
});

// The gasless wrapper ABIs exactly as armada-interface encodes them against the deployed GaslessShieldWrapper /
// GaslessShieldWrapperClient — an independent definition the SDK's encoders must match byte for byte.
const INTERFACE_GASLESS_ABI = new Interface([
  {
    type: 'function', name: 'gaslessShield', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'params', type: 'tuple', components: [
        { name: 'user', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
        { name: 'integrator', type: 'address' }, { name: 'permitV', type: 'uint8' }, { name: 'permitR', type: 'bytes32' },
        { name: 'permitS', type: 'bytes32' },
      ] },
      { name: 'intentSig', type: 'bytes' },
      { name: 'shieldRequests', type: 'tuple[]', components: [
        { name: 'preimage', type: 'tuple', components: [
          { name: 'npk', type: 'bytes32' },
          { name: 'token', type: 'tuple', components: [
            { name: 'tokenType', type: 'uint8' }, { name: 'tokenAddress', type: 'address' }, { name: 'tokenSubID', type: 'uint256' },
          ] },
          { name: 'value', type: 'uint120' },
        ] },
        { name: 'ciphertext', type: 'tuple', components: [
          { name: 'encryptedBundle', type: 'bytes32[3]' }, { name: 'shieldKey', type: 'bytes32' },
        ] },
      ] },
    ],
  },
  {
    type: 'function', name: 'gaslessCrossChainShield', stateMutability: 'nonpayable', outputs: [{ name: 'cctpNonce', type: 'uint64' }],
    inputs: [
      { name: 'params', type: 'tuple', components: [
        { name: 'user', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
        { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' }, { name: 'permitV', type: 'uint8' },
        { name: 'permitR', type: 'bytes32' }, { name: 'permitS', type: 'bytes32' },
      ] },
      { name: 'intentSig', type: 'bytes' },
      ...['userNote', 'feeNote'].map((name) => ({ name, type: 'tuple', components: [
        { name: 'npk', type: 'bytes32' }, { name: 'value', type: 'uint120' }, { name: 'encryptedBundle', type: 'bytes32[3]' },
        { name: 'shieldKey', type: 'bytes32' }, { name: 'integrator', type: 'address' },
      ] })),
    ],
  },
]);

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WRAPPER = `0x${'33'.repeat(20)}` as const;
const SIG = `0x${'ab'.repeat(65)}` as const;
const request = (n: bigint): ShieldRequest => ({
  preimage: { npk: b32(n), token: { tokenType: 0, tokenAddress: USDC, tokenSubID: '0' }, value: 1_000n * n },
  ciphertext: { encryptedBundle: [b32(n + 1n), b32(n + 2n), b32(n + 3n)], shieldKey: b32(n + 4n) },
});
const note = (n: bigint): ShieldData => ({
  npk: b32(n) as `0x${string}`, value: 1_000n * n, encryptedBundle: [b32(n + 1n), b32(n + 2n), b32(n + 3n)],
  shieldKey: b32(n + 4n) as `0x${string}`, integrator: `0x${'44'.repeat(20)}`,
});
const permit = { permitV: 27, permitR: b32(21n) as `0x${string}`, permitS: b32(22n) as `0x${string}` };

describe('gasless wrapper calldata (#115)', () => {
  // WHY: the SDK stopped at typed data, so every consumer hand-wrote these wrapper ABIs; and the relayer must pull
  // the fee note back out of exactly this calldata to verify it.
  it('gaslessShield: matches the deployed ABI byte for byte, targets the wrapper, and decodes back', () => {
    const params = { user: `0x${'55'.repeat(20)}` as `0x${string}`, deadline: 1_000n, nonce: 4n, integrator: ZeroAddress as `0x${string}`, ...permit };
    const shieldRequests = [request(10n), request(20n)];
    const call = buildGaslessShieldCalldata({ wrapperAddress: WRAPPER, params, intentSig: SIG, shieldRequests });
    const reference = INTERFACE_GASLESS_ABI.encodeFunctionData('gaslessShield', [
      params,
      SIG,
      shieldRequests.map((r) => ({ preimage: { ...r.preimage, token: { ...r.preimage.token } }, ciphertext: r.ciphertext })),
    ]);
    expect(call).toEqual({ to: WRAPPER, data: reference, value: 0n });

    const decoded = decodeGaslessShieldCalldata(call.data);
    expect(decoded.params).toEqual(params);
    expect(decoded.intentSig).toBe(SIG);
    expect(hashShieldRequests(decoded.shieldRequests)).toBe(hashShieldRequests(shieldRequests));
  });

  it('gaslessCrossChainShield: matches the deployed ABI byte for byte, targets the client wrapper, and decodes back', () => {
    const params = { user: `0x${'55'.repeat(20)}` as `0x${string}`, deadline: 1_000n, nonce: 4n, maxFee: 300n, minFinalityThreshold: 1000, ...permit };
    const userNote = note(10n);
    const feeNote = note(20n);
    const call = buildGaslessCrossChainShieldCalldata({ clientWrapperAddress: WRAPPER, params, intentSig: SIG, userNote, feeNote });
    const reference = INTERFACE_GASLESS_ABI.encodeFunctionData('gaslessCrossChainShield', [params, SIG, userNote, feeNote]);
    expect(call).toEqual({ to: WRAPPER, data: reference, value: 0n });

    const decoded = decodeGaslessCrossChainShieldCalldata(call.data);
    expect(decoded.params).toEqual(params);
    expect(decoded.intentSig).toBe(SIG);
    expect(hashShieldData(decoded.userNote)).toBe(hashShieldData(userNote));
    expect(hashShieldData(decoded.feeNote)).toBe(hashShieldData(feeNote));
  });

  it('the gasless decoders reject calldata for any other function', () => {
    const other = buildLendAndShieldCalldata(tx(), { adapterAddress: ADAPTER, npk: 1n, shieldCiphertext: shieldCt }).data;
    expect(() => decodeGaslessShieldCalldata(other)).toThrow(InvalidRequestError);
    expect(() => decodeGaslessCrossChainShieldCalldata(other)).toThrow(InvalidRequestError);
  });
});
