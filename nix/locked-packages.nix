let
  lock = builtins.fromJSON (builtins.readFile ../devenv.lock);
  source = builtins.fetchTree (
    builtins.removeAttrs lock.nodes.${lock.nodes.${lock.root}.inputs.nixpkgs}.locked [ "lastModified" ]
  );
in
import source { system = builtins.currentSystem; }
