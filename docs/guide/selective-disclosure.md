# Selective disclosure

The SDK builds and checks **selective-disclosure packages**. A user proves to a
third party a chain of custody for chosen shielded value. The user proves the
path from a shielding address, through notes, spends and armada-nitro hub
channels, to a payout note or a withdrawal address. The user reveals nothing
else about the wallet.

The protocol is voluntary and off-chain. It changes no pool contract, no pool
circuit and no armada-nitro contract. A client app uses this SDK surface and
holds no disclosure logic of its own.

- Design: armada-laconic `engineering/16-selective-disclosure.md` (ADR-0020).
- Circuit: `ship-armada/armada-circuits#3` (`NullifierDisclosure.circom`).
- Import: `@armada/sdk/disclosure` (also re-exported from the package root).

## The hops

A disclosure is an ordered list of **hops**. Each hop links two public facts.
The checker verifies each hop on its own.

| Hop | Link | Evidence the checker uses |
|---|---|---|
| `H1` | address → note | The `Shield` event shows `npk`. The opening gives `random`; the checker confirms `npk == Poseidon(M, random)` and the commitment at the leaf. The EOA signs the statement. |
| `H2` | note → spend | A disclosure proof links a published nullifier to the note's leaf, for `M`. The nullifier is in the `Nullified` event. |
| `H3` | spend → output note | The opening gives the output note. The checker recomputes the commitment and compares it with the `Transact` event. |
| `H4` | spend → channel | The deposit `adaptParams` equals `depositBinding(channelId, expectedHeld)`. The adjudicator emits `Deposited(channelId, asset, held)`. |
| `H5` | channel → payout note | The finalized outcome has a `SHIELD` allocation to the payout `npk`. The pool `Shield` event shows the note. |
| `H6` | note → address | `H2` for the spent note, plus the `Unshield` event to the recipient EOA. The recipient EOA signs the statement. |

`H2` is the only hop that uses the disclosure circuit. All other hops use data
that is already public or that the wallet already holds.

## Design decisions

### D1 · The EIP-712 domain scopes a statement to one pool

The domain pins the statement to one pool deployment:

```
name              = "ArmadaSelectiveDisclosure"
version           = "1"
chainId           = the pool's EVM chain id
verifyingContract = the Railgun pool contract address
```

A signature made for one pool does not verify against another. The audit
recipient is not part of the domain; the statement names it (see D2).

### D2 · The statement names the claim and binds the hop list

The signed EIP-712 `Statement` carries:

```
masterPublicKey : uint256     the wallet (M)
verifier        : string      who the disclosure is for
context         : string      the purpose
issuedAt        : uint64      Unix seconds
endpoints       : Endpoint[]  the public addresses, each with a role
hopsHash        : bytes32     keccak256 of the canonical hop list
```

The full hop list lives in the package, not in the typed data. `hopsHash`
binds it. This keeps the EIP-712 schema small and fixed, and still ties each
signature to the exact hops it was made for. The checker recomputes `hopsHash`
from the package hops and compares it with the signed value.

`hopsHash` is `keccak256` over a canonical JSON encoding of the hops. The
encoding sorts object keys at every depth, so any verifier reproduces the same
bytes.

### D3 · `statementHash` is the EIP-712 digest reduced into the field

The disclosure circuit takes a `statementHash` public input, a BN254 field
element. The circuit's message is `Poseidon(statementHash, M, nullifier,
treeNumber, leafIndex)`, and the spending key signs it.

The SDK derives one value from one statement:

```
digest         = TypedDataEncoder.hash(domain, types, statement)   // 32 bytes
statementHash  = digest mod r                                       // r = BN254 scalar field
```

Both sides cover the same statement. The EOA signs the full 256-bit `digest`.
The spending key signs the reduced `statementHash` inside the proof. The
reduction keeps about 128-bit binding, because a second statement with a
congruent digest needs a keccak collision modulo `r`.

### D4 · The package is JSON

Every field of a package is a string or a number, so the wire format is JSON.
`serializeDisclosurePackage` pretty-prints a package for an audit record.
`parseDisclosurePackage` validates the version and the top-level sections; the
checker re-derives and compares every field, so deep validation is the
checker's job, not the parser's. A package carries:

```
version             the schema version (1)
domain              chainId + verifyingContract
statement           the EIP-712 Statement value
endpointSignatures  one EIP-712 signature per endpoint EOA
openings            the note openings (random, token, value, leaf)
proofs              the Groth16 disclosure proofs + their public signals
hops                the ordered hop list
```

Field elements are 0x-hex. Public signals are decimal strings, to match the
circuit's output. A Groth16 proof keeps the snarkjs coordinate form.

### D5 · Each hop type references openings, proofs and endpoints by name

A hop names the opening, the proof or the endpoint it uses. A note opening
carries its leaf `(tree, position)`. `H1`, `H3` and `H5` confirm an opening
against its `Shield` or `Transact` event. `H2` and `H6` confirm that a proof's
`(treeNumber, leafIndex)` is the spent note's leaf, and that the nullifier is in
the `Nullified` event. This separates the proof of ownership (the opening) from
the proof of the spend (the disclosure proof).

### D6 · The checker returns the first failing check by name

`checkDisclosurePackage` returns a typed result. On failure it names one check
(for example `opening-npk`, `deposit-binding`, `nullifier-event`) and the hop
index. On success it returns what the verifier learns: `masterPublicKey`, the
endpoints, the transaction ids and the channel ids.

## Build a package

```ts
import {
  buildDisclosurePackage,
  loadDisclosureArtifacts,
} from '@armada/sdk/disclosure';
import { createSnarkjsProver } from '@armada/sdk/prover';

const prover = createSnarkjsProver();
const artifacts = await loadDisclosureArtifacts(disclosureBuildDir);

const pkg = await buildDisclosurePackage({
  keyset,                       // spending key, nullifying key, M
  domain: { chainId, verifyingContract: poolAddress },
  verifier: 'Acme Exchange compliance',
  context: 'source-of-funds for withdrawal',
  endpoints: [{ role: 'shielder', account: eoaA }],
  openings: [{ label: 'N1', random, token, value, tree, position }],
  spends: [{ id: 'n1', opening: 'N1' }],
  hops: [/* H1, H2, ... */],
  prover,
  artifacts,
  signEndpoint: async ({ domain, types, message }) =>
    wallet.signTypedData(domain, types, message),
});
```

The proof system and the ceremony for production are open (ADR-0020). The dev
artifacts prove and verify the circuit; they are for testing only.

## Check a package

```ts
import {
  checkDisclosurePackage,
  InMemoryDisclosureChainSource,
} from '@armada/sdk/disclosure';

const source = new InMemoryDisclosureChainSource({
  shields, transacts, nullifiers, unshields,   // decoded pool events
  deposits, finalizedOutcomes,                 // armada-nitro hub events
});

const result = await checkDisclosurePackage({
  package: pkg,
  source,
  prover,
  vkey: artifacts.vkey,
});

if (!result.ok) {
  // result.failure.check names the first failing check.
}
```

Pool events reuse the SDK's decoded shapes (`DecodedShieldCommitment`,
`DecodedNullifier`, …). The armada-nitro hub events (`Deposited` and the
finalized `SHIELD` outcome) are typed in the disclosure module, because the SDK
holds no armada-nitro ABI.

## Limits

- A received note ends the chain. The sender must make their own disclosure.
- The package can be forwarded. The statement names the verifier and the
  context, so the package states for whom and for what the user made it.
- Disclosed data is permanent. After disclosure, `M` links the package to the
  0zk address, and each `random` opens its note for any holder of the package.
- Disclosure is voluntary. It must never become a condition to deposit into,
  transfer in, or withdraw from the pool.
