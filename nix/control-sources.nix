{ pkgs }:
let
  nodeModules = pkgs.importNpmLock.buildNodeModules {
    npmRoot = ../tools;
    nodejs = pkgs.nodejs;
  };
  operationSources = pkgs.runCommand "winboat-operation-sources" { } (
    "mkdir -p $out/wb $out/mcp\nln -s ${nodeModules}/node_modules $out/node_modules\n"
    +
      pkgs.lib.concatMapStringsSep "\n"
        (
          name:
          ''cp ${
            pkgs.writeText (builtins.baseNameOf name) (builtins.readFile (../tools + "/${name}"))
          } "$out/${name}"''
        )
        [
          "package.json"
          "package-lock.json"
          "wb/cli.mjs"
          "wb/cli-schema.json"
          "wb/builds.mjs"
          "wb/devbox.mjs"
          "wb/graphics.mjs"
          "wb/windows.mjs"
          "wb/archives.mjs"
          "wb/qmp.mjs"
          "wb/common.mjs"
          "wb/lock-holder.mjs"
          "wb/jobs.mjs"
          "wb/agents.mjs"
          "wb/evidence.mjs"
          "wb/bundles.mjs"
          "wb/release-producer.mjs"
          "wb/hosted-driver.mjs"
          "wb/release-zip-metadata.mjs"
          "wb/publication.mjs"
          "wb/repos.mjs"
          "wb/workspace.mjs"
          "mcp/server.mjs"
        ]
  );
in
operationSources
