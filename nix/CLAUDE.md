# nix/

Nix build logic for the commit-boundary gate image (`docs/plans/nix-images.md`
Milestone 3, D1-D11). The root `flake.nix` wires these modules together.

- `pins.nix` — local derivations for tool versions that must match
  `.exophial/gate/Dockerfile` exactly, for parity (D10): Node 24.18.0,
  pre-commit 4.5.1, pre-commit-hooks 4.6.0, the npm cache.
- `gate.nix` — the gate image itself, built with nix2container. It takes the
  merged repo's own `packages.x86_64-linux.exophial` output as a flake input
  (never a local reproduction of that build).
- `gate-entrypoint.sh` — the image's commit-boundary entrypoint script.

Read `docs/plans/nix-images.md` before changing a pin or the image layout.
