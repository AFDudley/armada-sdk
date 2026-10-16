// ABOUTME: LocalSigner (SPEC §4.2.1) — the default SpendSigner, holding the spending private key
// ABOUTME: derived from a rootSecret. Signs each intent digest with BabyJubjub EdDSA via core.

import { signEDDSA } from '../core/index';
import { deriveKeyset, deriveKeysetFromMnemonic, type Keyset } from './derive';
import { AbortedError, InvalidRequestError } from '../errors';
import type { SpendSigner, SpendSignRequest, SpendSignOptions, EddsaSignature } from './index';

/**
 * In-process signer derived from the wallet's rootSecret. It receives the entire batch of
 * fully-bound intents and signs each `message` (the pinned poseidon digest). This is everything the
 * repo does today; `ExternalSigner`/`ThresholdSigner` are drop-in swaps behind the same interface.
 */
export class LocalSigner implements SpendSigner {
  private disposed = false;

  private constructor(
    private readonly spendingPrivateKey: Uint8Array,
    private readonly spendingPublicKey: [bigint, bigint],
  ) {}

  /**
   * A signer over an already-derived keyset's spend key. It takes the keyset's `spendingPrivateKey` buffer as its own
   * (no copy), so `dispose()` zeroes the only copy of the key — the wallet doesn't keep one.
   */
  static fromKeyset(keyset: Keyset): LocalSigner {
    return new LocalSigner(keyset.spendingPrivateKey, keyset.spendingPublicKey);
  }

  static async fromRootSecret(rootSecret: Uint8Array): Promise<LocalSigner> {
    const keyset = await deriveKeyset(rootSecret);
    return new LocalSigner(keyset.spendingPrivateKey, keyset.spendingPublicKey);
  }

  /** Signer for a BIP-39 mnemonic-provisioned wallet (the relayer's) at `derivationIndex`. */
  static async fromMnemonic(mnemonic: string, derivationIndex = 0): Promise<LocalSigner> {
    const keyset = await deriveKeysetFromMnemonic(mnemonic, derivationIndex);
    return new LocalSigner(keyset.spendingPrivateKey, keyset.spendingPublicKey);
  }

  async getSpendingPublicKey(): Promise<[bigint, bigint]> {
    // Return a copy so a caller can't mutate the internal point (which feeds circuit inputs).
    return [this.spendingPublicKey[0], this.spendingPublicKey[1]];
  }

  async signBatch(requests: readonly SpendSignRequest[], options?: SpendSignOptions): Promise<EddsaSignature[]> {
    if (this.disposed) throw new InvalidRequestError('LocalSigner: used after dispose()');
    if (options?.signal?.aborted) throw new AbortedError('LocalSigner: aborted before signing');
    return requests.map((request) => {
      const sig = signEDDSA(this.spendingPrivateKey, request.message);
      return { R8: [sig.R8[0], sig.R8[1]] as [bigint, bigint], S: sig.S };
    });
  }

  /** Zeroize the spending private key (SPEC §4.2 zeroization) — the signer refuses to sign afterward. */
  dispose(): void {
    this.spendingPrivateKey.fill(0);
    this.disposed = true;
  }
}
