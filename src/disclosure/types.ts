// ABOUTME: Selective-disclosure package format (ADR-0020, armada-laconic engineering/16) — the typed
// ABOUTME: shapes for the statement, the note openings, the disclosure proofs and the six hop records.

import type { TokenData } from '../core/index';
import type { Groth16Proof } from '../prover/index';

/** The BN254 scalar field prime `r`. Every disclosure field element is reduced mod this value. */
export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The go-nitro allocation type that pays a shielded note (`ArmadaNitroAdjudicator.SHIELD`). */
export const SHIELD_ALLOCATION_TYPE = 3;

/** The current disclosure-package schema version. */
export const DISCLOSURE_PACKAGE_VERSION = 1 as const;

/** The six hop kinds (armada-laconic engineering/16-selective-disclosure.md, table "The hops"). */
export type HopKind = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6';

/**
 * The EIP-712 domain that scopes a disclosure statement to one pool deployment. `chainId` and
 * `verifyingContract` pin the pool, so a signature made for one pool cannot verify against another.
 */
export interface DisclosureDomain {
  readonly chainId: number;
  /** The Railgun pool contract address (checksummed or lower-case). */
  readonly verifyingContract: string;
}

/** One public address at an end of the chain, with the role the statement gives it. */
export interface DisclosureEndpoint {
  readonly role: string;
  /** The EOA (EVM address). */
  readonly account: string;
}

/**
 * The signed statement S (EIP-712 `Statement`). It names the wallet (`masterPublicKey`), the audit
 * recipient (`verifier`), the purpose (`context`), the public endpoints and a hash of the hop list.
 * The full hop list lives in the package; `hopsHash` binds it, so the typed-data schema stays small.
 */
export interface DisclosureStatement {
  /** `masterPublicKey` M as a decimal string (EIP-712 `uint256`). */
  readonly masterPublicKey: string;
  readonly verifier: string;
  readonly context: string;
  /** Unix seconds (EIP-712 `uint64`). */
  readonly issuedAt: number;
  readonly endpoints: readonly DisclosureEndpoint[];
  /** The armada-nitro adjudicator address (EIP-712 `address`); the zero address when no channel hop. */
  readonly adjudicator: string;
  /** `keccak256` of the canonical hop list (EIP-712 `bytes32`, 0x-prefixed). */
  readonly hopsHash: string;
}

/** An EIP-712 signature over S by one endpoint's EOA. */
export interface EndpointSignature {
  readonly role: string;
  readonly account: string;
  /** 0x-prefixed 65-byte signature. */
  readonly signature: string;
}

/**
 * The opening of one note: the `random` that, with M, reproduces the note public key `npk`, plus the
 * token and value that complete the commitment. `tree`/`position` locate the note's leaf in the pool.
 */
export interface NoteOpening {
  readonly label: string;
  /** `masterPublicKey` M as a decimal string. */
  readonly masterPublicKey: string;
  /** The 16-byte note random, 0x-prefixed hex. */
  readonly random: string;
  /** The note public key `npk`, 0x-prefixed hex. */
  readonly npk: string;
  readonly token: TokenData;
  /** The note value, decimal string. */
  readonly value: string;
  readonly tree: number;
  readonly position: number;
}

/** A disclosure proof for one nullifier, with its five public signals. */
export interface DisclosureProofEntry {
  readonly id: string;
  /** Public signal 0, decimal string. */
  readonly statementHash: string;
  /** Public signal 1, decimal string. */
  readonly masterPublicKey: string;
  /** Public signal 2, decimal string. */
  readonly nullifier: string;
  /** Public signal 3. */
  readonly treeNumber: number;
  /** Public signal 4. */
  readonly leafIndex: number;
  readonly proof: Groth16Proof;
}

/** A commitment leaf's location in a pool event. */
export interface CommitmentLocation {
  readonly txid: string;
  readonly tree: number;
  readonly position: number;
}

/** H1 · a public address shields a note. */
export interface Hop1 {
  readonly kind: 'H1';
  /** The endpoint role of the shielding EOA. */
  readonly endpoint: string;
  /** The opening label of the shielded note. */
  readonly note: string;
  readonly shield: CommitmentLocation;
}

/** H2 · a note is spent (a disclosure proof links its nullifier to its leaf). */
export interface Hop2 {
  readonly kind: 'H2';
  /** The opening label of the spent note. */
  readonly spends: string;
  /** The disclosure-proof id for this nullifier. */
  readonly proof: string;
  /** The transaction whose `Nullified` event publishes the nullifier. */
  readonly nullifiedTxid: string;
}

/** H3 · a spend creates an output note (the user opens the output commitment). */
export interface Hop3 {
  readonly kind: 'H3';
  readonly note: string;
  readonly transact: CommitmentLocation;
}

/** H4 · a spend funds an armada-nitro channel (`depositFromNote`). */
export interface Hop4 {
  readonly kind: 'H4';
  /** The disclosure-proof id of the funding nullifier (the same nullifier an H2 proves). */
  readonly proof: string;
  /** The channel id, 0x-prefixed `bytes32`. */
  readonly channelId: string;
  /** The `expectedHeld` bound into the deposit, decimal string. */
  readonly expectedHeld: string;
  /** The deposited asset (EVM address). */
  readonly asset: string;
  /** The transaction that carries the `Deposited` event and the bound unshield. */
  readonly depositTxid: string;
}

/** H5 · a channel pays a note (a finalized `SHIELD` allocation to the note public key). */
export interface Hop5 {
  readonly kind: 'H5';
  readonly note: string;
  readonly channelId: string;
  /** The transaction that finalizes the channel and shields the payout note. */
  readonly concludeTxid: string;
  readonly shield: CommitmentLocation;
}

/** H6 · a note leaves the pool to a public address (H2 on the spent note, plus the `Unshield` event). */
export interface Hop6 {
  readonly kind: 'H6';
  /** The opening label of the spent note. */
  readonly spends: string;
  readonly proof: string;
  /** The endpoint role of the withdrawal EOA. */
  readonly endpoint: string;
  readonly unshieldTxid: string;
}

export type Hop = Hop1 | Hop2 | Hop3 | Hop4 | Hop5 | Hop6;

/** A complete, forwardable disclosure package. */
export interface DisclosurePackage {
  readonly version: typeof DISCLOSURE_PACKAGE_VERSION;
  readonly domain: DisclosureDomain;
  readonly statement: DisclosureStatement;
  readonly endpointSignatures: readonly EndpointSignature[];
  readonly openings: readonly NoteOpening[];
  readonly proofs: readonly DisclosureProofEntry[];
  readonly hops: readonly Hop[];
}
