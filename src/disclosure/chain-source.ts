// ABOUTME: The chain-event source the disclosure checker reads (ADR-0020). Pool events reuse the SDK's
// ABOUTME: decoded shapes; armada-nitro hub events (Deposited, finalized SHIELD outcomes) are typed here.

import type {
  DecodedNullifier,
  DecodedShieldCommitment,
  DecodedTransactCommitment,
  DecodedUnshield,
} from '../sync/event-decoder';

/** An armada-nitro `Deposited(channelId, asset, held)` event, with the spend's bound `adaptParams`. */
export interface HubDepositRecord {
  readonly txid: string;
  /** The channel id (go-nitro `destination`), 0x-prefixed `bytes32`. */
  readonly channelId: string;
  readonly asset: string;
  /** The deposited holding, decimal string. */
  readonly held: string;
  /** The `adaptParams` committed by the funding spend, 0x-prefixed `bytes32`. */
  readonly adaptParams: string;
}

/** One allocation of a finalized channel outcome. */
export interface HubAllocation {
  /** `bytes32` destination; for a `SHIELD` allocation this is the payout note public key. */
  readonly destination: string;
  /** The allocation amount, decimal string. */
  readonly amount: string;
  /** `ArmadaNitroAdjudicator.SHIELD` == 3 for a shielded payout. */
  readonly allocationType: number;
}

/** A finalized channel outcome for one asset. */
export interface HubFinalizedOutcomeRecord {
  readonly txid: string;
  readonly channelId: string;
  readonly asset: string;
  readonly allocations: readonly HubAllocation[];
}

/**
 * The read interface the checker uses. A verifier adapts its own chain access (RPC logs, an indexer)
 * to these per-transaction lookups. {@link InMemoryDisclosureChainSource} builds one from decoded
 * event arrays for tests and for a caller that already has the events in memory.
 */
export interface DisclosureChainSource {
  shieldsIn(txid: string): readonly DecodedShieldCommitment[];
  transactsIn(txid: string): readonly DecodedTransactCommitment[];
  nullifiersIn(txid: string): readonly DecodedNullifier[];
  unshieldsIn(txid: string): readonly DecodedUnshield[];
  depositsIn(txid: string): readonly HubDepositRecord[];
  finalizedOutcomesIn(txid: string): readonly HubFinalizedOutcomeRecord[];
  /** The sender (`from`) of a transaction, when known; used for the optional H1 sender check. */
  senderOf(txid: string): string | undefined;
}

export interface DisclosureChainData {
  readonly shields?: readonly DecodedShieldCommitment[];
  readonly transacts?: readonly DecodedTransactCommitment[];
  readonly nullifiers?: readonly DecodedNullifier[];
  readonly unshields?: readonly DecodedUnshield[];
  readonly deposits?: readonly HubDepositRecord[];
  readonly finalizedOutcomes?: readonly HubFinalizedOutcomeRecord[];
  /** Optional map of txid → sender address. */
  readonly senders?: Readonly<Record<string, string>>;
}

function indexByTxid<T extends { readonly txid: string }>(rows: readonly T[] | undefined): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const row of rows ?? []) {
    const bucket = index.get(row.txid);
    if (bucket === undefined) {
      index.set(row.txid, [row]);
    } else {
      bucket.push(row);
    }
  }
  return index;
}

/** An in-memory chain source built from decoded pool events and hub records. */
export class InMemoryDisclosureChainSource implements DisclosureChainSource {
  private readonly shields: Map<string, DecodedShieldCommitment[]>;
  private readonly transacts: Map<string, DecodedTransactCommitment[]>;
  private readonly nullifiers: Map<string, DecodedNullifier[]>;
  private readonly unshields: Map<string, DecodedUnshield[]>;
  private readonly deposits: Map<string, HubDepositRecord[]>;
  private readonly finalizedOutcomes: Map<string, HubFinalizedOutcomeRecord[]>;
  private readonly senders: Readonly<Record<string, string>>;

  constructor(data: DisclosureChainData) {
    this.shields = indexByTxid(data.shields);
    this.transacts = indexByTxid(data.transacts);
    this.nullifiers = indexByTxid(data.nullifiers);
    this.unshields = indexByTxid(data.unshields);
    this.deposits = indexByTxid(data.deposits);
    this.finalizedOutcomes = indexByTxid(data.finalizedOutcomes);
    this.senders = data.senders ?? {};
  }

  shieldsIn(txid: string): readonly DecodedShieldCommitment[] {
    return this.shields.get(txid) ?? [];
  }

  transactsIn(txid: string): readonly DecodedTransactCommitment[] {
    return this.transacts.get(txid) ?? [];
  }

  nullifiersIn(txid: string): readonly DecodedNullifier[] {
    return this.nullifiers.get(txid) ?? [];
  }

  unshieldsIn(txid: string): readonly DecodedUnshield[] {
    return this.unshields.get(txid) ?? [];
  }

  depositsIn(txid: string): readonly HubDepositRecord[] {
    return this.deposits.get(txid) ?? [];
  }

  finalizedOutcomesIn(txid: string): readonly HubFinalizedOutcomeRecord[] {
    return this.finalizedOutcomes.get(txid) ?? [];
  }

  senderOf(txid: string): string | undefined {
    return this.senders[txid];
  }
}
