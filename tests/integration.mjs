// Real local Git transports; never organization pushes.
import test from "node:test";
import { once } from "node:events";
import { Failure } from "../tools/wb/common.mjs";
import * as builds from "../tools/wb/builds.mjs";
import { sortedJSON } from "../tools/wb/common.mjs";
import {
  assert as a,
  fs,
  path,
  ROOT,
  WB,
  WRAPPER,
  REAL,
  MANIFEST,
  Fixture,
  write,
  parse_pins,
  edit_pins,
  digest,
  call,
  asyncCall,
  mcp,
  until,
} from "./helpers.mjs";
const check = (name, fn) => test(name, (t) => fn(new Fixture(t), t));
test("legacy artifact path ordering and Unicode identity serialization", (t) => {
  const root = fs.mkdtempSync("/tmp/wb-artifact-order-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(path.join(root, "firmware/a"), "image");
  write(path.join(root, "firmware-old/a"), "image");
  a.deepEqual(
    builds._files(root).map((f) => f.path),
    ["firmware/a", "firmware-old/a"],
  );
  a.equal(sortedJSON({ é: ["λ"] }), '{"\\u00e9": ["\\u03bb"]}');
});
const refused = (f, ...args) => {
  const r = f.wb(...args, { check: false });
  a.notEqual(r.exitCode, 0);
  return r;
};
check("selection and read-only plan", (f) => {
  const before = f.snapshot(f.root);
  for (const [subset, count] of [
    ["helios", 8],
    ["winboat", 3],
    ["winboat-accel", 12],
    ["all", 12],
  ])
    a.equal(f.wb("repo", "list", "--subset", subset).selected.length, count);
  const selected = f.wb("repo", "plan", "--repo", "qemu-helios");
  a.deepEqual(
    new Set(selected.selected),
    new Set(["qemu-helios", "virglrenderer", "venus-protocol"]),
  );
  a.deepEqual(selected.containers, ["helios"]);
  a.deepEqual(f.wb("repo", "list", "--repo", "clkvk-helios").selected, [
    "clvk-helios",
  ]);
  a.equal(
    f.wb("repo", "list", "--repo", "winboat", "--repo", "electron").selected
      .length,
    2,
  );
  a.deepEqual(f.snapshot(f.root), before);
  a.ok(!fs.existsSync(path.join(f.root, "repos")));
  a.equal(refused(f, "repo", "list", "--repo", "missing").exitCode, 2);
});
check("selective nested sync and all", (f) => {
  f.wb("repo", "sync", "--repo", "qemu-helios");
  a.ok(fs.statSync(path.join(f.path("qemu-helios"), ".git")).isFile());
  for (const p of [
    path.join(f.path("dxvk"), ".git"),
    path.join(f.path("qemu-helios"), "forbidden-qemu-module/.git"),
    path.join(f.path("helios"), "LookingGlass/.git"),
  ])
    a.ok(!fs.existsSync(p));
  f.wb("repo", "sync", "--subset", "all");
  for (const [n, sha] of Object.entries(f.shas))
    a.equal(f.head(f.path(n)), sha);
  for (const n of ["dxil-spirv", "venus-protocol"])
    a.ok(fs.existsSync(path.join(f.path(n), ".git")));
  a.ok(
    !fs.existsSync(
      path.join(f.path("qemu-helios"), "forbidden-qemu-module/.git"),
    ),
  );
  a.ok(fs.existsSync(path.join(f.path("dxvk"), "include/native/directx/.git")));
});
check("dirty staged untracked and unselected preserved", (f) => {
  f.wb("repo", "sync", "--subset", "winboat");
  const p = f.path("winboat");
  write(path.join(p, "source.txt"), "staged\n");
  f.g(p, "add", "source.txt");
  write(path.join(p, "source.txt"), "working\n");
  write(path.join(p, "untracked.txt"), "keep\n");
  const before = f.snapshot(p),
    hashes = () =>
      Object.fromEntries(
        fs
          .readdirSync(p)
          .filter((n) => fs.statSync(path.join(p, n)).isFile())
          .map((n) => [n, digest(path.join(p, n))]),
      ),
    expected = hashes();
  refused(f, "repo", "sync", "--subset", "winboat");
  a.deepEqual(f.snapshot(p), before);
  a.deepEqual(hashes(), expected);
  f.wb("repo", "sync", "--repo", "electron");
  a.deepEqual(f.snapshot(p), before);
});
check("conflict and parent consistency refusal", (f) => {
  const [p] = f.develop();
  f.g(p, "checkout", "-b", "conflict", f.shas.winboat);
  f.change(p, "conflict\n");
  f.g(p, "merge", "dev", { check: false });
  const before = f.snapshot(p);
  refused(f, "repo", "sync", "--repo", "winboat");
  a.deepEqual(f.snapshot(p), before);
  write(
    f.pins,
    edit_pins(fs.readFileSync(f.pins, "utf8"), {
      "qemu-helios": { rev: f.shas.winboat },
    }),
  );
  f.local.workspace.remotes["qemu-helios"] = f.urls.winboat;
  f.writeLocal();
  a.match(refused(f, "repo", "sync", "--repo", "qemu-helios").error, /gitlink/);
  a.ok(!fs.existsSync(path.join(f.path("helios"), ".git")));
});
check("successful push preserves root work and index", (f) => {
  const [p, sha] = f.develop();
  write(path.join(f.root, "unrelated.txt"), "staged unrelated\n");
  f.g(f.root, "add", "unrelated.txt");
  write(path.join(f.root, "unrelated.txt"), "working unrelated\n");
  write(
    f.pins,
    edit_pins(fs.readFileSync(f.pins, "utf8"), {
      electron: { provenance: "unrelated-staged" },
    }),
  );
  f.g(f.root, "add", "nix/pins.nix");
  write(
    f.pins,
    edit_pins(fs.readFileSync(f.pins, "utf8"), {
      WBFreeRDP: { provenance: "unrelated-working" },
    }),
  );
  f.wrapper("-C", p, "push", "origin", "dev:refs/heads/dev");
  a.equal(f.pinValues().winboat.rev, sha);
  a.notEqual(
    f.pinValues(f.g(f.root, "show", "HEAD:nix/pins.nix").stdout).electron
      .provenance,
    "unrelated-staged",
  );
  a.equal(
    f.pinValues(f.g(f.root, "show", ":nix/pins.nix").stdout).electron
      .provenance,
    "unrelated-staged",
  );
  a.equal(f.pinValues().WBFreeRDP.provenance, "unrelated-working");
  a.equal(f.g(f.root, "show", ":unrelated.txt").stdout, "staged unrelated\n");
  a.equal(
    fs.readFileSync(path.join(f.root, "unrelated.txt"), "utf8"),
    "working unrelated\n",
  );
  a.equal(f.g(f.root, "show", "HEAD:unrelated.txt").stdout, "original\n");
});
check("push exact source rather than checkout HEAD and no-op", (f) => {
  const [p, sha] = f.develop();
  f.change(p, "newer HEAD\n");
  f.wrapper(
    "-C",
    p,
    "-c",
    "push.default=current",
    "push",
    "origin",
    sha + ":refs/heads/dev",
  );
  a.equal(f.pinValues().winboat.rev, sha);
  a.notEqual(f.head(p), sha);
  const before = f.head(f.root);
  f.wrapper("-C", p, "push", "origin", sha + ":refs/heads/dev");
  a.equal(f.head(f.root), before);
});
check("failed dry-run tag delete unselected and ambiguous pushes", (f) => {
  const [p] = f.develop(),
    original = fs.readFileSync(f.pins);
  f.wrapper("-C", p, "push", "--dry-run", "origin", "dev:dev");
  a.deepEqual(fs.readFileSync(f.pins), original);
  f.wrapper("-C", p, "push", "origin", "dev:other");
  f.g(p, "tag", "test");
  f.wrapper("-C", p, "push", "origin", "refs/tags/test");
  f.wrapper("-C", p, "push", "origin", ":other");
  a.deepEqual(fs.readFileSync(f.pins), original);
  a.notEqual(
    f.wrapper("-C", p, "push", "--all", "origin", { check: false }).status,
    0,
  );
  const hook = path.join(f.urls.winboat, "hooks/pre-receive");
  write(hook, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(hook, 0o755);
  a.notEqual(
    f.wrapper("-C", p, "push", "origin", "dev:dev", { check: false }).status,
    0,
  );
  a.deepEqual(fs.readFileSync(f.pins), original);
});
check(
  "wrapper multiple refspecs detached lease global options and stdin",
  (f) => {
    const [p, sha] = f.develop();
    f.g(p, "checkout", "--detach", sha);
    f.wrapper(
      "--git-dir=" + path.join(p, ".git"),
      "--work-tree=" + p,
      "push",
      "--force-with-lease=refs/heads/dev:" + f.shas.winboat,
      "origin",
      "HEAD:refs/heads/dev",
      "HEAD:refs/heads/topic",
    );
    a.equal(f.pinValues().winboat.rev, sha);
    a.equal(f.wrapper("-C", p, "rev-parse", "HEAD").stdout.trim(), sha);
    f.wrapper(
      "-C",
      path.dirname(p),
      "-C",
      path.basename(p),
      "status",
      "--short",
    );
    a.equal(
      f.wrapper("-C", p, "hash-object", "--stdin", {
        input: "stdin preserved\n",
      }).stdout,
      f.g(p, "hash-object", "--stdin", { input: "stdin preserved\n" }).stdout,
    );
  },
);
check("alternate pushurl and mirror rejected before effect", (f) => {
  const [p] = f.develop(),
    alternate = path.join(f.base, "alternate.git");
  call([REAL, "clone", "--bare", f.urls.winboat, alternate], { env: f.env });
  f.g(p, "remote", "set-url", "--push", "origin", alternate);
  a.notEqual(
    f.wrapper("-C", p, "push", "origin", "dev:dev", { check: false }).status,
    0,
  );
  a.equal(f.g(alternate, "rev-parse", "dev").stdout.trim(), f.shas.winboat);
  a.notEqual(
    f.wrapper("-C", p, "push", "--mirror", "origin", { check: false }).status,
    0,
  );
});
check("post-push write and commit failure reconciliation", (f) => {
  const [p, sha] = f.develop();
  a.notEqual(
    f.wrapper("-C", p, "push", "origin", "dev:dev", {
      check: false,
      extra: { WB_TEST_FAIL_PIN_WRITE: "1" },
    }).status,
    0,
  );
  a.equal(f.g(f.urls.winboat, "rev-parse", "dev").stdout.trim(), sha);
  let receipt = f.receipts().find((r) => r.kind === "push");
  a.equal(receipt.state, "partial");
  a.equal(
    f.wb("repo", "reconcile", "--operation", receipt.operationId).state,
    "succeeded",
  );
  a.equal(f.pinValues().winboat.rev, sha);
  f.change(p, "commit failure\n");
  a.notEqual(
    f.wrapper("-C", p, "push", "origin", "dev:dev", {
      check: false,
      extra: { WB_TEST_FAIL_PIN_COMMIT: "1" },
    }).status,
    0,
  );
  receipt = f
    .receipts()
    .find((r) => r.kind === "push" && r.state === "partial");
  f.wb("repo", "reconcile", "--operation", receipt.operationId);
});
check("concurrent disjoint pin writers", async (f) => {
  const pairs = [f.develop("winboat"), f.develop("electron")];
  await Promise.all(
    pairs.map(([p]) =>
      asyncCall([WRAPPER, "-C", p, "push", "origin", "dev:dev"], {
        cwd: f.root,
        env: f.env,
      }),
    ),
  );
  a.equal(f.pinValues().winboat.rev, pairs[0][1]);
  a.equal(f.pinValues().electron.rev, pairs[1][1]);
});
check("deferred checkpoint and remote drift refusal", (f) => {
  const [p, sha] = f.develop(),
    head = f.head(f.root),
    transaction = f.wb(
      "repo",
      "push",
      "--repo",
      "winboat",
      "--defer-checkpoint",
    ).transactions[0];
  a.equal(transaction.state, "deferred");
  a.equal(f.head(f.root), head);
  f.wb("repo", "reconcile", "--operation", transaction.operationId);
  a.equal(
    f.pinValues(f.g(f.root, "show", "HEAD:nix/pins.nix").stdout).winboat.rev,
    sha,
  );
  f.change(p, "after receipt\n");
  f.g(p, "push", "origin", "dev:dev");
  const original = fs.readFileSync(f.pins);
  refused(f, "repo", "reconcile", "--operation", transaction.operationId);
  a.deepEqual(fs.readFileSync(f.pins), original);
});
check("explicit pin source and single alternate pushurl", (f) => {
  const [p, sha] = f.develop(),
    alternate = path.join(f.base, "explicit alternate.git");
  call([REAL, "clone", "--bare", f.urls.winboat, alternate], { env: f.env });
  f.wb(
    "repo",
    "pin",
    "--repo",
    "winboat",
    "--rev",
    f.shas.winboat,
    "--ref",
    "refs/heads/dev",
    "--source-url",
    alternate,
  );
  f.g(p, "remote", "set-url", "--push", "origin", alternate);
  f.wrapper("-C", p, "push", "origin", "dev:dev");
  a.equal(f.pinValues().winboat.rev, sha);
  a.equal(f.pinValues().winboat.sourceUrl, alternate);
});
check("subset tolerates unresolved unselected pin and path precedence", (f) => {
  write(
    f.pins,
    edit_pins(fs.readFileSync(f.pins, "utf8"), { electron: { rev: null } }),
  );
  f.wb("repo", "sync", "--subset", "helios");
  refused(f, "repo", "sync", "--repo", "electron");
  a.equal(
    f.wb(
      "--repositories-root",
      "sources with spaces",
      "repo",
      "list",
      "--repo",
      "winboat",
    ).repositories[0].path,
    path.join(f.root, "sources with spaces/winboat"),
  );
  refused(f, "--state-root", ".", "repo", "list");
});
check("branch creation and checkpoint deletion scope", (f) => {
  f.wb("repo", "sync", "--repo", "winboat");
  a.equal(f.wb("repo", "branch", "--repo", "winboat").branch, "dev");
  const p = f.path("winboat");
  fs.unlinkSync(path.join(p, "other.txt"));
  f.wb(
    "repo",
    "checkpoint",
    "--repo",
    "winboat",
    "--path",
    "winboat:other.txt",
    "--message",
    "explicit deletion",
  );
  a.notEqual(f.g(p, "show", "HEAD:other.txt", { check: false }).status, 0);
});
check("managed delete and unmanaged pushes", (f) => {
  const [p] = f.develop();
  f.g(f.urls.winboat, "config", "receive.denyDeleteCurrent", "ignore");
  const original = fs.readFileSync(f.pins);
  f.wrapper("-C", p, "push", "origin", ":refs/heads/dev");
  a.deepEqual(fs.readFileSync(f.pins), original);
  const [external, remote] = f.makeSource("unmanaged");
  f.g(external, "remote", "add", "origin", remote);
  write(path.join(external, "file.txt"), "unmanaged edit");
  f.g(external, "add", "file.txt");
  f.g(external, "commit", "-m", "unmanaged");
  f.wrapper("-C", external, "push", "origin", "dev:dev");
  a.equal(f.g(remote, "rev-parse", "dev").stdout.trim(), f.head(external));
  a.deepEqual(fs.readFileSync(f.pins), original);
});
check("durable push cancellation refuses blind resume", async (f) => {
  f.develop();
  const hook = path.join(f.urls.winboat, "hooks/pre-receive");
  write(hook, "#!/bin/sh\nsleep 3\nexit 0\n");
  fs.chmodSync(hook, 0o755);
  const job = f.wb("repo", "push", "--repo", "winboat", "--background");
  await until(
    () => f.wb("job", "status", "--id", job.jobId),
    (r) => r.state === "running" && r.workerPid,
  );
  f.wb("job", "cancel", "--id", job.jobId);
  await until(
    () => f.wb("job", "status", "--id", job.jobId, { check: false }).result,
    (r) => r.state === "cancelled",
  );
  refused(f, "job", "resume", "--id", job.jobId);
  a.equal(
    f.g(f.urls.winboat, "rev-parse", "dev").stdout.trim(),
    f.shas.winboat,
  );
});
check("checkpoint scope and dependency-first parent publication", (f) => {
  f.wb("repo", "sync", "--repo", "venus-protocol");
  const p = f.path("venus-protocol");
  write(path.join(p, "source.txt"), "checkpoint\n");
  write(path.join(p, "other.txt"), "staged unrelated\n");
  f.g(p, "add", "other.txt");
  f.wb(
    "repo",
    "checkpoint",
    "--repo",
    "venus-protocol",
    "--path",
    "source.txt",
    "--message",
    "scoped checkpoint",
  );
  a.equal(f.g(p, "show", "HEAD:other.txt").stdout, "original\n");
  a.equal(f.g(p, "show", ":other.txt").stdout, "staged unrelated\n");
  const sha = f.head(p);
  f.wrapper("-C", p, "push", "origin", "HEAD:dev");
  const parent = f.path("helios");
  a.equal(
    f.g(parent, "ls-tree", "HEAD", "venus-protocol").stdout.split(/\s+/)[2],
    sha,
  );
  a.equal(f.pinValues().helios.rev, f.shas.helios);
  f.wrapper("-C", parent, "push", "origin", "HEAD:dev");
  a.equal(f.pinValues().helios.rev, f.head(parent));
});
check("fork scoped remotes and missing fork", (f) => {
  f.wb("repo", "sync", "--subset", "winboat");
  const original = fs.readFileSync(f.pins),
    fork = path.join(f.base, "forks/contributor");
  fs.mkdirSync(fork, { recursive: true });
  for (const n of ["winboat", "electron", "WBFreeRDP"]) {
    call([REAL, "clone", "--bare", f.urls[n], path.join(fork, n + ".git")], {
      env: f.env,
    });
    f.local.workspace.remotes[n] = path.join(
      f.base,
      "forks/{namespace}",
      n + ".git",
    );
    f.g(f.path(n), "remote", "add", "upstream", MANIFEST.repositories[n].url);
  }
  f.writeLocal();
  f.wb(
    "repo",
    "fork",
    "--repo",
    "winboat",
    "--namespace",
    "contributor",
    "--apply",
  );
  a.equal(
    f.g(f.path("winboat"), "remote", "get-url", "origin").stdout.trim(),
    path.join(fork, "winboat.git"),
  );
  a.equal(
    f.g(f.path("electron"), "remote", "get-url", "origin").stdout.trim(),
    f.urls.electron,
  );
  a.deepEqual(fs.readFileSync(f.pins), original);
  a.match(
    refused(
      f,
      "repo",
      "fork",
      "--repo",
      "electron",
      "--namespace",
      "missing",
      "--apply",
    ).error,
    /fork unavailable/,
  );
});
check("configuration setup and read-only adoption", (f) => {
  f.wb("setup");
  const original = fs.readFileSync(path.join(f.root, "local.json"));
  f.wb("setup");
  a.deepEqual(fs.readFileSync(path.join(f.root, "local.json")), original);
  f.wb("repo", "sync", "--repo", "winboat");
  const external = path.join(f.base, "read only reference");
  fs.renameSync(f.path("winboat"), external);
  write(path.join(external, "untracked.txt"), "preserve");
  f.local.workspace.repositoryOverrides = {
    winboat: { path: external, adopt: true, readOnly: true },
  };
  f.writeLocal();
  const before = f.snapshot(external);
  a.equal(
    f.wb("repo", "status", "--repo", "winboat").repositories[0].present,
    true,
  );
  a.match(refused(f, "repo", "sync", "--repo", "winboat").error, /read-only/);
  a.deepEqual(f.snapshot(external), before);
});
check("MCP CLI parity typed failures and durable disconnect", async (f, t) => {
  const client = mcp(t, f),
    rpc = client.rpc;
  a.ok(
    (
      await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "acceptance", version: "1" },
      })
    ).result.serverInfo,
  );
  const tools = (await rpc("tools/list")).result.tools.map((t) => t.name);
  for (const name of [
    "repo_reconcile",
    "build_run",
    "devbox_create",
    "devbox_viewer_status",
    "devbox_cdi_prepare",
    "devbox_run",
    "devbox_mirror",
    "devbox_install",
    "devbox_build",
    "devbox_job_status",
    "devbox_registry_reconcile",
    "devbox_migrate_host",
  ])
    a.ok(tools.includes(name));
  const invoke = (name, arguments_ = {}) =>
    rpc("tools/call", { name, arguments: arguments_ });
  for (const [name, args] of [
    ["devbox_run", { purpose: "console", script: "fixture.ps1" }],
    ["devbox_run", { purpose: "desktop" }],
    ["devbox_migrate_host", { name: "missing" }],
    [
      "devbox_build",
      {
        target: "helios-development-package",
        dependencyManifests: "manifest.json",
      },
    ],
    ["devbox_create", { graphicsProvider: "unsupported" }],
    ["devbox_down", { timeout: 1 }],
    ["devbox_media", { iso: "example.iso", index: 1.5 }],
    ["repo_sync", { repos: "winboat" }],
  ])
    a.equal((await invoke(name, args)).error.code, -32602);
  for (const [name, args, cli] of [
    [
      "devbox_migrate_host",
      { name: "missing", manifest: "missing-host.json", background: false },
      [
        "devbox",
        "migrate-host",
        "--name",
        "missing",
        "--manifest",
        "missing-host.json",
      ],
    ],
    [
      "devbox_build",
      { target: "unknown-target", background: false },
      ["devbox", "build", "--target", "unknown-target"],
    ],
    [
      "devbox_cdi_prepare",
      { renderNode: "/dev/dri/not-a-node" },
      ["devbox", "cdi", "prepare", "--render-node", "/dev/dri/not-a-node"],
    ],
    [
      "devbox_status",
      { name: "missing" },
      ["devbox", "status", "--name", "missing"],
    ],
  ]) {
    const result = (await invoke(name, args)).result;
    a.ok(result.isError);
    a.equal(result.structuredContent.error, refused(f, ...cli).error);
  }
  a.deepEqual(
    (await invoke("build_list")).result.structuredContent.result,
    f.wb("build", "list"),
  );
  a.deepEqual(
    (await invoke("build_run", { target: "dxvk-engine-x64", plan: true }))
      .result.structuredContent.result,
    f.wb("build", "dxvk-engine-x64", "--plan"),
  );
  const unavailable = (
    await invoke("build_run", { target: "electron", background: false })
  ).result;
  a.ok(unavailable.isError);
  a.equal(unavailable.structuredContent.details.backend, "unavailable");
  a.match(unavailable.structuredContent.error, /source closure/);
  a.deepEqual(
    (await invoke("repo_status", { repos: ["winboat"] })).result
      .structuredContent.result,
    f.wb("repo", "status", "--repo", "winboat"),
  );
  a.ok((await invoke("repo_status", { repos: ["missing"] })).result.isError);
  a.ok(
    !(await invoke("repo_sync", { repos: ["winboat"], background: false }))
      .result.isError,
  );
  const p = f.path("winboat");
  write(path.join(p, "source.txt"), "MCP checkpoint\n");
  a.ok(
    !(
      await invoke("repo_checkpoint", {
        repos: ["winboat"],
        paths: ["source.txt"],
        message: "MCP checkpoint",
      })
    ).result.isError,
  );
  a.ok(
    (
      await invoke("repo_fork", {
        repos: ["winboat"],
        namespace: "invalid namespace",
      })
    ).result.isError,
  );
  const fork = path.join(f.base, "mcp-fork/contributor");
  fs.mkdirSync(fork, { recursive: true });
  call(
    [REAL, "clone", "--bare", f.urls.winboat, path.join(fork, "winboat.git")],
    { env: f.env },
  );
  f.g(p, "remote", "add", "upstream", MANIFEST.repositories.winboat.url);
  f.local.workspace.remotes.winboat = path.join(
    f.base,
    "mcp-fork/{namespace}/winboat.git",
  );
  f.writeLocal();
  a.ok(
    !(
      await invoke("repo_fork", {
        repos: ["winboat"],
        namespace: "contributor",
        apply: true,
      })
    ).result.isError,
  );
  a.equal(
    f.g(p, "remote", "get-url", "origin").stdout.trim(),
    path.join(fork, "winboat.git"),
  );
  const job = (await invoke("repo_sync", { repos: ["electron"] })).result
    .structuredContent.result;
  client.child.kill();
  await once(client.child, "close");
  const receipt = await until(
    () => f.wb("job", "status", "--id", job.jobId),
    (r) => ["succeeded", "failed", "interrupted"].includes(r.state),
  );
  a.equal(receipt.state, "succeeded");
  a.ok(fs.existsSync(f.path("electron")));
  const resultBefore = fs.readFileSync(receipt.result),
    journalBefore = fs.readFileSync(
      path.join(f.root, ".state", "jobs", job.jobId + ".json"),
    );
  a.match(
    refused(f, "job", "run", "--id", job.jobId).error,
    /already running or finished/,
  );
  a.deepEqual(fs.readFileSync(receipt.result), resultBefore);
  a.deepEqual(
    fs.readFileSync(path.join(f.root, ".state", "jobs", job.jobId + ".json")),
    journalBefore,
  );
});
check("build plan selective and unavailable backend fails closed", (f) => {
  const before = f.snapshot(f.root),
    result = f.wb("build", "venus-protocol", "--plan");
  a.deepEqual(
    result.sources.map((r) => r.repository),
    ["venus-protocol"],
  );
  a.ok(!fs.existsSync(f.path("electron")));
  a.deepEqual(f.snapshot(f.root), before);
  const r = refused(f, "build", "helios-guest-x64");
  a.equal(r.exitCode, 3);
  a.match(r.error, /Stage 4/);
});
check("MSVC dependencies select host cross without guest work", (f) => {
  const before = f.snapshot(f.root);
  for (const n of [
    "dxvk-engine-x64",
    "dxvk-engine-x86",
    "vkd3d-engine-x64",
    "vkd3d-engine-x86",
    "mesa-guest-x64",
    "mesa-guest-x86",
    "clvk-helios",
  ]) {
    const release = f.wb("build", n, "--plan"),
      development = f.wb("build", n, "--plan", "--mode", "development");
    a.equal(release.contract.backend, "nix");
    a.equal(release.contract.toolchain, "linux-msvc-cross");
    a.ok(release.available && development.available);
    a.ok(!development.dispatch);
  }
  a.deepEqual(f.snapshot(f.root), before);
  const r = refused(
    f,
    "devbox",
    "build",
    "--target",
    "clvk-helios",
    "--dependency-manifest",
    "unexpected.json",
  );
  a.equal(r.exitCode, 2);
  a.match(r.error, /Nix closure/);
  a.ok(!fs.existsSync(path.join(f.root, ".state/windows-builds")));
});
check(
  "source snapshot preserves work and detects dirty or escaping inputs",
  (f) => {
    f.wb("repo", "sync", "--repo", "winboat");
    const p = f.path("winboat"),
      before = f.snapshot(p),
      exported = path.join(f.base, "export clean");
    const record = builds._export(p, exported, "release", f.shas.winboat);
    a.equal(record.revision, f.shas.winboat);
    a.deepEqual(
      fs.readFileSync(path.join(exported, "source.txt")),
      fs.readFileSync(path.join(p, "source.txt")),
    );
    a.deepEqual(f.snapshot(p), before);
    write(path.join(p, "source.txt"), "dirty snapshot");
    write(path.join(p, "new file"), "new");
    a.throws(
      () =>
        builds._export(
          p,
          path.join(f.base, "refused"),
          "release",
          f.shas.winboat,
        ),
      Failure,
    );
    const dirtyBefore = f.snapshot(p),
      dirty = builds._export(
        p,
        path.join(f.base, "development"),
        "development",
        f.shas.winboat,
      );
    a.ok(dirty.diffSha256);
    a.notEqual(dirty.snapshotSha256, record.snapshotSha256);
    a.deepEqual(f.snapshot(p), dirtyBefore);
    fs.symlinkSync("/etc/passwd", path.join(p, "escape"));
    a.throws(
      () => builds._export(p, path.join(f.base, "unsafe"), "development"),
      Failure,
    );
  },
);
check("release snapshot respects Git checkout filters", (f) => {
  const [p] = f.makeSource("filtered-checkout");
  write(path.join(p, ".gitattributes"), "*.csv text eol=crlf\n");
  write(path.join(p, "data.csv"), "name,value\r\nsource,clean\r\n");
  f.g(p, "add", ".gitattributes", "data.csv");
  f.g(p, "commit", "-m", "declare checkout normalization");
  a.equal(f.g(p, "status", "--porcelain").stdout, "");
  const exported = path.join(f.base, "filtered-export"),
    record = builds._export(p, exported, "release", f.head(p));
  a.equal(record.revision, f.head(p));
  a.equal(record.diffSha256, null);
  a.deepEqual(
    fs.readFileSync(path.join(exported, "data.csv")),
    fs.readFileSync(path.join(p, "data.csv")),
  );
});
check(
  "selected shader snapshot excludes unused gitlinks and requires headers",
  (f) => {
    f.wb("repo", "sync", "--repo", "dxil-spirv");
    const p = f.path("dxil-spirv"),
      selected = builds.selected_gitlinks(
        { repos: MANIFEST.repositories },
        "dxil-spirv",
      );
    a.ok(selected.has("subprojects/dxbc-spirv/submodules/spirv_headers"));
    builds._export(
      p,
      path.join(f.base, "selected-shader"),
      "release",
      f.shas["dxil-spirv"],
      selected,
    );
    a.ok(
      fs.existsSync(
        path.join(
          f.base,
          "selected-shader/subprojects/dxbc-spirv/submodules/spirv_headers/file.txt",
        ),
      ),
    );
    f.g(
      p,
      "update-index",
      "--add",
      "--cacheinfo",
      "160000",
      f.head(p),
      "unused-tools",
    );
    f.g(p, "commit", "-m", "declare unused tools");
    const exported = path.join(f.base, "unused-excluded"),
      record = builds._export(p, exported, "release", null, selected);
    a.ok(!fs.existsSync(path.join(exported, "unused-tools")));
    a.equal(
      record.gitlinks.find((i) => i.path === "unused-tools").materialized,
      false,
    );
    fs.unlinkSync(
      path.join(p, "subprojects/dxbc-spirv/submodules/spirv_headers/.git"),
    );
    a.throws(
      () =>
        builds._export(
          p,
          path.join(f.base, "missing-selected"),
          "release",
          null,
          selected,
        ),
      Failure,
    );
  },
);
check(
  "artifact verification rejects tampering extra files and escaping links",
  (f) => {
    const root = path.join(f.base, "artifact"),
      files = path.join(root, "files");
    write(path.join(files, "binary"), "built image");
    fs.symlinkSync(".", path.join(files, "source-overlay"));
    const manifest = path.join(root, "manifest.json");
    write(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        state: "built",
        artifactId: "test",
        files: builds._files(files),
      }),
    );
    a.equal(builds.verify(manifest).filesVerified, 2);
    write(path.join(files, "binary"), "different image");
    a.throws(() => builds.verify(manifest), Failure);
    fs.unlinkSync(path.join(files, "source-overlay"));
    fs.symlinkSync(f.base, path.join(files, "source-overlay"));
    a.throws(() => builds.verify(manifest), Failure);
    write(path.join(files, "binary"), "built image");
    write(path.join(files, "unexpected"), "extra");
    fs.unlinkSync(path.join(files, "source-overlay"));
    fs.symlinkSync(".", path.join(files, "source-overlay"));
    a.throws(() => builds.verify(manifest), Failure);
  },
);
