# Automatic activation

Use devenv's native shell hook for automatic activation when entering this
workspace. Install the hook once, then allow each checkout from its root.
This uses the existing `devenv.nix` and needs no extra activation dependency.

For Bash, add this to your Bash startup configuration and reload it:

```bash
eval "$(devenv hook bash)"
```

For Zsh, use:

```zsh
eval "$(devenv hook zsh)"
```

Fish/Nushell may load the Nix-installed hook already. If absent, use
`devenv hook fish | source` in Fish startup configuration. For Nushell, install
the generated hook into its discovered autoload directory:

```nu
mkdir ($nu.default-config-dir | path join autoload)
devenv hook nu | save --force ($nu.default-config-dir | path join autoload/devenv-hook.nu)
```

Run once from the workspace root:

```sh
devenv allow
```

Subsequent entry activates the shell; leaving the workspace deactivates it.
Nested directories retain the active environment. `devenv revoke` removes that
checkout's activation permission. A relocated/new checkout needs its own allow.
See the official [devenv activation guide](https://devenv.sh/auto-activation/).

Tracked shell fragments live in `config/shell/`. Host startup files and trust
records stay personal. To append a guarded native hook while preserving an
existing shell configuration and allow this checkout, use:

```sh
devenv shell -- wb setup --activation bash
devenv shell -- wb doctor --shell bash --json
```

Other choices are `zsh`, `fish` and `nu`. `--shell-config <path>` selects a
configuration path explicitly. Nushell setup creates the native autoload hook
and refuses to overwrite a different existing hook. Doctor inspects hook
configuration and devenv's local trust probe; it does not prove interactive
entry/exit behavior.

For direnv-based editors/shells, the existing `.envrc` supports `direnv allow`
and watches the root Nix modules/pins. Choose one activation method per shell.
Noninteractive agents and CI invoke `devenv shell -- <command>` explicitly.
Activation requires input downloads/a built shell. The locked upstream devenv
CLI/modules are unmodified. Its native Fish launcher currently fails when the
initialization path contains spaces because that path is emitted unquoted.
Use explicit noninteractive execution or the documented direnv integration for
such workspaces. Interactive activation regression tests are outside this
project's validation scope; we do not maintain an upstream shell implementation.
