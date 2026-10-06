# Seed snapshot, 2026-10-02. These are object IDs, not claims about remote HEAD
# or a working graphics stack. See docs/repositories.md for provenance.
# Stage 1 resolves named development branches; remote receipts stay separate.
# Stage 6 published component recipes/workflows; provenance records verified pushes.
{
  schemaVersion = 1;
  repositories = {
    helios = {
      rev = "2076044a616e54ba6a9917b8eb039f495ee4e1d0";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    qemu-helios = {
      rev = "0289191d800b8c912c39b9c7489477581c948f78";
      ref = "refs/heads/helios-11.1.1";
      provenance = "verified-push";
    };
    dxvk = {
      rev = "ae529efce05dd5ecbe4b61c2034bbc7c2dd86d0b";
      ref = "refs/heads/master";
      provenance = "verified-push";
    };
    virglrenderer = {
      rev = "5b38b51172e56801a8d29303ef6fb9ace8935d07";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
    mesa-helios = {
      rev = "08fb3602f909a52e7afaea8557a83fc7b63a7dbd";
      ref = "refs/heads/main";
      provenance = "verified-push";
    };
    vkd3d-proton = {
      rev = "2febdf99504e540544acbf7b65628d5b4dfb4671";
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
