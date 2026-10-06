# Seed snapshot, 2026-10-02. These are object IDs, not claims about remote HEAD
# or a working graphics stack. See docs/repositories.md for provenance.
# Stage 1 resolves named development branches; remote receipts stay separate.
# Stage 6 published component recipes/workflows; provenance records verified pushes.
{
  schemaVersion = 1;
  repositories = {
    helios = {
      rev = "3b2e4c451368e11c528e544e6a3c870b001e817a";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    qemu-helios = {
      rev = "a5e032cd6f0b5e1ea7889afd131d59b311c2b850";
      ref = "refs/heads/helios-11.1.1";
      provenance = "verified-push";
    };
    dxvk = {
      rev = "16d521ca96d8cc6f2670c648465b1c544f29a39d";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    virglrenderer = {
      rev = "72a8e2ad9ab1103bb7293e0c47e2991ec9737c03";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
    mesa-helios = {
      rev = "c75464941107a63440f79ff8570ad866815f6458";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
    vkd3d-proton = {
      rev = "62bc83f390548c3072905e8c0d1b1e7094b8d312";
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
