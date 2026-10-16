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
      rev = "6577af923eac07522b4a6879854f1469c48c5801";
      ref = "refs/heads/helios-11.1.1";
      provenance = "verified-push";
    };
    dxvk = {
      rev = "aaca727df5e29514c19bf59261929da6973a088c";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    virglrenderer = {
      rev = "34ef8546174c9a5b8c308239c6725422aa3879c5";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
    mesa-helios = {
      rev = "3c6e237eac13dd04bc0e373600d802d13f308068";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
    vkd3d-proton = {
      rev = "6862ca7add7ea994c6035e4b82358439dd181264";
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
      rev = "cfb2f21e912a22974b77526e4362f959c13c714f";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
  };
}
