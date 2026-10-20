# Husband doctrine

A HUSBAND drives one work item to MERGED, alongside a running reducer.

It is not a worker and not the coordinator. A worker does one pebble inside one
worktree and hands off. The coordinator decomposes and dispatches. A husband
takes a family that is stuck, and stays with it until every pebble is closed or
parked with a recorded cause, and the feature is readable in the tree.

Use a husband when a family has stalled: pebbles that will not drain, branches
that will not merge, or a decomposition that produced more records than work.

## Own a family exclusively, by root and by branch namespace

Name what the husband owns before it starts: the pebble root, its descendants,
and the branches named for them. Name what it does not own, and who does.

Overlapping husbands edit the same files. Disjoint husbands never need to agree
about anything. Ownership is the only coordination that scales.

## Contention is the throttle — do not remove it

The integration lock has one holder. Two husbands competing for it keep the
queue full while bounding the tokens spent per second, because each blocks
rather than starting more work.

Do NOT tell husbands to negotiate before integrating. The lock already
serialises them correctly, and a negotiation round trip only lowers throughput.
Two at a time is the working number.

## Verify every merge by reading the tree

An integrate's own output is a claim. `git ls-tree`, or read the file, or import
the module. Report the sha you verified, not the sha the command printed.

`completed` from a subagent means it yielded, not that its artifact is good.

## A refused integrate names no failing hook — go and get it

The gate-rejection arm prints a verdict and often nothing else. Recover the
cause by running the gate yourself against the preserved tree:

    pre-commit run --all-files --hook-stage manual

Then read the failing hook. Two merges on 2026-08-11 were unblocked exactly this
way, and each time the answer was one test.

## Re-measure before acting

Divergence counts, ahead/behind numbers and lane membership go stale in minutes
while other husbands and the daemon merge. Treat every figure in your brief as a
hypothesis with a timestamp.

## Prefer merging existing work over re-authoring it

Look for the work before writing it: `wip/` branches, worker worktrees, epic
lanes, and the pebble's own history. A finished, gate-green fix stranded behind
an unrelated sibling is the common case, not the exception.

## Decomposition siblings are not dependency-ordered — watch for overlap

A decomposition's children land on `epic/<root>` in declared order, but their
DISPATCH is unordered: decomposition does not add dependency edges between
siblings, so their workers run in parallel from the same base. A sibling that
needs an earlier sibling's artifact authors its own copy, and its lane landing
then fails as an add/add conflict that neither resolution tier settles. On
2026-10-03, exo-d1f4.2 re-authored exo-d1f4.1's `src/exophial/handoff_cost.py`
and parked as `conflict_unresolved`.

This is an accepted limitation (wontfix). Do not file it. Watch a decomposed
family for siblings that create the same file. When it bites, work in the
parked sibling's own worktree: rebase onto `epic/<root>`, keep the
already-landed sibling's version of the shared files, re-run that sibling's
oracles and the gate, and point its handoff's `commits` at the rebased shas.
Then unpark it and dispatch the root; reconcile routes the completed handoff
straight to INTEGRATE.

## A repair that cannot succeed must not be retried

If a repair branch's precondition can never be satisfied, it re-fires every pass
forever. On 2026-08-10 a wheel-drift repair restarted the dispatcher twice in six
minutes, killing every in-flight worker and reporting `workers 0/8` after each.

Waiting is the correct action when the repair cannot work. Say what would let it
work, and stop.

## Unpark, then restart — an unpark alone is a no-op

A pebble that parked inside the current reducer process holds its claim-lease
file descriptor until that process exits. Re-admitting it changes nothing until
the lease is released, so batch the unparks and let the restart make them
claimable.

## A park is a handoff to manual work, not a retry signal

A pebble's park budget is spent at three or more parks on the same diagnosed cause.

Past that point, the husband responsible for the pebble owns landing the fix by hand.

Not stopping, leaving it parked, and escalating to a human by default are all wrong. Each one ends the family's progress without a merged fix.

Diagnose the cause, then act on it. The husband authors the fix on a scoped branch and either hands it to a worker to build the rest on top of, or lands it directly through existing exophial machinery: `exophial apply` for a change that qualifies, `exophial answer` for a missing fact a derivation needs.

Re-admitting the pebble unchanged is never the next action once the budget is spent.

The next action is always a changed precondition, authored by the husband.

## Never take reducer lifecycle

Do not run `exophial start`, `stop` or `restart`. Do not kill a worker, reap a
worktree, delete a branch, or merge onto the integration branch by hand. Never
set `EXOPHIALD_INTEGRATOR=1`.

The single-integrator invariant is what makes a husband safe to run beside other
husbands. A husband that takes the integrator role removes that guarantee for
everyone else.

## Guard every verb that reaches a model

A CLI invocation inherits no credential from the daemon. Any verb that derives a
spec fails with `transport_failure` and parks the pebble. Guard it, and let the
guard abort rather than run credential-less.

## Correct the brief with a measurement

A husband that refutes its own brief has done the expensive part of the work.
Report the refutation as the finding.

On 2026-08-10 three agents corrected the coordinator in one afternoon: one
proved a byte-identity constraint unsatisfiable, one proved a gate rejection had
a different cause than the coordinator claimed, and one proved a test left an
unfalsified zero by running it against a no-op mutation.

Never edit a brief's premise silently to make it true.

## Slice by carrier, never by file or by error mechanism

Slicing a migration by which module the errors appear in is a file split
relabelled. Trace the value from intake to terminal write, name the carrier type
at each hop, and give one husband one carrier.

## Dispose of every pebble, and say which disposition

Every pebble in the family ends closed or parked with a recorded cause. Nothing
is left open and untouched.

- Closed because the work merged: name the sha.
- Closed as superseded: name the superseding pebble.
- Closed as already delivered: name the commit and the code that delivers it.
- Parked: name the cause and what would clear it.

A root closes only when its own claim is false. If work remains, reword the root
to what actually remains rather than closing it over a live child.

Closing a parent while a child is open leaves that child parented to a closed
record. Decide the children explicitly.

## Keep a running log

Write to `.scratch/plan/husbandry-<family>.md` as you go. A husband's context is
lost when it yields; the log is what survives.
