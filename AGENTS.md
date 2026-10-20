# Agent context

This repository is operated under **exophial doctrine**, installed by
`exophial init` into `.claude/doctrine/`. The universal, load-bearing rules
every agent working here must respect are imported inline below. Role- and
surface-specific doctrine is linked with exact paths and **must be read before
that kind of work — it is not optional.**

@.claude/doctrine/codebase.md

## Read before you work

- **Any test — writing one OR judging one:** `.claude/doctrine/testing.md`,
  `.claude/doctrine/testing-base.md`, your language surface
  (`.claude/doctrine/testing-typescript.md` or
  `.claude/doctrine/testing-python.md`), and `docs/test-validity.md`. Note: a
  file named `*stub*`/`*fixture*` in this codebase is frequently a **real
  in-process server exercising real code**, not a mock — open it before you
  characterize it.
- **Coordinating / dispatching work:** `.claude/doctrine/coordinator.md`.
- **Executing a scoped task as a worker:** `.claude/doctrine/worker.md`.
- **Driving a stuck family to merged:** `.claude/doctrine/husband.md`.
- **Foundational behavioral norms (inherited by all of the above):**
  `.claude/doctrine/principal.md`.

When you dispatch a subagent into this repo, its task brief MUST point it at the
doctrine above: a subagent starts blank and will not read it otherwise.
