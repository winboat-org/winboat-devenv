# A Git checkout alone is not an Electron build source closure. Do not run
# gclient/e sync or CIPD opportunistically from a derivation.
{
  backend = "unavailable";
  buildSystem = "GN/Ninja";
  inputContract = {
    schemaVersion = 1;
    required = [
      "electron"
      "Chromium-at-DEPS-revision"
      "depot_tools"
      "Node"
      "V8"
      "CIPD-packages"
      "sysroots"
      "GN-args"
      "patches-config"
    ];
    identity = "Each source/package requires an exact revision and verified NAR or archive hash.";
  };
  reason = "The pinned Electron checkout has no verified Chromium/depot_tools/CIPD/sysroot source closure; build-time downloads are disabled.";
}
