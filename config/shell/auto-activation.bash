# Source once from your Bash startup configuration.
# Trust each workspace separately with devenv allow from its root.
if ! declare -F _devenv_hook >/dev/null; then
  eval "$(devenv hook bash)"
fi
