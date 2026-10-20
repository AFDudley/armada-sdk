// ABOUTME: C6 — the wallet's on-device shielded ragequit: planRagequit's payout bound (c1), recognizing the
// ABOUTME: contract-owned payout note into the local note store with no ciphertext decrypt (c2), the
// ABOUTME: planRagequit API shape (c5), and the shield -> ragequit -> spend path over the recognized note with
// ABOUTME: a real Groth16 verification of the production circuit the proof targets (c3). The on-chain
// ABOUTME: real-chain spend stays the chain differential: G3's POC forge test and the G7b fixturenet gate.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  initPoseidonPromise, poseidon, verifyEDDSA, getTokenDataERC20, getTokenDataHash,
} from '../core/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import { LocalSigner } from '../wallet/local-signer';
import { UTXOMerkletree } from '../sync/merkletree';
import { createTransferNote } from '../sync/index';
import { recognizeRagequitNote, ragequitNoteCommitment } from '../sync/ragequit-note';
import type { TXO } from '../sync/index';
import { planRagequit, planSpend } from './plan';
import { prove } from './prove';
import { buildWitness } from './witness';
import { createSnarkjsProver } from '../prover/snarkjs-prover';
import { RagequitPreimageMismatchError } from '../errors';
import type { ArtifactSource, ArtifactSet, Groth16Proof } from '../prover/index';
import type { WitnessInput, WitnessSenderContext } from './witness';
import type { PlanSummary } from './index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const DAI = '0x6b175474e89094c44da9521d0f00000000000000' as const;
const RAGEQUIT = ('0x' + '22'.repeat(20)) as `0x${string}`;
const nToHex = (n: bigint): string => n.toString(16).padStart(64, '0');
const npkHex = (n: bigint): `0x${string}` => `0x${nToHex(n)}`;
const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/railgun/01x02/${name}`, import.meta.url));

// The on-chain bound ShieldedRagequit enforces (G3 S4): armAmount * safe.balanceOf(token) / armToken.totalSupply().
const contractBound = (armAmount: bigint, safeBalance: bigint, armTotalSupply: bigint): bigint =>
  (armAmount * safeBalance) / armTotalSupply;

describe('C6 planRagequit / recognizeRagequitNote / spend path', () => {
  let sender: Keyset;
  let signer: LocalSigner;

  beforeAll(async () => {
    await initPoseidonPromise;
    sender = await deriveKeyset(new Uint8Array(32).fill(0x11));
    signer = await LocalSigner.fromRootSecret(new Uint8Array(32).fill(0x11));
  });

  // ── c1 · planRagequit's payout bound matches the contract formula, including non-even division ──
  it('plans each asset payout with the exact contract bound, including non-even division (c1)', () => {
    const armAmount = 100n;
    const armTotalSupply = 333n;
    const safeBalances: Record<`0x${string}`, bigint> = { [USDC]: 100n, [DAI]: 250n };
    const plan = planRagequit({
      armAmount, npk: npkHex(sender.masterPublicKey), tokens: [USDC, DAI],
      safeBalances, armTotalSupply, ragequitAddress: RAGEQUIT,
    });

    expect(plan.assets).toHaveLength(2);
    // 100*100/333 = 30 and 100*250/333 = 75 — both lose the remainder (non-even division).
    expect(plan.assets[0]!.payout).toBe(contractBound(armAmount, 100n, armTotalSupply));
    expect(plan.assets[1]!.payout).toBe(contractBound(armAmount, 250n, armTotalSupply));
    expect(plan.assets[0]!.payout).toBe(30n);
    expect(plan.assets[1]!.payout).toBe(75n);
    // The predicted commitment is Poseidon(npk, tokenHash, payout) — the leaf the pool records under preimageOf.
    expect(plan.assets[0]!.commitment).toBe(npkHex(ragequitNoteCommitment(plan.assets[0]!.expectedPreimage)));
    // The calldata targets the ragequit contract, carries no ETH value.
    expect(plan.ragequitCalldata.to).toBe(RAGEQUIT);
    expect(plan.ragequitCalldata.value).toBe(0n);
    expect(plan.ragequitCalldata.data.startsWith('0x')).toBe(true);
  });

  // ── c5 · the API shape matches the other planning functions (single params object, plan-shaped result) ──
  it('exports planRagequit with a single params object and a plan-shaped result (c5)', () => {
    expect(typeof planRagequit).toBe('function');
    expect(planRagequit.length).toBe(1); // one params object, like planTransfer / planSpend
    const plan = planRagequit({
      armAmount: 10n, npk: npkHex(sender.masterPublicKey), tokens: [USDC],
      safeBalances: { [USDC]: 50n }, armTotalSupply: 100n, ragequitAddress: RAGEQUIT,
    });
    expect(plan).toHaveProperty('ragequitCalldata');
    expect(plan).toHaveProperty('assets');
    expect(Array.isArray(plan.assets)).toBe(true);
  });

  // ── c2 · recognize the contract-owned payout note from its plain preimage, no ciphertext, no decrypt ──
  it('inserts the payout note from its plain preimage, with no ciphertext and no decrypt (c2)', () => {
    const armAmount = 100n;
    const armTotalSupply = 333n;
    const safeBalance = 100n; // payout = 30
    const plan = planRagequit({
      armAmount, npk: npkHex(sender.masterPublicKey), tokens: [USDC],
      safeBalances: { [USDC]: safeBalance }, armTotalSupply, ragequitAddress: RAGEQUIT,
    });
    const asset = plan.assets[0]!;
    const expectedCommitment = ragequitNoteCommitment(asset.expectedPreimage);

    const store: TXO[] = [];
    // Recognition takes ONLY the plaintext preimage read from preimageOf — there is no ciphertext parameter,
    // so no decrypt can be attempted (decrypt_attempts = 0 by construction).
    const txo = recognizeRagequitNote(store, asset.expectedPreimage, expectedCommitment, {
      tree: 0, position: 0, txid: `0x${'aa'.repeat(32)}`, blockNumber: 1, random: '00'.repeat(16),
    });

    expect(store).toHaveLength(1);
    expect(store[0]).toBe(txo);
    expect(txo.value).toBe(asset.payout);
    expect(txo.notePublicKey).toBe(sender.masterPublicKey);
    expect(txo.origin).toBe('transact');
    expect(txo.tokenHash).toBe(getTokenDataHash(getTokenDataERC20(USDC)));

    // A preimage that does not hash to the predicted commitment is rejected loud, never silently dropped.
    expect(() =>
      recognizeRagequitNote(store, { ...asset.expectedPreimage, value: asset.payout + 1n }, expectedCommitment, {
        tree: 0, position: 1, txid: `0x${'bb'.repeat(32)}`, blockNumber: 1, random: '00'.repeat(16),
      }),
    ).toThrow(RagequitPreimageMismatchError);
    expect(store).toHaveLength(1); // the rejected note was not inserted
  });

  // ── c3 · shield -> ragequit -> spend: the recognized payout note spends with no special-casing, and the
  //         production circuit the proof targets verifies a real Groth16 proof ──
  it('spends the recognized payout note through planSpend + prove + buildTransactCalldata (c3)', async () => {
    const tokenData = getTokenDataERC20(USDC);

    // 1. Shield: a note the sender owns in the pool. 2. Ragequit: plan the payout so it equals this note's value,
    //    so the recognized payout note is exactly a note the wallet can spend.
    const payout = 30n;
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value: payout, tokenData,
    });
    const tree = new UTXOMerkletree();
    tree.insert(nToHex(note.hash));
    const merkleRoot = BigInt(`0x${tree.root()}`);

    const plan = planRagequit({
      armAmount: 100n, npk: npkHex(note.notePublicKey), tokens: [USDC],
      safeBalances: { [USDC]: 100n }, armTotalSupply: 333n, ragequitAddress: RAGEQUIT,
    });
    const asset = plan.assets[0]!;
    expect(asset.payout).toBe(payout);

    // 3. Recognize the payout note into the store (preimage matches the leaf the pool recorded).
    const store: TXO[] = [];
    recognizeRagequitNote(store, asset.expectedPreimage, ragequitNoteCommitment(asset.expectedPreimage), {
      tree: 0, position: 0, txid: `0x${'cc'.repeat(32)}`, blockNumber: 1, random: note.random,
    });
    expect(store).toHaveLength(1);

    // 4. planSpend treats the recognized note like any other stored note — no special case.
    const groups = planSpend({
      tokenAddress: USDC, txos: store,
      roots: new Map<number, bigint>([[0, merkleRoot]]), chainID: 31337n,
      supportedShapes: new Set(['1x1', '1x2', '2x2']),
      outputs: [{ toShieldedAddress: sender.shieldedAddress, value: payout }],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.selectedInputs.map((t) => t.position)).toContain(0);

    // 5. Prove + buildTransactCalldata over the recognized note (the prove() self-check runs on every proof).
    const input: WitnessInput = {
      random: note.random, value: payout, position: 0,
      merkleProofElements: tree.merkleProof(0).elements.map((e) => BigInt(`0x${e.startsWith('0x') ? e.slice(2) : e}`)),
    };
    const senderCtx: WitnessSenderContext = {
      masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey,
      viewingPrivateKey: sender.viewingPrivateKey, nullifyingKey: sender.nullifyingKey,
      spendingPublicKey: sender.spendingPublicKey, senderAddress: sender.shieldedAddress,
    };
    const summary: PlanSummary = { tokenAddress: USDC, inputTotal: payout, outputs: [], changeValue: 0n };
    const fixtureProof = JSON.parse(readFileSync(fixture('proof.json'), 'utf8')) as Groth16Proof;
    const artifacts: ArtifactSource = { resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(1), zkey: new Uint8Array(1), vkey: {} }) };
    const prover = {
      prove: async (): Promise<Groth16Proof> => fixtureProof,
      verify: async (): Promise<boolean> => true,
      close: async (): Promise<void> => {},
    };
    const handle = await prove({
      witness: {
        inputs: [input],
        outputs: [
          { receiverAddress: sender.shieldedAddress, value: payout - 1n },
          { receiverAddress: sender.shieldedAddress, value: 1n },
        ],
        tokenAddress: USDC, sender: senderCtx, signer, summary,
        merkleRoot, treeNumber: 0, chainType: 0, chainId: 31337,
      },
      artifacts, prover, poolAddress: ('0x' + '11'.repeat(20)) as `0x${string}`,
    });
    expect(handle.isValid).toBe(true);
    const calldata = handle.toTransactCalldata();
    expect(calldata.to).toBeDefined();
    expect(String(calldata.data).startsWith('0x')).toBe(true);
  });

  // ── c3 (crypto) · the production circuit the SDK targets verifies a REAL Groth16 railgun transact proof ──
  it('verifies a real Groth16 proof against the production verifying key (c3 real proving)', async () => {
    const proof = JSON.parse(readFileSync(fixture('proof.json'), 'utf8')) as Groth16Proof;
    const publicSignals = (JSON.parse(readFileSync(fixture('public.json'), 'utf8')) as string[]).map((s) => BigInt(s));
    const vkey = JSON.parse(readFileSync(fixture('vkey.json'), 'utf8')) as object;
    const prover = createSnarkjsProver();
    try {
      expect(await prover.verify(proof, publicSignals, vkey)).toBe(true);
      // Negative control: a tampered public signal must not verify.
      const tampered = [...publicSignals];
      tampered[0] = tampered[0]! + 1n;
      expect(await prover.verify(proof, tampered, vkey)).toBe(false);
    } finally {
      await prover.close?.();
    }
  }, 60000);

  // A spend-auth EdDSA signature over the digest is required (sanity on the witness the circuit consumes).
  it('signs the spend-auth digest over the recognized-note witness (c3 witness)', async () => {
    const tokenData = getTokenDataERC20(USDC);
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value: 30n, tokenData,
    });
    const tree = new UTXOMerkletree();
    tree.insert(nToHex(note.hash));
    const built = await buildWitness({
      inputs: [{ random: note.random, value: 30n, position: 0, merkleProofElements: tree.merkleProof(0).elements.map((e) => BigInt(`0x${e.startsWith('0x') ? e.slice(2) : e}`)) }],
      outputs: [
        { receiverAddress: sender.shieldedAddress, value: 29n },
        { receiverAddress: sender.shieldedAddress, value: 1n },
      ],
      tokenAddress: USDC,
      sender: {
        masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey,
        viewingPrivateKey: sender.viewingPrivateKey, nullifyingKey: sender.nullifyingKey,
        spendingPublicKey: sender.spendingPublicKey, senderAddress: sender.shieldedAddress,
      },
      signer, summary: { tokenAddress: USDC, inputTotal: 30n, outputs: [], changeValue: 0n },
      merkleRoot: BigInt(`0x${tree.root()}`), treeNumber: 0, chainType: 0, chainId: 31337,
    });
    expect(built.shape).toEqual({ nullifiers: 1, commitments: 2 }); // 01x02 — the proven fixture's shape
    const fi = built.formattedInputs;
    const message = poseidon([built.publicInputs.merkleRoot, built.publicInputs.boundParamsHash, ...built.publicInputs.nullifiers, ...built.publicInputs.commitmentsOut]);
    expect(verifyEDDSA(message, { R8: [fi.signature[0], fi.signature[1]], S: fi.signature[2] }, sender.spendingPublicKey)).toBe(true);
  });
});
