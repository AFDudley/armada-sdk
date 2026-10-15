// ABOUTME: Wrapper calldata builders (SPEC §4.6) — encode a proved Transaction into the yield / cross-chain-unshield
// ABOUTME: wrapper entry points, and encode/decode the gasless shield calls, so no consumer hand-rolls these ABIs.

import { Interface } from 'ethers';
import { TRANSACTION_STRUCT } from './decode';
import { transactionToTuple, type TransactionData } from './serialize';
import type { TransactCalldata } from './index';
import type { ShieldRequest } from './shield';
import type { ShieldData } from './gasless-cross-chain-shield';
import { InvalidRequestError } from '../errors';

// The wrapper entry points, byte-exact against the deployed contracts (selectors 0x2bcba06a /
// 0xf2987ad1 / 0x7e220759). Each embeds the on-chain `Transaction` at arg 0.
const WRAPPER_ABI = [
  `function atomicCrossChainUnshield(${TRANSACTION_STRUCT} _transaction, uint32 destinationDomain, address finalRecipient, uint256 maxFee, bytes32 uniqueNonce) returns (uint64)`,
  `function lendAndShield(${TRANSACTION_STRUCT} _transaction, bytes32 _npk, (bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext) returns (uint256)`,
  `function redeemAndShield(${TRANSACTION_STRUCT} _transaction, bytes32 _npk, (bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext, bytes32 _feeNpk, (bytes32[3] encryptedBundle, bytes32 shieldKey) _feeShieldCiphertext, uint256 _feeAmount) returns (uint256)`,
] as const;

const iface = new Interface(WRAPPER_ABI as unknown as string[]);

/** A shield note's on-chain re-shield ciphertext (matches Globals.ShieldCiphertext). */
export interface ShieldCiphertextArg {
  readonly encryptedBundle: readonly [string, string, string];
  readonly shieldKey: string;
}

const hx = (s: string): string => (s.startsWith('0x') ? s : `0x${s}`);
const b32 = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const ctTuple = (c: ShieldCiphertextArg): unknown[] => [c.encryptedBundle.map(hx), hx(c.shieldKey)];

/**
 * `atomicCrossChainUnshield(tx, destinationDomain, finalRecipient, maxFee, uniqueNonce)` — a cross-chain
 * unshield. `to` is the PrivacyPool (the router declares the entry point). The proof must bind
 * `boundParams.adaptParams = encodeCctpBinding(finalRecipient, destinationDomain, maxFee)`.
 */
export function buildAtomicCrossChainUnshieldCalldata(
  tx: TransactionData,
  params: {
    readonly poolAddress: `0x${string}`;
    readonly destinationDomain: number;
    readonly finalRecipient: `0x${string}`;
    readonly maxFee: bigint;
    readonly uniqueNonce: bigint;
  },
): TransactCalldata {
  const data = iface.encodeFunctionData('atomicCrossChainUnshield', [
    transactionToTuple(tx),
    params.destinationDomain,
    params.finalRecipient,
    params.maxFee,
    b32(params.uniqueNonce),
  ]) as `0x${string}`;
  return { to: params.poolAddress, data, value: 0n };
}

/**
 * `lendAndShield(tx, npk, shieldCiphertext)` — unshield USDC into the yield adapter, which deposits to
 * the vault and re-shields vault shares to `npk`. `to` is the ArmadaYieldAdapter. The proof must bind
 * `boundParams.adaptParams = encodeYieldDepositBinding(npk, encryptedBundle, shieldKey)`.
 */
export function buildLendAndShieldCalldata(
  tx: TransactionData,
  params: { readonly adapterAddress: `0x${string}`; readonly npk: bigint; readonly shieldCiphertext: ShieldCiphertextArg },
): TransactCalldata {
  const data = iface.encodeFunctionData('lendAndShield', [
    transactionToTuple(tx),
    b32(params.npk),
    ctTuple(params.shieldCiphertext),
  ]) as `0x${string}`;
  return { to: params.adapterAddress, data, value: 0n };
}

/**
 * `redeemAndShield(tx, npk, shieldCiphertext, feeNpk, feeShieldCiphertext, feeAmount)` — unshield vault
 * shares into the adapter, redeem, and re-shield `(assets − feeAmount)` to `npk` and `feeAmount` to the
 * relayer's `feeNpk`. `to` is the ArmadaYieldAdapter. The proof must bind
 * `boundParams.adaptParams = encodeYieldRedeemBinding(...)` over both notes. (The relayer fee here is
 * contract-side — NOT a broadcaster output inside the Transaction.)
 */
export function buildRedeemAndShieldCalldata(
  tx: TransactionData,
  params: {
    readonly adapterAddress: `0x${string}`;
    readonly npk: bigint;
    readonly shieldCiphertext: ShieldCiphertextArg;
    readonly feeNpk: bigint;
    readonly feeShieldCiphertext: ShieldCiphertextArg;
    readonly feeAmount: bigint;
  },
): TransactCalldata {
  const data = iface.encodeFunctionData('redeemAndShield', [
    transactionToTuple(tx),
    b32(params.npk),
    ctTuple(params.shieldCiphertext),
    b32(params.feeNpk),
    ctTuple(params.feeShieldCiphertext),
    params.feeAmount,
  ]) as `0x${string}`;
  return { to: params.adapterAddress, data, value: 0n };
}

// ── Gasless shields (#410) ──
// The gasless wrapper entry points, matching GaslessShieldWrapper / GaslessShieldWrapperClient (and the ABI
// armada-interface submits through the relayer).
const SHIELD_REQUEST = '(bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, (bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext';
const SHIELD_DATA = '(bytes32 npk, uint120 value, bytes32[3] encryptedBundle, bytes32 shieldKey, address integrator)';
const gaslessIface = new Interface([
  `function gaslessShield((address user, uint256 deadline, uint256 nonce, address integrator, uint8 permitV, bytes32 permitR, bytes32 permitS) params, bytes intentSig, (${SHIELD_REQUEST})[] shieldRequests)`,
  `function gaslessCrossChainShield((address user, uint256 deadline, uint256 nonce, uint256 maxFee, uint32 minFinalityThreshold, uint8 permitV, bytes32 permitR, bytes32 permitS) params, bytes intentSig, ${SHIELD_DATA} userNote, ${SHIELD_DATA} feeNote) returns (uint64)`,
]);

/** `GaslessShieldWrapper.ShieldIntentParams` — the replay params the intent binds, plus the EIP-2612 permit signature. */
export interface GaslessShieldParams {
  readonly user: `0x${string}`;
  readonly deadline: bigint;
  readonly nonce: bigint;
  readonly integrator: `0x${string}`;
  readonly permitV: number;
  readonly permitR: `0x${string}`;
  readonly permitS: `0x${string}`;
}

/** `GaslessShieldWrapperClient.CrossChainIntentParams` — the replay + CCTP params the intent binds, plus the permit. */
export interface GaslessCrossChainShieldParams {
  readonly user: `0x${string}`;
  readonly deadline: bigint;
  readonly nonce: bigint;
  readonly maxFee: bigint;
  readonly minFinalityThreshold: number;
  readonly permitV: number;
  readonly permitR: `0x${string}`;
  readonly permitS: `0x${string}`;
}

const shieldRequestTuple = (r: ShieldRequest): unknown[] => [
  [hx(r.preimage.npk), [r.preimage.token.tokenType, r.preimage.token.tokenAddress, r.preimage.token.tokenSubID], r.preimage.value],
  [r.ciphertext.encryptedBundle.map(hx), hx(r.ciphertext.shieldKey)],
];
const shieldDataTuple = (n: ShieldData): unknown[] => [n.npk, n.value, n.encryptedBundle.map(hx), n.shieldKey, n.integrator];

/**
 * `gaslessShield(params, intentSig, shieldRequests)` — a permit-pulled, relayer-submitted shield. `to` is the
 * GaslessShieldWrapper. `shieldRequests` must be the exact array the signed intent's `requestsHash` covers
 * (see `buildGaslessShield`).
 */
export function buildGaslessShieldCalldata(input: {
  readonly wrapperAddress: `0x${string}`;
  readonly params: GaslessShieldParams;
  readonly intentSig: `0x${string}`;
  readonly shieldRequests: readonly ShieldRequest[];
}): TransactCalldata {
  const p = input.params;
  const data = gaslessIface.encodeFunctionData('gaslessShield', [
    [p.user, p.deadline, p.nonce, p.integrator, p.permitV, p.permitR, p.permitS],
    input.intentSig,
    input.shieldRequests.map(shieldRequestTuple),
  ]) as `0x${string}`;
  return { to: input.wrapperAddress, data, value: 0n };
}

/**
 * `gaslessCrossChainShield(params, intentSig, userNote, feeNote)` — a permit-pulled, relayer-submitted shield from
 * a client chain to the hub over CCTP. `to` is the GaslessShieldWrapperClient. The notes must be the exact ones the
 * signed intent binds (see `buildGaslessCrossChainShield`).
 */
export function buildGaslessCrossChainShieldCalldata(input: {
  readonly clientWrapperAddress: `0x${string}`;
  readonly params: GaslessCrossChainShieldParams;
  readonly intentSig: `0x${string}`;
  readonly userNote: ShieldData;
  readonly feeNote: ShieldData;
}): TransactCalldata {
  const p = input.params;
  const data = gaslessIface.encodeFunctionData('gaslessCrossChainShield', [
    [p.user, p.deadline, p.nonce, p.maxFee, p.minFinalityThreshold, p.permitV, p.permitR, p.permitS],
    input.intentSig,
    shieldDataTuple(input.userNote),
    shieldDataTuple(input.feeNote),
  ]) as `0x${string}`;
  return { to: input.clientWrapperAddress, data, value: 0n };
}

// Decode one gasless call's arguments, rejecting calldata for any other function.
function decodeGasless(name: 'gaslessShield' | 'gaslessCrossChainShield', calldata: string): ReturnType<Interface['decodeFunctionData']> {
  const fn = gaslessIface.getFunction(name)!;
  if (calldata.slice(0, 10).toLowerCase() !== fn.selector) {
    throw new InvalidRequestError(`decode ${name}: calldata is not a ${name} call (selector ${calldata.slice(0, 10)})`);
  }
  return gaslessIface.decodeFunctionData(fn, calldata);
}

const lower = (a: unknown): `0x${string}` => String(a).toLowerCase() as `0x${string}`;
const word = (v: unknown): string => `0x${BigInt(v as bigint).toString(16).padStart(64, '0')}`;

/** The shield request as the SDK's builders produce it (lowercase address, 32-byte hex tokenSubID). */
function shieldRequestFrom(t: unknown[]): ShieldRequest {
  const [npk, token, value] = t[0] as [string, [bigint, string, bigint], bigint];
  const [bundle, shieldKey] = t[1] as [string[], string];
  return {
    preimage: { npk, token: { tokenType: Number(token[0]), tokenAddress: lower(token[1]), tokenSubID: word(token[2]) }, value },
    ciphertext: { encryptedBundle: [bundle[0]!, bundle[1]!, bundle[2]!], shieldKey },
  };
}

function shieldDataFrom(t: unknown[]): ShieldData {
  const [npk, value, bundle, shieldKey, integrator] = t as [string, bigint, string[], string, string];
  return {
    npk: npk as `0x${string}`, value, encryptedBundle: [bundle[0]!, bundle[1]!, bundle[2]!],
    shieldKey: shieldKey as `0x${string}`, integrator: lower(integrator),
  };
}

/**
 * Decode `gaslessShield` calldata — what a relayer receives — back into its params, intent signature and shield
 * requests, e.g. to verify the fee note (`verifyShieldFeeNote`) or check `hashShieldRequests` against the intent.
 * Throws `InvalidRequestError` for calldata of any other function.
 */
export function decodeGaslessShieldCalldata(calldata: string): {
  params: GaslessShieldParams;
  intentSig: `0x${string}`;
  shieldRequests: ShieldRequest[];
} {
  const [p, intentSig, requests] = decodeGasless('gaslessShield', calldata) as unknown as [unknown[], string, unknown[]];
  return {
    params: {
      user: lower(p[0]), deadline: p[1] as bigint, nonce: p[2] as bigint, integrator: lower(p[3]),
      permitV: Number(p[4]), permitR: p[5] as `0x${string}`, permitS: p[6] as `0x${string}`,
    },
    intentSig: intentSig as `0x${string}`,
    shieldRequests: requests.map((r) => shieldRequestFrom(r as unknown[])),
  };
}

/**
 * Decode `gaslessCrossChainShield` calldata back into its params, intent signature and the two notes, e.g. for a
 * relayer to check its fee note's npk (`reconstructShieldNpk`) and value. Throws `InvalidRequestError` for calldata
 * of any other function.
 */
export function decodeGaslessCrossChainShieldCalldata(calldata: string): {
  params: GaslessCrossChainShieldParams;
  intentSig: `0x${string}`;
  userNote: ShieldData;
  feeNote: ShieldData;
} {
  const [p, intentSig, userNote, feeNote] = decodeGasless('gaslessCrossChainShield', calldata) as unknown as [unknown[], string, unknown[], unknown[]];
  return {
    params: {
      user: lower(p[0]), deadline: p[1] as bigint, nonce: p[2] as bigint, maxFee: p[3] as bigint,
      minFinalityThreshold: Number(p[4]), permitV: Number(p[5]), permitR: p[6] as `0x${string}`, permitS: p[7] as `0x${string}`,
    },
    intentSig: intentSig as `0x${string}`,
    userNote: shieldDataFrom(userNote),
    feeNote: shieldDataFrom(feeNote),
  };
}
