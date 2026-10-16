// ABOUTME: Disclosure package checker (ADR-0020) — verifies both EIP-712 signatures, every disclosure
// ABOUTME: proof and every hop (H1–H6) against chain events, returning the first failing check by name.

import { AbiCoder, keccak256, getAddress } from 'ethers';
import { ShieldNote, getTokenDataHash } from '../core/index';
import type { ProverAdapter } from '../prover/index';
import { hashHops, statementHashField, verifyEndpointSignature } from './statement';
import type { DisclosureChainSource } from './chain-source';
import {
  DISCLOSURE_PACKAGE_VERSION,
  SHIELD_ALLOCATION_TYPE,
  type CommitmentLocation,
  type DisclosurePackage,
  type DisclosureProofEntry,
  type Hop,
  type NoteOpening,
} from './types';

/** The name of each check the verifier runs; a failure reports exactly one of these. */
export type DisclosureCheckName =
  | 'package-version'
  | 'statement-hops-hash'
  | 'endpoint-signature'
  | 'hop-reference'
  | 'opening-master-public-key'
  | 'opening-npk'
  | 'shield-commitment'
  | 'shield-sender'
  | 'transact-commitment'
  | 'proof-statement-hash'
  | 'proof-master-public-key'
  | 'proof-verification'
  | 'spend-leaf-position'
  | 'nullifier-event'
  | 'deposit-binding'
  | 'deposited-event'
  | 'finalized-shield-allocation'
  | 'unshield-event';

export interface DisclosureCheckFailure {
  readonly check: DisclosureCheckName;
  /** The index of the hop that failed, or undefined for a package-wide check. */
  readonly hop?: number;
  readonly detail: string;
}

/** What a verifier learns from a package that passes every check. */
export interface DisclosureLearned {
  readonly masterPublicKey: string;
  readonly endpoints: readonly { role: string; account: string }[];
  readonly transactionIds: readonly string[];
  readonly channelIds: readonly string[];
}

export interface DisclosureCheckResult {
  readonly ok: boolean;
  readonly failure?: DisclosureCheckFailure;
  readonly learned?: DisclosureLearned;
}

export interface CheckDisclosureParams {
  readonly package: DisclosurePackage;
  readonly source: DisclosureChainSource;
  readonly prover: ProverAdapter;
  /** The disclosure circuit's verifying key (`ArtifactSet.vkey`). */
  readonly vkey: object;
}
function failure(check: DisclosureCheckName, detail: string, hop?: number): DisclosureCheckResult {
  return { ok: false, failure: hop === undefined ? { check, detail } : { check, detail, hop } };
}

/** Recompute the commitment hash Poseidon(npk, tokenHash, value) for an opened note. */
function commitmentHash(opening: NoteOpening): bigint {
  return ShieldNote.getShieldNoteHash(BigInt(opening.npk), getTokenDataHash(opening.token), BigInt(opening.value));
}

/**
 * Verify every EIP-712 signature, every referenced disclosure proof and every hop. Returns on the
 * first failing check, naming the check and the hop it belongs to.
 */
export async function checkDisclosurePackage(params: CheckDisclosureParams): Promise<DisclosureCheckResult> {
  const pkg = params.package;

  if (pkg.version !== DISCLOSURE_PACKAGE_VERSION) {
    return failure('package-version', `unsupported package version ${String(pkg.version)}`);
  }

  // Package-wide: the signed hop hash must match the actual hop list, and every named endpoint must
  // carry a valid signature over the statement.
  if (hashHops(pkg.hops) !== pkg.statement.hopsHash) {
    return failure('statement-hops-hash', 'hopsHash does not match the hop list');
  }

  const statementHash = statementHashField(pkg.domain, pkg.statement).toString();

  for (const endpoint of pkg.statement.endpoints) {
    const sig = pkg.endpointSignatures.find((s) => s.role === endpoint.role && s.account === endpoint.account);
    if (sig === undefined) {
      return failure('endpoint-signature', `no signature for endpoint role "${endpoint.role}"`);
    }
    if (!verifyEndpointSignature(pkg.domain, pkg.statement, endpoint.account, sig.signature)) {
      return failure('endpoint-signature', `signature for endpoint role "${endpoint.role}" does not recover to ${endpoint.account}`);
    }
  }

  const openingByLabel = new Map(pkg.openings.map((o) => [o.label, o]));
  const proofById = new Map(pkg.proofs.map((p) => [p.id, p]));
  const endpointByRole = new Map(pkg.statement.endpoints.map((e) => [e.role, e]));
  const verifiedProofs = new Set<string>();

  // Verify one proof: its public statement hash and masterPublicKey must match the statement, and the
  // Groth16 proof must verify against the disclosure vkey. Cached so a shared proof verifies once.
  const verifyProof = async (entry: DisclosureProofEntry, hopIndex: number): Promise<DisclosureCheckResult | null> => {
    if (verifiedProofs.has(entry.id)) {
      return null;
    }
    if (entry.statementHash !== statementHash) {
      return failure('proof-statement-hash', `proof "${entry.id}" statementHash is not the statement's`, hopIndex);
    }
    if (entry.masterPublicKey !== pkg.statement.masterPublicKey) {
      return failure('proof-master-public-key', `proof "${entry.id}" masterPublicKey is not the statement's`, hopIndex);
    }
    const signals = [
      BigInt(entry.statementHash),
      BigInt(entry.masterPublicKey),
      BigInt(entry.nullifier),
      BigInt(entry.treeNumber),
      BigInt(entry.leafIndex),
    ];
    const ok = await params.prover.verify(entry.proof, signals, params.vkey);
    if (!ok) {
      return failure('proof-verification', `proof "${entry.id}" does not verify`, hopIndex);
    }
    verifiedProofs.add(entry.id);
    return null;
  };

  // Resolve a referenced opening/proof/endpoint, or report a hop-reference failure.
  const requireOpening = (label: string, hopIndex: number): NoteOpening | DisclosureCheckResult => {
    const opening = openingByLabel.get(label);
    return opening ?? failure('hop-reference', `hop references unknown opening "${label}"`, hopIndex);
  };

  // Check an opened note: its masterPublicKey is the statement's, and npk == Poseidon(M, random).
  const checkOpening = (opening: NoteOpening, hopIndex: number): DisclosureCheckResult | null => {
    if (opening.masterPublicKey !== pkg.statement.masterPublicKey) {
      return failure('opening-master-public-key', `opening "${opening.label}" is not for the statement's masterPublicKey`, hopIndex);
    }
    const npk = ShieldNote.getNotePublicKey(BigInt(opening.masterPublicKey), opening.random);
    if (npk !== BigInt(opening.npk)) {
      return failure('opening-npk', `opening "${opening.label}" npk != Poseidon(M, random)`, hopIndex);
    }
    return null;
  };

  // Check that a shield commitment at `loc` matches the opened note.
  const checkShieldLocation = (opening: NoteOpening, loc: CommitmentLocation, hopIndex: number): DisclosureCheckResult | null => {
    if (opening.tree !== loc.tree || opening.position !== loc.position) {
      return failure('shield-commitment', `opening "${opening.label}" position does not match hop shield location`, hopIndex);
    }
    const record = params.source
      .shieldsIn(loc.txid)
      .find((s) => s.tree === loc.tree && s.position === loc.position);
    if (record === undefined) {
      return failure('shield-commitment', `no Shield commitment at (${loc.txid}, tree ${loc.tree}, position ${loc.position})`, hopIndex);
    }
    if (BigInt(`0x${record.hash}`) !== commitmentHash(opening)) {
      return failure('shield-commitment', `Shield commitment at (${loc.txid}) does not match the opened note`, hopIndex);
    }
    return null;
  };

  const transactionIds = new Set<string>();
  const channelIds = new Set<string>();

  for (let i = 0; i < pkg.hops.length; i++) {
    const hop = pkg.hops[i]!;
    const result = await checkHop(hop, i);
    if (result !== null) {
      return result;
    }
  }

  // Verify one hop; returns a failure result, or null when the hop passes.
  async function checkHop(hop: Hop, i: number): Promise<DisclosureCheckResult | null> {
    switch (hop.kind) {
      case 'H1': {
        const opening = requireOpening(hop.note, i);
        if ('ok' in opening) return opening;
        const endpoint = endpointByRole.get(hop.endpoint);
        if (endpoint === undefined) return failure('hop-reference', `H1 references unknown endpoint "${hop.endpoint}"`, i);
        const openErr = checkOpening(opening, i);
        if (openErr !== null) return openErr;
        const shieldErr = checkShieldLocation(opening, hop.shield, i);
        if (shieldErr !== null) return shieldErr;
        const sender = params.source.senderOf(hop.shield.txid);
        if (sender !== undefined && !addressesEqual(sender, endpoint.account)) {
          return failure('shield-sender', `Shield tx sender ${sender} is not endpoint ${endpoint.account}`, i);
        }
        transactionIds.add(hop.shield.txid);
        return null;
      }
      case 'H2': {
        const opening = requireOpening(hop.spends, i);
        if ('ok' in opening) return opening;
        const proof = proofById.get(hop.proof);
        if (proof === undefined) return failure('hop-reference', `H2 references unknown proof "${hop.proof}"`, i);
        const proofErr = await verifyProof(proof, i);
        if (proofErr !== null) return proofErr;
        const posErr = checkSpendLeaf(proof, opening, i);
        if (posErr !== null) return posErr;
        const nullErr = checkNullifierEvent(proof, hop.nullifiedTxid, i);
        if (nullErr !== null) return nullErr;
        transactionIds.add(hop.nullifiedTxid);
        return null;
      }
      case 'H3': {
        const opening = requireOpening(hop.note, i);
        if ('ok' in opening) return opening;
        const openErr = checkOpening(opening, i);
        if (openErr !== null) return openErr;
        if (opening.tree !== hop.transact.tree || opening.position !== hop.transact.position) {
          return failure('transact-commitment', `opening "${opening.label}" position does not match hop transact location`, i);
        }
        const record = params.source
          .transactsIn(hop.transact.txid)
          .find((t) => t.tree === hop.transact.tree && t.position === hop.transact.position);
        if (record === undefined) {
          return failure('transact-commitment', `no Transact commitment at (${hop.transact.txid}, tree ${hop.transact.tree}, position ${hop.transact.position})`, i);
        }
        if (BigInt(`0x${record.hash}`) !== commitmentHash(opening)) {
          return failure('transact-commitment', `Transact commitment at (${hop.transact.txid}) does not match the opened note`, i);
        }
        transactionIds.add(hop.transact.txid);
        return null;
      }
      case 'H4': {
        const proof = proofById.get(hop.proof);
        if (proof === undefined) return failure('hop-reference', `H4 references unknown proof "${hop.proof}"`, i);
        const proofErr = await verifyProof(proof, i);
        if (proofErr !== null) return proofErr;
        // The funding spend must publish its nullifier in the deposit transaction. Without this check a
        // prover pairs a proof for any of their own notes with another wallet's real Deposited event.
        const nullErr = checkNullifierEvent(proof, hop.depositTxid, i);
        if (nullErr !== null) return nullErr;
        const deposit = params.source
          .depositsIn(hop.depositTxid)
          .find((d) => addressesEqual(d.channelId, hop.channelId));
        if (deposit === undefined) {
          return failure('deposited-event', `no Deposited event for channel ${hop.channelId} in ${hop.depositTxid}`, i);
        }
        const binding = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [hop.channelId, BigInt(hop.expectedHeld)]));
        if (BigInt(deposit.adaptParams) !== BigInt(binding)) {
          return failure('deposit-binding', `deposit adaptParams != depositBinding(channelId, expectedHeld) in ${hop.depositTxid}`, i);
        }
        if (!addressesEqual(deposit.asset, hop.asset)) {
          return failure('deposited-event', `Deposited asset ${deposit.asset} != ${hop.asset} in ${hop.depositTxid}`, i);
        }
        transactionIds.add(hop.depositTxid);
        channelIds.add(hop.channelId);
        return null;
      }
      case 'H5': {
        const opening = requireOpening(hop.note, i);
        if ('ok' in opening) return opening;
        const openErr = checkOpening(opening, i);
        if (openErr !== null) return openErr;
        const outcome = params.source
          .finalizedOutcomesIn(hop.concludeTxid)
          .find((o) => addressesEqual(o.channelId, hop.channelId));
        const paysNote = outcome?.allocations.some(
          (a) => a.allocationType === SHIELD_ALLOCATION_TYPE && BigInt(a.destination) === BigInt(opening.npk),
        );
        if (outcome === undefined || paysNote !== true) {
          return failure('finalized-shield-allocation', `channel ${hop.channelId} has no SHIELD allocation to note "${opening.label}" in ${hop.concludeTxid}`, i);
        }
        const shieldErr = checkShieldLocation(opening, hop.shield, i);
        if (shieldErr !== null) return shieldErr;
        transactionIds.add(hop.concludeTxid);
        transactionIds.add(hop.shield.txid);
        channelIds.add(hop.channelId);
        return null;
      }
      case 'H6': {
        const opening = requireOpening(hop.spends, i);
        if ('ok' in opening) return opening;
        const proof = proofById.get(hop.proof);
        if (proof === undefined) return failure('hop-reference', `H6 references unknown proof "${hop.proof}"`, i);
        const endpoint = endpointByRole.get(hop.endpoint);
        if (endpoint === undefined) return failure('hop-reference', `H6 references unknown endpoint "${hop.endpoint}"`, i);
        const proofErr = await verifyProof(proof, i);
        if (proofErr !== null) return proofErr;
        const posErr = checkSpendLeaf(proof, opening, i);
        if (posErr !== null) return posErr;
        const nullErr = checkNullifierEvent(proof, hop.unshieldTxid, i);
        if (nullErr !== null) return nullErr;
        const paidOut = params.source.unshieldsIn(hop.unshieldTxid).some((u) => addressesEqual(u.to, endpoint.account));
        if (!paidOut) {
          return failure('unshield-event', `no Unshield to ${endpoint.account} in ${hop.unshieldTxid}`, i);
        }
        transactionIds.add(hop.unshieldTxid);
        return null;
      }
    }
  }

  // A disclosure proof binds a nullifier at (treeNumber, leafIndex); the spent note's opening must sit
  // at exactly that leaf.
  function checkSpendLeaf(proof: DisclosureProofEntry, opening: NoteOpening, hopIndex: number): DisclosureCheckResult | null {
    if (proof.treeNumber !== opening.tree || proof.leafIndex !== opening.position) {
      return failure('spend-leaf-position', `proof "${proof.id}" leaf (${proof.treeNumber}, ${proof.leafIndex}) != opening "${opening.label}" (${opening.tree}, ${opening.position})`, hopIndex);
    }
    return null;
  }

  // The proof's nullifier must appear in the named transaction's Nullified event, in the proof's tree.
  function checkNullifierEvent(proof: DisclosureProofEntry, txid: string, hopIndex: number): DisclosureCheckResult | null {
    const found = params.source
      .nullifiersIn(txid)
      .some((n) => n.tree === proof.treeNumber && n.nullifier === BigInt(proof.nullifier));
    if (!found) {
      return failure('nullifier-event', `nullifier of proof "${proof.id}" not in Nullified event of ${txid}`, hopIndex);
    }
    return null;
  }

  return {
    ok: true,
    learned: {
      masterPublicKey: pkg.statement.masterPublicKey,
      endpoints: pkg.statement.endpoints.map((e) => ({ role: e.role, account: e.account })),
      transactionIds: [...transactionIds],
      channelIds: [...channelIds],
    },
  };
}

/** Compare two hex strings (addresses or bytes32) by value, tolerant of 0x case and padding. */
function addressesEqual(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return BigInt(a) === BigInt(b);
  }
}
