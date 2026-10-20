# Testing: base conventions (all surfaces)

Language-agnostic conventions that every per-surface doc
([`testing-python.md`](testing-python.md),
[`testing-typescript.md`](testing-typescript.md)) builds on. See
[`testing.md`](testing.md) for the type taxonomy this assumes.

## Fixtures over mocks

Prefer a real, shared fixture (a real temp git repo, a real local database, a
real subprocess) to a mock, at every level above a pure-unit test. A fixture
is slower to set up once and then reusable everywhere; a mock is fast but
proves nothing about the real integration.

## One assertion, one reason to fail

Each test should have a clear, singular reason to fail. A test with five
unrelated assertions makes debugging a regression slower, not faster — you
learn "something broke" instead of what.

## Naming carries intent

Name a test after the behavior it proves (`test_stale_worktree_is_reclaimed`),
not after the function it calls (`test_cleanup`). The name should make sense
to someone who has never read the implementation.

## Determinism

A test that passes 9 times out of 10 is not a test with a coverage gap — it
is a bug, either in the code or in the test's assumption about timing/ordering.
Fix the root cause; do not retry the test into passing.

## Setup/teardown discipline

A test must leave the environment as clean as it found it, whether it passes
or fails. Prefer fixtures with automatic teardown over manual cleanup blocks
a raised exception can skip.

## The oracle must be independent of the implementation

A test's oracle is the expected value plus the comparison that decides pass/fail.
An oracle is meaningful only if its expected value comes from a source of truth
the implementation under test cannot influence: arithmetic, a specification, a
real observation, an external system's acceptance. The oracle for `add(2, 3)` is
`5` because of arithmetic — it lives in the test, and that is fine. What is not
fine is an expected value produced by **running the implementation**: such a
test cannot fail for any reason that matters; it proves the code is
deterministic, not that it is right. The following are therefore **not tests**,
and a change that ships only these has no acceptance evidence, however green
they are and whatever their mutation score:

- a **golden value** produced by running the implementation and pinning whatever
  came out;
- a **mock sink** offered as proof that something was sent, submitted, or
  accepted — it records that the code did what the code does;
- a **parity test** in which the code is compared to itself through another path;
- a **synthetic fixture** (a byte builder, a hand-made packet, a fabricated
  record) as the _only_ test of a decoder, parser, or model of an external
  format or system — the fixture and the parser encode the same author's belief.

Mutation-adequacy does not rescue these — it rewards more of them. That is the
mechanism by which a large, fully green, non-functional codebase is produced.

For a component that **models an external system** — a decoder of a wire format,
a transaction or protocol builder, a client of an external program, a simulator
of a real process — no specification other than that system defines "right", so
the only independent source of truth is the system itself. There the **first**
test is a **known-answer test against reality**, and nothing is built on the
component until it passes:

- a decoder is fed a **real captured input** (committed bytes off the wire, with
  provenance) and must reproduce what the external system **actually recorded**;
- a builder's output is **accepted by the real program** (a local validator, a
  test network, the live peer), not merely delivered to a recorder — network
  egress may not be mocked when the peer's acceptance is the oracle;
- a model or simulator reproduces a **real observed outcome** from real inputs.

A synthetic fixture is acceptable only to pin an edge case _after_ the real-data
test exists, and its provenance note must name the real reference it emulates.
"Future expansion should pin a real reference" is not a plan; it is the missing
test, and the work is not done.
