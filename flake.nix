{
  description = "armada-sdk: Nix-built commit-boundary gate image (docs/plans/nix-images.md Milestone 3, T3.x.b)";

  inputs = {
    # Pinned to exophial's own root nixpkgs input (its flake.lock
    # `nixpkgs_2`), per the operator's 2026-11-21 coordination: every
    # Nix-images-migration repo on the same host shares this pin, so a
    # store path is shared instead of rebuilding a second toolchain copy.
    nixpkgs.url = "github:NixOS/nixpkgs/ac62194c3917d5f474c1a844b6fd6da2db95077d";

    # Follows exophial's own nix2container/uv2nix/pyproject-nix/
    # pyproject-build-systems instances (its flake.lock pins all four
    # already): one build of each shared across both repos' gate images,
    # never a second copy built against a different nixpkgs pin.
    nix2container.follows = "exophial/nix2container";
    uv2nix.follows = "exophial/uv2nix";
    pyproject-nix.follows = "exophial/pyproject-nix";
    pyproject-build-systems.follows = "exophial/pyproject-build-systems";

    # The flake AND source tree of the merged coordination repo, pinned
    # to the rev the operator measured building standalone (2026-11-22,
    # 114 seconds, `bin/exophial version` exits 0). The `github:` scheme
    # gives a 404: the repo is private, so the fetch uses an
    # authenticated ssh URL instead.
    exophial = {
      url = "git+ssh://git@github.com/AFDudley/exophial.git?rev=84b680fc5519e326ab48e0a176ed9ad127417be1";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      nix2container,
      uv2nix,
      pyproject-nix,
      pyproject-build-systems,
      exophial,
      ...
    }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      lib = pkgs.lib;
      n2c = nix2container.packages.${system}.nix2container;
      # lib.cleanSource: VCS cruft only (.git etc). The actual commit-
      # boundary gate run hands this flake an already-filtered,
      # .git-free judged-tree tar (gate_container._extract_context_tar),
      # never this live worktree -- this path only matters for a direct
      # `nix build` against a checkout.
      gateSrc = pkgs.lib.cleanSource ./.;

      pins = import ./nix/pins.nix { inherit pkgs gateSrc; };
      exophialGate = import ./nix/gate.nix {
        inherit
          pkgs
          lib
          n2c
          pins
          gateSrc
          ;
        exophialPkg = exophial.packages.${system}.exophial;
      };
    in
    {
      packages.${system} = {
        exophial-gate = exophialGate;
      };
    };
}
