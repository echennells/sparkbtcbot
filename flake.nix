{
  description = "sparkbtcbot-skill — Spark Bitcoin L2 wallet skill for AI agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      # x86_64-darwin is deliberately absent. nixpkgs unstable now THROWS on
      # it (Intel Mac support was dropped in 26.11), so declaring it does not
      # add coverage — it makes `nix flake check --all-systems` fail outright
      # and gives an Intel-Mac user an evaluation error instead of a clean
      # "unsupported system".
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # ONE SOURCE OF TRUTH. Name and version are read from package.json rather
      # than restated here. A flake that hardcodes them is a second declaration
      # of the same fact, and the two drift the first time someone bumps a
      # version without thinking about Nix — which is exactly the class of bug
      # this package's own CI hardening exists to catch elsewhere.
      pkgJson = builtins.fromJSON (builtins.readFile ./package.json);
    in
    {
      packages = forAllSystems (pkgs: rec {
        default = sparkbtcbot-skill;

        sparkbtcbot-skill = pkgs.buildNpmPackage {
          pname = pkgJson.name;
          inherit (pkgJson) version;

          src = ./.;

          # Derived from package-lock.json, which stays the single source of
          # truth for the dependency closure. Regenerate after any lockfile
          # change with:
          #   nix build .# 2>&1 | grep -A2 'got:'
          npmDepsHash = "sha256-9if2GkWzHUzbowbRupE+1JPL2fcG3QPHFeA6w8zSSos=";

          # There is no build script in package.json — the package ships the
          # sources it publishes. Nothing to compile, so skip the default
          # `npm run build` that buildNpmPackage would otherwise attempt.
          dontNpmBuild = true;

          nodejs = pkgs.nodejs_22;

          meta = with pkgs.lib; {
            description = pkgJson.description or "Spark Bitcoin L2 wallet skill for AI agents";
            homepage = "https://github.com/echennells/sparkbtcbot";
            license = licenses.mit;
            mainProgram = "sparkbtcbot";
            platforms = systems;
          };
        };
      });

      # A shell for working ON this repo, deliberately minimal: node and npm
      # only. It does NOT pin dependencies — package-lock.json already does
      # that, and a shell that installed its own set would be a third answer to
      # a question package.json and the devcontainer already answer.
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
          shellHook = ''
            echo "sparkbtcbot-skill dev shell — node $(node --version), npm $(npm --version)"
            echo "deps come from package-lock.json: run 'npm ci'"
          '';
        };
      });
    };
}
