let
  inventory = import ./repositories.nix;
  pins = import ./pins.nix;
in
inventory // {
  repositories = builtins.mapAttrs (name: repository:
    repository // { pin = pins.repositories.${name}; }
  ) inventory.repositories;
}
