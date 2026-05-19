{
  description = "Twilight development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          python = pkgs.python311;
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              python
              uv
              nodejs_22
              pnpm
              pkg-config
              openssl
              rustc
              cargo
            ];

            shellHook = ''
              echo "Twilight dev shell: Python $(python --version), Node $(node --version), pnpm $(pnpm --version)"
              echo "Backend deps: uv venv .venv && . .venv/bin/activate && uv pip install -r requirements-dev.txt"
              echo "Frontend deps: cd webui && pnpm install --frozen-lockfile"
            '';
          };
        });
    };
}
