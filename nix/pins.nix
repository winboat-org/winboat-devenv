# Seed snapshot, 2026-10-02. These are object IDs, not claims about remote HEAD
# or a working graphics stack. See docs/repositories.md for provenance.
# Stage 1 resolves named development branches; remote receipts stay separate.
# Stage 2 recipe pins are verified local objects; canonical publication is pending.
{
  schemaVersion = 1;
  repositories = {
    helios = {
      rev = "5617cf5cdd7a548ea96f54e93c7163a57268d685";
      ref = "refs/heads/master";
      provenance = "stage-04-egl-local-unpublished";
    };
    qemu-helios = {
      rev = "e81b51e1188a39e7041c4e06117b6bdf45becdd1";
      ref = "refs/heads/helios-11.1.1";
      provenance = "stage-04-egl-local-unpublished";
    };
    dxvk = {
      rev = "e73ee9d0da9628e5f444b2e002e0079fd96ae3d3";
      ref = "refs/heads/master";
      provenance = "stage-04-cross-local-unpublished";
    };
    virglrenderer = {
      rev = "8668479d681f47ade80808c9d3fc1457540d7d58";
      ref = "refs/heads/main";
      provenance = "stage-02-local-unpublished";
    };
    mesa-helios = {
      rev = "48003fe5ce933381ea3609a654e86a2a24b87f71";
      ref = "refs/heads/main";
      provenance = "stage-04-cross-local-unpublished";
    };
    vkd3d-proton = {
      rev = "aff0927cab46c700a6edd78a3b1621fa9e109f18";
      ref = "refs/heads/master";
      provenance = "stage-04-cross-local-unpublished";
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
