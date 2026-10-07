# Seed snapshot, 2026-10-02. These are object IDs, not claims about remote HEAD
# or a working graphics stack. See docs/repositories.md for provenance.
# Stage 1 resolves named development branches; remote receipts stay separate.
# Stage 6 published component recipes/workflows; provenance records verified pushes.
{
  schemaVersion = 1;
  repositories = {
    helios = {
      rev = "dac6d0f93db879193aeb91c7395d1dce6426479a";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    qemu-helios = {
      rev = "090446454fbb1a834334c27547a758aa60d1ee6b";
      ref = "refs/heads/helios-11.1.1";
      provenance = "verified-push";
    };
    dxvk = {
      rev = "6948271578bf2aa6481389a07b5070c95f911952";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    virglrenderer = {
      rev = "48cbbf401443e96c7e7f2cd113e432c557ebf6a0";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
    mesa-helios = {
      rev = "aa42464065e0b436516fa7514eeda18a976b462d";
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
