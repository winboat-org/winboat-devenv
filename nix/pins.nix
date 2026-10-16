# Seed snapshot, 2026-10-02. These are object IDs, not claims about remote HEAD
# or a working graphics stack. See docs/repositories.md for provenance.
# Stage 1 resolves named development branches; remote receipts stay separate.
# Stage 6 published component recipes/workflows; provenance records verified pushes.
{
  schemaVersion = 1;
  repositories = {
    helios = {
      rev = "d82ce565ac792eb48da5e59f2a82a12ff221851d";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    qemu-helios = {
      rev = "5262ea9400ba44a1d9bbf18bea77ec30e7ab9422";
      ref = "refs/heads/helios-11.1.1";
      provenance = "verified-push";
    };
    dxvk = {
      rev = "aaca727df5e29514c19bf59261929da6973a088c";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    virglrenderer = {
      rev = "48cbbf401443e96c7e7f2cd113e432c557ebf6a0";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
    mesa-helios = {
      rev = "3c6e237eac13dd04bc0e373600d802d13f308068";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
    vkd3d-proton = {
      rev = "3d1ba76b2c2e89b657112b44e0771beff3677ebe";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    dxil-spirv = {
      rev = "f4651bd076a2613728823ec289abc121a348a48a";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    venus-protocol = {
      rev = "fe08e82c3819e8ee3c547b1ea810fde61f46fa78";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
    winboat = {
      rev = "17563cacb82ca31efe5feb12e3968f51951f1085";
      ref = "refs/heads/main";
      provenance = "reference-winboat-head";
    };
    WBFreeRDP = {
      rev = "24b2e41269ecd04b9cd2dbea72fb8406b69b16a0";
      ref = "refs/heads/winboat-3.30";
      provenance = "canonical-winboat-3.30-2026-10-02";
    };
    electron = {
      rev = "c328b030fd3357139f66c8a3a84a4384c0136eed";
      ref = "refs/heads/winboat-43.2.0";
      provenance = "canonical-winboat-43.2.0-2026-10-02";
    };
    clvk-helios = {
      rev = "56c626132782bf083a80a6c17f5ca763be0ff8fb";
      ref = "refs/heads/main";
      provenance = "reference-helios-windows-ci";
    };
  };
}
