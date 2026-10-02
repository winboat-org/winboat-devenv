# Pure validation: no nixpkgs, network, mutable checkout or host dependency.
let
  inventory = import ./repositories.nix;
  pins = import ./pins.nix;
  names = builtins.attrNames inventory.repositories;
  repositories = builtins.attrValues inventory.repositories;
  noTraversal = path: !(builtins.elem ".." (builtins.filter builtins.isString (builtins.split "/" path)));
  validPath = path: builtins.isString path && builtins.match "repos/[A-Za-z0-9_./-]+" path != null && noTraversal path;
  validRev = rev: rev == null || (builtins.isString rev && builtins.match "[0-9a-f]{40}" rev != null);
  validRef = ref: ref == null || (builtins.isString ref && builtins.match "refs/heads/.+" ref != null);
  paths = map (repository: repository.path) repositories;
  unique = values: builtins.attrNames (builtins.listToAttrs (map (name: { inherit name; value = true; }) values));
  validRepo = repository:
    validPath repository.path
    && builtins.all (dependency: builtins.elem dependency names) repository.dependencies
    && builtins.elem repository.submodules.mode [ "none" "selected" ]
    && (repository.submodules.mode != "none" || repository.submodules.paths == [ ])
    && builtins.all (path: builtins.isString path && builtins.match "[A-Za-z0-9_./-]+" path != null && noTraversal path) repository.submodules.paths
    && (if repository.parent == null then repository.submodulePath == null
      else builtins.elem repository.parent names
        && repository.path == inventory.repositories.${repository.parent}.path + "/" + repository.submodulePath
        && builtins.elem repository.submodulePath inventory.repositories.${repository.parent}.submodules.paths);
  unresolved = builtins.filter (name: pins.repositories.${name}.rev == null) names;
in
assert inventory.schemaVersion == 1 && pins.schemaVersion == 1;
assert names == builtins.attrNames pins.repositories;
assert builtins.length names == 12;
assert builtins.length (unique paths) == builtins.length paths;
assert builtins.all validRepo repositories;
assert builtins.all (pin: validRev pin.rev && validRef pin.ref) (builtins.attrValues pins.repositories);
assert builtins.all (members: builtins.all (name: builtins.elem name names) members
  && builtins.length (unique members) == builtins.length members) (builtins.attrValues inventory.subsets);
assert inventory.repositories.qemu-helios.submodules.paths == [ ];
{
  valid = true;
  repositoryCount = builtins.length names;
  pinnedCount = builtins.length names - builtins.length unresolved;
  unresolvedRepositories = unresolved;
  readyForAllRepositories = unresolved == [ ];
}
