# Nix may already install this hook; load it once if absent.
# Trust each workspace separately with devenv allow from its root.
if not functions -q _devenv_hook
    devenv hook fish | source
end
