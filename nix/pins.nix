# Seed snapshot, 2026-10-02. These are object IDs, not claims about remote HEAD
# or a working graphics stack. See docs/repositories.md for provenance.
# Stage 1 resolves named development branches; remote receipts stay separate.
# Stage 2 recipe pins are verified local objects; canonical publication is pending.
{
  schemaVersion = 1;
  repositories = {
    helios = {
      rev = "b84ed182ba68974cb495b53bad74200409d6367f";
      ref = "refs/heads/master";
      provenance = "explicit-verified-pin";
    };
    qemu-helios = {
      rev = "2544a0bb2b11992fe31d043961ed507fe581f31f";
      ref = "refs/heads/helios-11.1.1";
      provenance = "stage-03-local-unpublished";
    };
    dxvk = {
      rev = "8587b949ef80dc4f5a00450ab8ce5e4cd404e3aa";
      ref = "refs/heads/master";
      provenance = "stage-02-local-unpublished";
    };
    virglrenderer = {
      rev = "8668479d681f47ade80808c9d3fc1457540d7d58";
      ref = "refs/heads/main";
      provenance = "stage-02-local-unpublished";
    };
    mesa-helios = {
      rev = "8d653f8eeae01750ccad377ce68216823ea998fb";
      ref = "refs/heads/main";
      provenance = "stage-02-local-unpublished";
    };
    vkd3d-proton = {
      rev = "2771ebe5db3fa01bb716b2856864921ab4e0f213";
      ref = "refs/heads/master";
      provenance = "explicit-verified-pin";
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
