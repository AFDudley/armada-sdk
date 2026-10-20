// ABOUTME: recognizeRagequitNote (C6 S2) — confirm the on-chain payout preimage matches the commitment
// ABOUTME: planRagequit predicted, then insert a spendable TXO into the wallet's note store. The payout note
// ABOUTME: is contract-owned: it has NO ciphertext, so recognition reads the preimage in the clear and never
// ABOUTME: attempts a decrypt (a wrong assumption here would silently drop every ragequit payout).

import { TransactNote, getTokenDataERC20, getTokenDataHash } from '../core/index';
import type { TokenData } from '../core/index';
import { RagequitPreimageMismatchError } from '../errors';
import type { TXO } from './balances';

/** The on-chain payout-note preimage read from `PrivacyPool.preimageOf` in the clear (no ciphertext). */
export interface RagequitNotePreimage {
  /** The payout note's public key (`bytes32`) — the caller's npk. */
  readonly npk: `0x${string}`;
  /** The treasury token the payout is denominated in. */
  readonly token: TokenData;
  /** The payout value the contract paid (the bound `planRagequit` predicted). */
  readonly value: bigint;
}

/** Where the payout note landed in the UTXO merkletree, plus its provenance (for the TXO). */
export interface RagequitNoteContext {
  readonly tree: number;
  readonly position: number;
  /** The `ragequit` transaction that created the note — groups the wallet's receives per tx. */
  readonly txid: string;
  readonly blockNumber: number;
  /** 16-byte note random (hex, no `0x`) — the contract's deterministic note random, needed to re-prove the spend. */
  readonly random: string;
}

/** The commitment leaf `Poseidon(npk, tokenHash, value)` a payout preimage hashes to. */
export function ragequitNoteCommitment(preimage: RagequitNotePreimage): bigint {
  const tokenHash = getTokenDataHash(getTokenDataERC20(preimage.token.tokenAddress));
  return TransactNote.getHash(BigInt(preimage.npk), tokenHash, preimage.value);
}

/**
 * Recognize the contract-owned payout note after an on-chain `ragequit`: confirm the preimage read from
 * `preimageOf` hashes to the commitment `planRagequit` predicted, then insert a spendable TXO into the
 * wallet's note store (the same shape `txoFromNote` produces). No ciphertext is read and no decrypt is
 * attempted — the note is contract-owned, so its preimage is public (P2-CONTRACT item 3).
 *
 * @throws RagequitPreimageMismatchError when the preimage does not hash to `expectedCommitment` — the note
 *   is not the one `planRagequit` predicted, so inserting it would corrupt the store. Fail loud, never drop.
 */
export function recognizeRagequitNote(
  store: TXO[],
  preimage: RagequitNotePreimage,
  expectedCommitment: bigint,
  context: RagequitNoteContext,
): TXO {
  const commitment = ragequitNoteCommitment(preimage);
  if (commitment !== expectedCommitment) {
    throw new RagequitPreimageMismatchError(
      `recognizeRagequitNote: preimage hashes to ${commitment.toString()} but planRagequit predicted ${expectedCommitment.toString()}`,
    );
  }
  const tokenHash = getTokenDataHash(getTokenDataERC20(preimage.token.tokenAddress));
  const txo: TXO = {
    tree: context.tree,
    position: context.position,
    tokenHash,
    value: preimage.value,
    blockNumber: context.blockNumber,
    txid: context.txid,
    origin: 'transact',
    random: context.random,
    notePublicKey: BigInt(preimage.npk),
  };
  store.push(txo);
  return txo;
}
