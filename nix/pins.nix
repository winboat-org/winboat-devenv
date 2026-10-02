# Seed snapshot, 2026-10-02. These are object IDs, not claims about remote HEAD
# or a working graphics stack. See docs/repositories.md for provenance.
# Stage 1 resolves named development branches; remote receipts stay separate.
{
  schemaVersion = 1;
  repositories = {
    helios = {
      rev = "52c02799a042ecab25b9e812db9c002ba98ddb7c";
      ref = "refs/heads/master";
      provenance = "reference-helios-head";
    };
    qemu-helios = {
      rev = "37e165580f5eaeb861e311bcc8530e635af0a143";
      ref = "refs/heads/helios-11.1.1";
      provenance = "reference-helios-gitlink";
    };
    dxvk = {
      rev = "da42d2d289eb956305abddce9099b076d1e8a73b";
      ref = "refs/heads/master";
      provenance = "reference-helios-gitlink";
    };
    virglrenderer = {
      rev = "5d0e47bd8ad9ba75a62c2e048b927c9d0dc45b05";
      ref = "refs/heads/main";
      provenance = "reference-helios-gitlink";
    };
    mesa-helios = {
      rev = "89bd0676a4e69740d9900fb13561b14acc4997d6";
      ref = "refs/heads/main";
      provenance = "reference-helios-gitlink";
    };
    vkd3d-proton = {
      rev = "9494617539385c6d2d9925984d55d3f9d3143d0d";
      ref = "refs/heads/master";
      provenance = "reference-helios-gitlink";
    };
    dxil-spirv = {
      rev = "f4651bd076a2613728823ec289abc121a348a48a";
      ref = "refs/heads/master";
      provenance = "reference-vkd3d-gitlink";
    };
    venus-protocol = {
      rev = "fe08e82c3819e8ee3c547b1ea810fde61f46fa78";
      ref = "refs/heads/main";
      provenance = "reference-helios-gitlink";
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
