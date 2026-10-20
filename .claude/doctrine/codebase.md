# Codebase doctrine

Load-bearing project rules every agent operating in this repo must respect.
Both the coordinator and every worker inherit this. This is a generic seed
installed by `exophial init`; once installed it is free to drift from
exophial's own copy to match this repo's actual conventions.

## Behavioral norms (inherited from principal)

Full doctrine: [`principal.md`](principal.md). Load-bearing summary:

- Evidence-based reasoning: run before you read, when diagnosing.
- Fail fast, no fallbacks: no retry loops, no silent catch-all.
- Done = integrated + end-to-end verified, against the real surface.
- Own your consequences: grep for orphans before declaring a change done.

## Literate code principle

An agent should be able to derive all the state needed to safely modify a file
from three sources:

1. **Directory structure** — the layout tells you what exists and how it's
   organized.
2. **Imports within the file** — these declare the file's dependencies
   explicitly.
3. **Comments within the file** — these link to prose design docs that explain
   the _why_, not the _what_ (well-named identifiers already say the what).

If a file is changed, any documentation that references it is potentially
stale and must be checked — documentation and code are a bidirectional graph.

## Functional core, imperative shell

"No I/O inside the function" is necessary and nowhere near sufficient. A
functional core is a **typed domain model in which illegal states are
unrepresentable**, so the pure functions over it cannot be wrong in the ways the
types forbid. A serialization shape with functions bolted on is not a functional
core; it is an imperative program whose file reads were moved elsewhere. Design
the types first, then the functions. In the core:

- **Parse, don't validate.** Data crosses the boundary once, into a type that
  carries every invariant a consumer needs. A required field is never
  optional/nullable in the core; its absence is refused at the boundary.
- **Units are types.** Every quantity (lamports, base-units, micro-dollars,
  basis points, nanoseconds, slots) is its own newtype, never a bare number.
- **No tagged-untyped payloads.** A field whose meaning depends on a sibling
  discriminator is what the core exists to eliminate; use a sum type with
  per-variant typed fields.
- **Identifiers keep their wire type** (`[u8; 32]`, not a base58 string) in the
  core; human encodings are a boundary concern.
- **Transitions are pure values:** `(State, Event) -> (State', Option<Action>)`,
  never in-place mutation — a transition that is not a value cannot be
  replayed or compared.
- **One contract per input.** Every source of the same data (wire, file,
  replay) normalizes into one typed stream at the boundary; a second input
  format for the same data is a defect.

The shell is thin — adapters between the world and the core's types, nothing
else; logic in the shell is untested logic. Small functions: if one is long, it
does too much. No linter checks the type discipline; reviewers do.

## DRY / KISS

Minimize duplication and complexity. Don't add abstractions beyond what the
task requires — three similar lines beat a premature abstraction. Don't design
for hypothetical future requirements.

## Own your consequences

If you move code, verify nothing still imports the old location. If you delete
a caller, delete the callee. The person making a change is responsible for
everything that change breaks — not just its immediate correctness, but its
ongoing cost.

## Testing

Testing conventions (unit vs. integration vs. e2e, and per-surface detail) are
owned by [`testing.md`](testing.md) — read it before writing or reviewing any
test in this repo. Do not restate the taxonomy here; that duplication is
exactly how conflicting definitions drift apart.

## Roles

- [`coordinator.md`](coordinator.md) — the role dispatching and integrating
  work across workers.
- [`worker.md`](worker.md) — the role executing one task in an isolated
  worktree.
