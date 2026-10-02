# Seed snapshot, 2026-10-02. These are object IDs, not claims about remote HEAD
# or a working graphics stack. See docs/repositories.md for provenance.
# null means unresolved: mutation/build commands must refuse that repository.
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
      ref = null;
      provenance = "reference-helios-gitlink";
    };
    virglrenderer = {
      rev = "5d0e47bd8ad9ba75a62c2e048b927c9d0dc45b05";
      ref = null;
      provenance = "reference-helios-gitlink";
    };
    mesa-helios = {
      rev = "89bd0676a4e69740d9900fb13561b14acc4997d6";
      ref = null;
      provenance = "reference-helios-gitlink";
    };
    vkd3d-proton = {
      rev = "9494617539385c6d2d9925984d55d3f9d3143d0d";
      ref = "refs/heads/master";
      provenance = "reference-helios-gitlink";
    };
    dxil-spirv = {
      rev = "f4651bd076a2613728823ec289abc121a348a48a";
      ref = "refs/heads/helios-native-fl12";
      provenance = "reference-vkd3d-gitlink";
    };
    venus-protocol = {
      rev = "fe08e82c3819e8ee3c547b1ea810fde61f46fa78";
      ref = "refs/heads/main";
      provenance = "reference-helios-gitlink";
    };
    winboat = {
      rev = "17563cacb82ca31efe5feb12e3968f51951f1085";
      ref = "refs/heads/gpu-accel";
      provenance = "reference-winboat-head";
    };
    WBFreeRDP = {
      rev = null;
      ref = null;
      provenance = "unresolved-network-unavailable";
    };
    electron = {
      rev = null;
      ref = null;
      provenance = "unresolved-network-unavailable";
    };
    clvk-helios = {
      rev = "56c626132782bf083a80a6c17f5ca763be0ff8fb";
      ref = null;
      provenance = "reference-helios-windows-ci";
    };
  };
}
