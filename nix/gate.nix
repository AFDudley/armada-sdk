/*
  The commit-boundary gate image for armada-sdk, built with Nix via
  nix2container (docs/plans/nix-images.md T3.x.b; D1-D11). Layout mirrors
  exophial's own nix/gate.nix: explicit layers, each keyed on its own
  inputs, plus one per-commit layer carrying the judged tree.

    toolsLayer    system tools, Node 24.18.0 + npm 11.16.0, pre-commit
                  4.5.1, pre-commit-hooks 4.6.0 (D6's 7 local "Base
                  hooks"), and the exophial flake input's own `exophial`
                  package (its 4 `exophial-*` console-script local hooks)
    fhsLayer      nix-ld + the CA bundle -- a safety net for any
                  unpatched manylinux wheel in the exophial package's own
                  dependency closure (never load-bearing if nothing
                  needs it)
    npmDepsLayer  the npm cache `npm ci --offline` (gate.command) needs
                  (nix/pins.nix npmDeps), at its own store path
    per commit    the judged tree at /gate, verbatim

  Nothing downloads at container run time (D11): `npm ci --offline`
  resolves every dependency from npmDepsLayer's cache, and pre-commit's 7
  "Base hooks" and the 4 exophial-owned hooks are all `language: system`
  console scripts this image already carries on PATH -- no hook
  environment for pre-commit to build.
*/
{
  pkgs,
  lib,
  n2c,
  pins,
  gateSrc,
  exophialPkg,
}:
let
  toolPaths = [
    (pkgs.dockerTools.fakeNss.override { extraGroupLines = [ "nogroup:x:65534:" ]; })
    pkgs.bashInteractive
    pkgs.coreutils
    pkgs.gnugrep
    pkgs.gnused
    pkgs.gawk
    pkgs.findutils
    pkgs.gnutar
    pkgs.gzip
    pkgs.xz
    pkgs.which
    pkgs.git
    pkgs.util-linux
    pkgs.procps
    pkgs.curl
    pkgs.cacert
    pins.node24
    pins.preCommit
    pins.preCommitHooks
    exophialPkg
  ];

  toolsEnv = pkgs.buildEnv {
    name = "armada-sdk-gate-tools";
    paths = toolPaths;
    ignoreCollisions = true;
  };

  gateEntrypoint = pkgs.writeShellScript "gate-entrypoint.sh" (builtins.readFile ./gate-entrypoint.sh);

  # nix-ld's default library directory: the glibc loader an unpatched
  # manylinux wheel in the exophial package's own dependency closure might
  # ask for -- the same concern exophial's own nix/gate.nix documents for
  # `ruff`/the base CPython. Cheap to cover here too; inert if nothing in
  # the exophial package's closure needs it.
  nixLdLibs = pkgs.runCommand "armada-sdk-gate-nix-ld-libs" { } ''
    mkdir -p $out/lib
    for d in ${pkgs.glibc}/lib ${pkgs.stdenv.cc.cc.lib}/lib ${pkgs.zlib}/lib; do
      for f in "$d"/*; do
        ln -sf "$f" "$out/lib/$(basename "$f")"
      done
    done
    ln -sf ${pkgs.glibc}/lib/ld-linux-x86-64.so.2 $out/lib/ld.so
  '';

  fhsRoot = pkgs.runCommand "armada-sdk-gate-fhs-root" { } ''
    mkdir -p $out
    cd $out
    mkdir -p lib64 run/current-system/sw/share/nix-ld etc/ssl/certs usr/share usr/bin root
    ln -s ${pkgs.nix-ld}/libexec/nix-ld lib64/ld-linux-x86-64.so.2
    ln -s ${nixLdLibs}/lib run/current-system/sw/share/nix-ld/lib
    ln -s ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt etc/ssl/certs/ca-certificates.crt
    ln -s ${pkgs.ncurses}/share/terminfo usr/share/terminfo
    # npm's own install scripts (e.g. node-gyp-build, bufferutil/keccak/
    # secp256k1/utf-8-validate) carry a `#!/usr/bin/env node` shebang.
    # exophial's own nix/gate.nix documents the identical need for its
    # own test stubs.
    ln -s ${pkgs.coreutils}/bin/env usr/bin/env
  '';

  toolsLayer = n2c.buildLayer { copyToRoot = [ toolsEnv ]; };
  fhsLayer = n2c.buildLayer {
    copyToRoot = [ fhsRoot ];
    layers = [ toolsLayer ];
  };
  # `deps`, not `copyToRoot`: the cache must land at its OWN store path
  # (the same path `npm_config_cache` below names), never copied under a
  # synthesized root.
  npmDepsLayer = n2c.buildLayer {
    deps = [ pins.npmDeps ];
    layers = [
      toolsLayer
      fhsLayer
    ];
  };
  # The judged tree, placed AT /gate: `copyToRoot` merges a listed path's
  # own CONTENTS at the image root, so `gateSrc` itself (a plain checkout
  # directory) would land its files at `/`, not `/gate` -- this wrapper
  # is what actually puts them at `/gate` (the same step exophial's own
  # `gateTree` performs, minus the code-generation this repo needs none
  # of).
  gateTree = pkgs.runCommand "armada-sdk-gate-tree" { } ''
    mkdir -p $out/gate
    cp -r ${gateSrc}/. $out/gate/
  '';
in
n2c.buildImage {
  name = "localhost/armada-sdk-gate";
  layers = [
    toolsLayer
    fhsLayer
    npmDepsLayer
  ];
  copyToRoot = [ gateTree ];
  config = {
    WorkingDir = "/gate";
    Entrypoint = [ "${gateEntrypoint}" ];
    Env = [
      "PATH=/bin"
      "HOME=/root"
      "npm_config_cache=${pins.npmDeps}"
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "GIT_SSL_CAINFO=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "NODE_EXTRA_CA_CERTS=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
  };
}
