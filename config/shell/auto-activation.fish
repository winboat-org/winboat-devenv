# Nix may already install this hook; load it once if absent.
# Trust each workspace separately with devenv allow from its root.
devenv hook fish | source
