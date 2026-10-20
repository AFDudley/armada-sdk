# Wallet shielded ragequit (C6)

This document states the rule that chunk C6 of family F3 builds. The build plan is
`armada-poc/docs/tasks/C6-wallet-shielded-ragequit.md`. The on-chain contract is
`armada-poc/contracts/governance/ShieldedRagequit.sol` (chunk G3). The owner-derived
note key rule is `armada-laconic/.scratch/rewrite-evidence/P2-CONTRACT.md` items 3 and 6.

## The rule

A wallet that holds ARM can exit the treasury on-device. The wallet calls
`ShieldedRagequit.ragequit`, recognizes the contract-owned payout note, and spends that
note. No step calls a server-side proving service. The proof is built on the device.

## What `ragequit` pays

`ShieldedRagequit.ragequit(uint256 armAmount, bytes32 npk, address[] tokens)` burns the
caller's ARM. For each token it pays a bounded pro-rata share. The bound is
`armAmount * safe.balanceOf(token) / armToken.totalSupply()`. The contract reads the Safe
balance and the ARM total supply in the same transaction. It pays the share as a
contract-owned note at the caller's `npk`, through the pool's `transactOwned` path. The
input note uses the owner-derived npk (the Safe key, P2-CONTRACT item 6). The output note
is the caller's note at `npk`. The contract emits `RagequitExecuted`.

## What the wallet SDK must add

1. `planRagequit`, beside `planTransfer` and `planSpend` in `src/tx/plan.ts`. It takes the
   holder's ARM balance and the assets the Safe holds, read from chain the same way
   `planSpend`'s callers read spend candidates. It returns the calldata for
   `ragequit` and the expected `CommitmentPreimage` for each asset. It computes the
   expected payout with the same bound the contract enforces, so the wallet can show the
   user the payout before they sign. The input object and the return type follow the
   `PlanTransferParams` and `PlanSelection` shapes.

2. Note recognition without a ciphertext. The payout note has no ciphertext: the caller
   supplies the preimage in the clear (P2-CONTRACT item 3). After the `ragequit` call the
   wallet reads `preimageOf` for the commitment that `planRagequit` predicted, confirms the
   match, and inserts the note into the local note store the same way `src/sync/` ingests a
   recognized note today. The wallet never attempts to decrypt a ciphertext for this note.

3. The payout note spends like any other stored note. Once the note is in the store,
   `planSpend`, `prove` and `buildTransactCalldata` succeed against it with no special
   case beyond the insertion step. The on-chain `transact` call verifies.

## How to see it

A wallet shields a note, calls `ragequit` against a local or fixturenet `ShieldedRagequit`
deployment, and spends the resulting note. The final `transact` call's proof verifies
on-chain. The test file is `src/tx/ragequit.test.ts`. The test runner is `vitest run`
(`package.json` `scripts.test`).
