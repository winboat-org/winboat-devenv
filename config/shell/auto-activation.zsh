# Source once from your Zsh startup configuration.
# Trust each workspace separately with devenv allow from its root.
if (( ! $+functions[_devenv_hook] )); then
  eval "$(devenv hook zsh)"
fi
