/*
  Local derivations for the gate tools whose version must match the
  Dockerfile gate image (.exophial/gate/Dockerfile) exactly, for parity
  (D10, docs/plans/nix-images.md). A version change is a local
  `.override`/`overridePythonAttrs` on the one package that needs it,
  never a nixpkgs-wide overlay (D9) -- so no unrelated package rebuilds.
*/
{ pkgs, gateSrc }:
let
  # Node 24.18.0 + npm 11.16.0 (the Dockerfile's own pinned tarball),
  # byte-identical construction to exophial's own nix/gate.nix node24 --
  # the exact upstream tarball, never nixpkgs' own nodejs_24.
  node24Base = pkgs.stdenv.mkDerivation {
    pname = "node";
    version = "24.18.0";
    src = pkgs.fetchurl {
      url = "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz";
      hash = "sha256-VapxU/nYjyjXZfza1a5pRbXA+Yo2iBcDgX5MRQ+nZ0I=";
    };
    nativeBuildInputs = [ pkgs.autoPatchelfHook ];
    buildInputs = [ pkgs.stdenv.cc.cc.lib ];
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r --no-preserve=ownership . $out/
      chmod -R u+w $out
      find $out/bin -maxdepth 1 -type f -exec chmod +x {} +
      patchShebangs $out/bin $out/lib
      # npm/npx keep a `#!/usr/bin/env node` shebang that patchShebangs
      # cannot resolve mid-build (node is not yet on PATH while building
      # itself) -- the same fix exophial's own node24 needs for the
      # identical reason.
      rm -f $out/bin/npm $out/bin/npx
      cat > $out/bin/npm <<EOF
      #!${pkgs.runtimeShell}
      exec $out/bin/node $out/lib/node_modules/npm/bin/npm-cli.js "\$@"
      EOF
      cat > $out/bin/npx <<EOF
      #!${pkgs.runtimeShell}
      exec $out/bin/node $out/lib/node_modules/npm/bin/npx-cli.js "\$@"
      EOF
      chmod +x $out/bin/npm $out/bin/npx
      printf 'prefix=/usr/local\n' > $out/lib/node_modules/npm/npmrc
      runHook postInstall
    '';
  };
  node24 = node24Base // { passthru = (node24Base.passthru or { }) // { python = pkgs.python3; }; };

  # pre-commit 4.5.1, the Dockerfile's own `uv tool install pre-commit==4.5.1`
  # version. A plain version+src override of nixpkgs' own packaging
  # (pkgs/by-name/pr/pre-commit/package.nix, 4.7.0 upstream) -- its
  # dependency/build-system declarations already fit this version range.
  # doCheck = false: the override's own test suite (disabledTests, dotnet/go/
  # cargo fixtures) targets 4.7.0's own test tree, not what this pin needs
  # verified -- the Dockerfile's own `uv tool install` never ran pre-commit's
  # test suite either.
  preCommit = pkgs.pre-commit.overridePythonAttrs (_old: {
    version = "4.5.1";
    src = pkgs.fetchFromGitHub {
      owner = "pre-commit";
      repo = "pre-commit";
      tag = "v4.5.1";
      hash = "sha256-3E/haU7TzTr+Qj3KadC7BYwuECZPa2Q+NvG5e4SSKSA=";
    };
    doCheck = false;
    doInstallCheck = false;
    nativeCheckInputs = [ ];
    nativeInstallCheckInputs = [ ];
    disabledTests = [ ];
    # doCheck/doInstallCheck=false did not suppress pre-commit's own
    # test collection (measured across two retries: first "git: command
    # not found", then, with git added, `ModuleNotFoundError: No module
    # named 're_assert'` from its own test-only dependencies this
    # override does not carry). Overriding the phase BODY to a no-op is
    # the one approach immune to whichever hook ignores the flags.
    checkPhase = "true";
    installCheckPhase = "true";
    nativeBuildInputs = (_old.nativeBuildInputs or [ ]) ++ [ pkgs.gitMinimal ];
  });

  # pre-commit-hooks 4.6.0: the 7 console scripts the converted local hooks
  # in .pre-commit-config.yaml call directly (trailing-whitespace-fixer,
  # end-of-file-fixer, check-yaml, check-added-large-files,
  # check-merge-conflict, check-case-conflict, mixed-line-ending). Same
  # override pattern over nixpkgs' own packaging (6.0.0 upstream).
  preCommitHooks = pkgs.python3Packages.pre-commit-hooks.overridePythonAttrs (_old: {
    version = "4.6.0";
    src = pkgs.fetchFromGitHub {
      owner = "pre-commit";
      repo = "pre-commit-hooks";
      tag = "v4.6.0";
      hash = "sha256-p/pPpuuNjVxHSPyi4RL2DJlj9weSq8QinugQ4zmv9Ck=";
    };
    doCheck = false;
    nativeCheckInputs = [ ];
    preCheck = "";
  });

  # The npm cache `npm ci --offline` (gate.command, .exophial/config.yaml)
  # needs -- fetchNpmDeps's `prefetch-npm-deps` populates a real,
  # correctly-keyed npm cache straight from package-lock.json's own
  # resolved URLs, no modified lockfile involved. D5 says importNpmLock for
  # a package-lock.json; measured against THIS gate's actual requirement
  # (2026-11-21, this migration) importNpmLock does not fit it:
  # `importNpmLock.buildNodeModules` patches package-lock.json's `resolved`
  # fields to local store paths and runs `npm install` against that patched
  # copy, so it never populates a cache usable by `npm ci --offline`
  # running the REAL, unmodified committed package-lock.json. Measured
  # directly: `npm cache add <tarball>` of a locally-fetched dependency,
  # then `npm ci --offline`, failed with ENOTCACHED on a transitive
  # dependency npm's URL-keyed cache lookup never saw. `fetchNpmDeps` (this
  # derivation) was then measured to satisfy `npm ci --offline` against the
  # unmodified lockfile end-to-end, including the project's own `prepare`/
  # `build` lifecycle scripts.
  npmDeps = pkgs.fetchNpmDeps {
    name = "armada-sdk-npm-deps";
    # Lockfiles only: the hash below was measured against exactly these
    # two files (fetchNpmDeps's own outputHashMode = "recursive" hashes
    # $out, not $src, so this is equivalent to passing the whole tree,
    # and far cheaper to re-evaluate on an unrelated source change).
    src = pkgs.runCommand "armada-sdk-npm-lockfiles" { } ''
      mkdir -p $out
      cp ${gateSrc}/package.json $out/
      cp ${gateSrc}/package-lock.json $out/
    '';
    hash = "sha256-/Xlbp2tCRXS/sPsN31TWgoTztQeLDMsCWERwFHfqcWs=";
  };
in
{
  inherit node24 preCommit preCommitHooks npmDeps;
}
