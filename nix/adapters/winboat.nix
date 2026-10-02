{
  backend = "unavailable";
  buildSystem = "Bun/Vite/electron-builder";
  inputContract = {
    schemaVersion = 1;
    required = [
      "winboat"
      "Bun-lock-cache"
      "patched-usb-native-module"
      "Electron-fork-binary"
      "guest-server-payload"
    ];
    identity = "Verified dependency cache and exact manifested Electron/guest-server artifacts; no install scripts may fetch binaries.";
  };
  reason = "The Bun lock has no fixed Nix dependency cache; the forked Electron binary and guest-server payload are not available as verified artifacts.";
}
