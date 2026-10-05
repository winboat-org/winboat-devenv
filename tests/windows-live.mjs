// Opt-in acceptance in one explicitly named, already running development guest.
import assert from "node:assert/strict";
import * as windows from "../tools/wb/windows.mjs";
import { Workspace } from "../tools/wb/workspace.mjs";
import {
  fs,
  path,
  env,
  uuid,
  identity,
  write_json,
  readJSON,
  mkdir,
  digest,
  hash,
  sleep,
} from "../tools/wb/common.mjs";
import { arguments_, command, Client, output } from "./live-common.mjs";
class Acceptance {
  constructor(args) {
    this.args = args;
    this.root = env.WB_WORKSPACE_ROOT;
    this.ws = new Workspace(this.root, { stateRoot: args.state_root });
    this.client = new Client(this.root, this.ws.state, env.WB_LIVE_COMMAND);
    this.directory = path.join(this.ws.state, "windows-acceptance", uuid());
    mkdir(this.directory);
    this.results = [];
    this.stackResults = [];
  }
  record(label, receipt) {
    this.results.push({ label, observed: Date.now() / 1000, receipt });
    write_json(path.join(this.directory, "receipts.json"), this.results);
    return receipt;
  }
  async cli(label, ...args) {
    const proc = await command([...this.client.prefix, "--json", ...args]);
    assert.ok(proc.stdout, proc.stderr);
    return this.record(label, JSON.parse(proc.stdout));
  }
  async tool(name, arguments_) {
    const response = await this.client.rpc("tools/call", {
      name,
      arguments: arguments_,
    });
    assert.ok(!response.error, JSON.stringify(response));
    return this.record(name, response.result.structuredContent);
  }
  async wait(id, expected = 0, viaMcp = false) {
    const deadline = Date.now() + Math.max(180, this.args.seconds + 120) * 1000;
    while (Date.now() < deadline) {
      const response = viaMcp
        ? await this.tool("devbox_job_status", { name: this.args.name, id })
        : await this.cli(
            "guest-status",
            "devbox",
            "job",
            "status",
            "--name",
            this.args.name,
            "--id",
            id,
          );
      const value = response.result;
      assert.ok(value, JSON.stringify(response));
      if (!["queued", "running"].includes(value.state)) {
        assert.equal(value.exitCode, expected, JSON.stringify(response));
        return value;
      }
      await sleep(5000);
    }
    throw new Error("Guest task did not reach a terminal receipt");
  }
  async hostOperation(submitted, viaMcp = false, allowed = [0]) {
    assert.equal(submitted.exitCode, 0, JSON.stringify(submitted));
    const id = submitted.result.jobId;
    for (;;) {
      const response = viaMcp
          ? await this.tool("job_status", { id })
          : await this.cli("host-job-status", "job", "status", "--id", id),
        job = response.result;
      assert.equal(job?.jobId, id, JSON.stringify(response));
      if (!["queued", "running"].includes(job.state)) {
        assert.ok(["succeeded", "failed"].includes(job.state));
        assert.ok(
          job.operation && allowed.includes(job.operation.exitCode),
          JSON.stringify(job),
        );
        return job.operation;
      }
      assert.equal(response.exitCode, 0);
      await sleep(20000);
    }
  }
  async reconnect(transaction, viaMcp, attempts = 60) {
    for (let i = 0; i < attempts; i++) {
      const status = viaMcp
        ? await this.tool("devbox_job_status", {
            name: this.args.name,
            id: transaction,
          })
        : await this.cli(
            "stack-reconnect",
            "devbox",
            "job",
            "status",
            "--name",
            this.args.name,
            "--id",
            transaction,
          );
      if (status.result?.operationId === transaction) return;
      await sleep(5000);
    }
    throw new Error("Authenticated guest reconnect failed after reboot");
  }
  async fullStack() {
    let previousSources;
    for (const viaMcp of [false, true]) {
      const surface = viaMcp ? "mcp" : "cli";
      const execute = async (label, tool, arguments_, cli, allowed = [0]) =>
        this.hostOperation(
          viaMcp
            ? await this.tool(tool, { ...arguments_, background: true })
            : await this.cli(surface + "-" + label, ...cli, "--background"),
          viaMcp,
          allowed,
        );
      const built = await execute(
        "stack-build",
        "devbox_build",
        {
          name: this.args.name,
          target: "helios-development-package",
          mode: "release",
        },
        [
          "devbox",
          "build",
          "--name",
          this.args.name,
          "--target",
          "helios-development-package",
          "--mode",
          "release",
        ],
      );
      const artifactPath = built.result.manifest,
        artifact = readJSON(artifactPath);
      assert.equal(artifact.mode, "release");
      const clean = (record) => {
        for (const source of Object.values(record.sources))
          assert.ok(!source.diffSha256 && !source.untracked?.length);
        for (const d of record.componentDependencies || []) clean(d);
      };
      clean(artifact);
      const verified = viaMcp
        ? await this.tool("build_verify", { manifest: artifactPath })
        : await this.cli(
            "cli-stack-export-verify",
            "build",
            "verify",
            "--manifest",
            artifactPath,
          );
      assert.equal(verified.exitCode, 0);
      const manifestPath = path.join(
          path.dirname(artifactPath),
          "files/bundle/manifest.json",
        ),
        manifest = readJSON(manifestPath);
      assert.equal(manifest.symbolStorage, "component-artifacts");
      assert.ok(
        !manifest.files.some((f) => f.path.toLowerCase().endsWith(".pdb")),
      );
      const compiler = artifact.componentDependencies.find(
          (d) => d.target === "clvk-helios",
        ),
        policy = readJSON(
          path.join(
            path.dirname(path.dirname(artifactPath)),
            compiler.artifactId,
            "files/package/llvm-symbol-policy.json",
          ),
        );
      assert.equal(policy.debugSymbols, false);
      assert.equal(policy.pdbFiles, 0);
      assert.ok(policy.compilerCommandsChecked > 0);
      this.record(surface + "-symbol-policy", {
        runtimeBundlePdbFiles: 0,
        compiler: policy,
        componentManifestSha256: compiler.manifestSha256,
      });
      if (previousSources) assert.deepEqual(manifest.source, previousSources);
      previousSources = manifest.source;
      const manifestHash = digest(manifestPath),
        codes = [0, 3010, 1641];
      let installed = await execute(
        "stack-install",
        "devbox_install",
        { name: this.args.name, manifest: manifestPath },
        [
          "devbox",
          "install",
          "--name",
          this.args.name,
          "--manifest",
          manifestPath,
        ],
        codes,
      );
      const transaction = installed.result.operationId;
      for (let i = 0; i < 3 && installed.exitCode !== 0; i++) {
        const boot = installed.result.bootTime;
        await execute(
          "stack-restart",
          "devbox_restart",
          { name: this.args.name, timeout: 180 },
          ["devbox", "restart", "--name", this.args.name, "--timeout", "180"],
        );
        await this.reconnect(transaction, viaMcp);
        installed = await execute(
          "stack-resume",
          "devbox_install",
          { name: this.args.name, resume: transaction },
          [
            "devbox",
            "install",
            "--name",
            this.args.name,
            "--resume",
            transaction,
          ],
          codes,
        );
        assert.notEqual(installed.result.bootTime, boot);
      }
      assert.equal(installed.exitCode, 0);
      await execute(
        "stack-activation-restart",
        "devbox_restart",
        { name: this.args.name, timeout: 180 },
        ["devbox", "restart", "--name", this.args.name, "--timeout", "180"],
      );
      await this.reconnect(transaction, viaMcp);
      const graphics = (
        await execute(
          "stack-smoke",
          "devbox_smoke",
          { name: this.args.name, transaction },
          [
            "devbox",
            "smoke",
            "--name",
            this.args.name,
            "--transaction",
            transaction,
          ],
        )
      ).result;
      assert.equal(graphics.state, "passed");
      assert.ok(graphics.sessionId > 0);
      assert.equal(graphics.manifestSha256, manifestHash);
      assert.equal(graphics.mappedImages.length, 12);
      assert.equal(graphics.workloads.length, 13);
      const observed = (
        await execute(
          "stack-registry",
          "devbox_registry_verify",
          { name: this.args.name },
          ["devbox", "registry", "verify", "--name", this.args.name],
        )
      ).result;
      assert.ok(observed.installedVerified && observed.loadedVerified);
      assert.equal(observed.loadedKernelIdentity, "mapped-code-matches");
      assert.equal(observed.packageProvenance.manifestSha256, manifestHash);
      const receipt = {
        surface,
        artifactManifest: artifactPath,
        manifestSha256: manifestHash,
        transactionId: transaction,
        registryOperationId: observed.operationId,
        bootTime: observed.bootTime,
        componentBuildsReused: false,
        installedVerified: true,
        loadedVerified: true,
      };
      this.stackResults.push(receipt);
      this.record(surface + "-full-stack-passed", receipt);
    }
  }
  async run() {
    if (this.args.component_only) {
      await this.extras();
      return this.finish();
    }
    const fixture = path.join(this.root, "tests/WindowsControlFixture.ps1"),
      value =
        "literal ' quotes \" & $dollar" +
        String.fromCharCode(96) +
        "n\nsecond line";
    const started = await this.cli(
      "durable-start",
      "devbox",
      "run",
      "--name",
      this.args.name,
      "--purpose",
      "build",
      "--script",
      fixture,
      "--argument=-Seconds",
      "--argument=" + this.args.seconds,
      "--argument=-Value",
      "--argument=" + value,
    );
    assert.equal(started.exitCode, 0);
    const identifier = started.operationId;
    const refused = await this.cli(
      "session-zero-refusal",
      "devbox",
      "run",
      "--name",
      this.args.name,
      "--purpose",
      "desktop",
      "--direct",
      "--script",
      fixture,
    );
    assert.equal(refused.exitCode, 87);
    assert.equal(refused.result.sessionId, 0);
    const desktop = await this.tool("devbox_run", {
      name: this.args.name,
      purpose: "desktop",
      script: fixture,
      arguments: ["-Seconds", "1", "-Value", value],
    });
    assert.equal(desktop.exitCode, 0);
    const observed = await this.wait(desktop.operationId, 0, true);
    assert.ok(observed.sessionId > 0 && observed.principal.endsWith("\\wbdev"));
    for (const code of [42, 3010]) {
      const submitted = await this.tool("devbox_run", {
        name: this.args.name,
        purpose: "system",
        script: fixture,
        arguments: [
          "-Seconds",
          "1",
          "-ExitCode",
          String(code),
          "-Value",
          value,
        ],
      });
      assert.equal(submitted.exitCode, 0);
      const result = await this.wait(submitted.operationId, code, true);
      assert.equal(result.state, code === 3010 ? "reboot-required" : "failed");
      assert.equal(
        JSON.parse(result.logs["stdout.log"].trim().split("\n").at(-1))
          .argument,
        value,
      );
    }
    await this.largeRequest();
    const cancelled = await this.cli(
      "cancel-start",
      "devbox",
      "run",
      "--name",
      this.args.name,
      "--purpose",
      "build",
      "--script",
      fixture,
      "--argument=-Seconds",
      "--argument=15",
    );
    assert.equal(cancelled.exitCode, 0);
    const cancellation = await this.tool("devbox_job_cancel", {
      name: this.args.name,
      id: cancelled.operationId,
    });
    assert.equal(cancellation.exitCode, 130);
    const resumed = await this.tool("devbox_job_resume", {
      name: this.args.name,
      id: cancelled.operationId,
    });
    assert.equal(resumed.exitCode, 0);
    await this.wait(cancelled.operationId, 0, true);
    const tamper = path.join(this.directory, "tamper-input.ps1");
    fs.writeFileSync(
      tamper,
      "Add-Content -LiteralPath 'C:\\ProgramData\\WinBoatDev\\jobs\\" +
        cancelled.operationId +
        "\\payload.ps1' -Value '# modified input'\n",
    );
    const staged = await this.tool("devbox_run", {
      name: this.args.name,
      purpose: "system",
      script: tamper,
    });
    assert.equal(staged.exitCode, 0);
    await this.wait(staged.operationId, 0, true);
    const rejected = await this.tool("devbox_job_resume", {
      name: this.args.name,
      id: cancelled.operationId,
    });
    assert.notEqual(rejected.exitCode, 0);
    assert.match(rejected.error, /Verified file changed/);
    await this.installFixture();
    const final = await this.wait(identifier),
      lines = final.logs["stdout.log"].trim().split("\n");
    assert.equal(final.principal, "NT AUTHORITY\\SYSTEM");
    assert.equal(final.sessionId, 0);
    assert.equal(
      lines.filter((l) => l.startsWith("tick=")).length,
      this.args.seconds,
    );
    const result = JSON.parse(lines.at(-1));
    assert.equal(result.argument, value);
    assert.ok(result.cargoTarget.startsWith("C:\\WinBoatDev\\build\\"));
    await this.extras();
    this.finish();
  }
  async extras() {
    if (this.args.large_request) await this.largeRequest();
    if (this.args.input_fixtures) await this.inputFixtures();
    if (this.args.native) await this.nativeFixture();
    for (const target of this.args.build_target || []) {
      const built = await this.tool("devbox_build", {
        name: this.args.name,
        target,
        background: false,
      });
      assert.equal(built.exitCode, 0);
      assert.equal(built.result.state, "succeeded");
      const verified = await this.tool("build_verify", {
        manifest: built.result.manifest,
      });
      assert.equal(verified.exitCode, 0);
      assert.equal(verified.result.loaded, false);
    }
    if (this.args.reboot) await this.rebootFixture();
    if (this.args.full_stack) await this.fullStack();
  }
  async largeRequest() {
    const value = (
      "literal ' quotes \" & $dollar" +
      String.fromCharCode(96) +
      "n\nsecond line "
    ).repeat(600);
    const submitted = await this.tool("devbox_run", {
      name: this.args.name,
      purpose: "system",
      script: path.join(this.root, "tests/WindowsControlFixture.ps1"),
      arguments: ["-Seconds", "0", "-ExitCode", "42", "-Value", value],
    });
    assert.equal(submitted.exitCode, 0);
    const observed = await this.wait(submitted.operationId, 42, true);
    assert.equal(observed.sessionId, 0);
    assert.equal(observed.principal, "NT AUTHORITY\\SYSTEM");
    assert.equal(
      JSON.parse(observed.logs["stdout.log"].trim().split("\n").at(-1))
        .argument,
      value,
    );
    const requestBytes = fs.statSync(
      path.join(
        this.ws.state,
        "devboxes",
        this.args.name,
        "windows-jobs",
        submitted.operationId,
        "request.json",
      ),
    ).size;
    assert.ok(requestBytes > 20000);
    this.record("large-request-passed", {
      operationId: submitted.operationId,
      requestBytes,
      argumentSha256: hash(value),
      exitCode: observed.exitCode,
      principal: observed.principal,
      sessionId: observed.sessionId,
    });
  }
  finish() {
    const summary = {
      schemaVersion: 1,
      state: "passed",
      durationSeconds: this.args.seconds,
      eightMinuteDurability:
        !this.args.component_only && this.args.seconds >= 480,
      receipts: path.join(this.directory, "receipts.json"),
      fullComponentAcceptance: this.stackResults.length === 2,
      stackRepeats: this.stackResults,
    };
    write_json(path.join(this.directory, "summary.json"), summary);
    output(summary);
  }
  async inputFixtures() {
    for (const [script, resultName, inputs] of [
      ["WindowsTreeFixture.ps1", "tree-fixture.json", {}],
      ["WindowsPriorInventoryFixture.ps1", "prior-inventory-fixture.json", {}],
      [
        "WindowsSnapshotFixture.ps1",
        "snapshot-fixture-result.json",
        { "Snapshot.ps1": path.join(env.WB_DEVBOX_PAYLOADS, "Snapshot.ps1") },
      ],
    ]) {
      const id = identity();
      this.record(
        script,
        await windows.submit(
          this.ws,
          this.args.name,
          id,
          path.join(this.root, "tests", script),
          "system",
          [],
          false,
          { kind: "input-fixture" },
          inputs,
        ),
      );
      const observed = await this.wait(id);
      assert.equal(observed.principal, "NT AUTHORITY\\SYSTEM");
      assert.equal(observed.sessionId, 0);
      const p = path.join(this.directory, resultName);
      windows.download(
        this.ws,
        this.args.name,
        windows.ROOT + "\\jobs\\" + id + "\\" + resultName,
        p,
      );
      const result = readJSON(p);
      assert.equal(result.state, "passed");
      this.record("verified-" + resultName, result);
    }
  }
  async nativeFixture() {
    const built = await this.cli(
      "native-build",
      "devbox",
      "run",
      "--name",
      this.args.name,
      "--purpose",
      "build",
      "--script",
      path.join(this.root, "tests/WindowsBuildFixture.ps1"),
    );
    assert.equal(built.exitCode, 0);
    const id = built.operationId,
      observed = await this.wait(id);
    assert.match(observed.logs["stdout.log"], /Arch: x86_64/);
    assert.match(observed.logs["stdout.log"], /Arch: i386/);
    const metadata = path.join(this.directory, "fixture-build.json");
    windows.download(
      this.ws,
      this.args.name,
      windows.ROOT + "\\jobs\\" + id + "\\fixture-build.json",
      metadata,
    );
    const result = readJSON(metadata),
      boundary = "C:\\WinBoatDev\\build\\" + id + "\\",
      files = [];
    for (const file of result.files) {
      assert.ok(file.path.startsWith(boundary));
      const relative = windows.windows_relative(
        file.path.slice(boundary.length),
      );
      files.push(
        windows.download(
          this.ws,
          this.args.name,
          file.path,
          path.join(this.directory, "native", relative),
          { sha256: file.sha256, size: file.size },
        ),
      );
    }
    this.record("verified-native-return", {
      schemaVersion: 1,
      state: "verified",
      files,
    });
    const submitted = await this.tool("devbox_run", {
      name: this.args.name,
      purpose: "system",
      script: path.join(this.root, "tests/WindowsLoadedFixture.ps1"),
      arguments: [id],
    });
    assert.equal(submitted.exitCode, 0);
    await this.wait(submitted.operationId, 0, true);
    windows.download(
      this.ws,
      this.args.name,
      windows.ROOT +
        "\\jobs\\" +
        submitted.operationId +
        "\\loaded-fixture.json",
      path.join(this.directory, "loaded-fixture.json"),
    );
  }
  bundle(name, reboot = false) {
    const bundle = path.join(this.directory, name);
    mkdir(bundle);
    const data = Buffer.from(
      "WinBoat transaction fixture: not a graphics DLL\n",
    );
    fs.writeFileSync(path.join(bundle, "fixture.dll"), data);
    const manifest = {
        schemaVersion: 1,
        fixtureId: name + "-" + path.basename(this.directory).slice(0, 16),
        ...(reboot ? { rebootRequired: true } : {}),
        files: [{ path: "fixture.dll", sha256: hash(data), size: data.length }],
      },
      p = path.join(bundle, "manifest.json");
    write_json(p, manifest);
    return [bundle, p, manifest];
  }
  async rebootFixture() {
    const [, p] = this.bundle("reboot-bundle", true),
      pending = await this.tool("devbox_install", {
        name: this.args.name,
        manifest: p,
        fixture: true,
        background: false,
      });
    assert.equal(pending.exitCode, 3010);
    assert.equal(pending.result.state, "reboot-required");
    const id = pending.result.transactionId,
      boot = pending.result.bootTime;
    const restarted = await this.cli(
      "required-restart",
      "devbox",
      "restart",
      "--name",
      this.args.name,
      "--timeout",
      "180",
    );
    assert.equal(restarted.exitCode, 0);
    await this.reconnect(id, false, 36);
    const resumed = await this.tool("devbox_install", {
      name: this.args.name,
      resume: id,
      background: false,
    });
    assert.equal(resumed.exitCode, 0);
    assert.notEqual(resumed.result.bootTime, boot);
    const rollback = await this.tool("devbox_install", {
      name: this.args.name,
      rollback: id,
      background: false,
    });
    assert.equal(rollback.exitCode, 0);
  }
  async installFixture() {
    const [bundle, p, manifest] = this.bundle("acceptance"),
      failed = await this.cli(
        "injected-install-failure",
        "devbox",
        "install",
        "--name",
        this.args.name,
        "--manifest",
        p,
        "--fixture",
        "--failure-after-copy",
      );
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.details.observation.state, "failed");
    const id = failed.details.jobId;
    const resumed = await this.tool("devbox_install", {
      name: this.args.name,
      resume: id,
      background: false,
    });
    assert.equal(resumed.exitCode, 0);
    const registry = await this.tool("devbox_registry_reconcile", {
      name: this.args.name,
      background: false,
    });
    assert.equal(registry.exitCode, 0);
    let relevant = registry.result.entries.filter((e) =>
      e.path.includes(manifest.fixtureId),
    );
    assert.equal(relevant.length, 2);
    assert.ok(relevant.every((e) => e.installed === "verified"));
    const mutation = path.join(bundle, "mutate.ps1");
    fs.writeFileSync(
      mutation,
      "[IO.File]::AppendAllText('C:\\WinBoatDev\\fixtures\\" +
        manifest.fixtureId +
        "\\fixture.dll','manual drift')\nSet-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\WinBoatDev\\Fixtures\\" +
        manifest.fixtureId +
        "' -Name Path -Value 'C:\\manual.dll'\n",
    );
    const submitted = await this.tool("devbox_run", {
      name: this.args.name,
      purpose: "system",
      script: mutation,
    });
    assert.equal(submitted.exitCode, 0);
    await this.wait(submitted.operationId, 0, true);
    const drift = await this.tool("devbox_registry_reconcile", {
      name: this.args.name,
      background: false,
    });
    assert.equal(drift.exitCode, 0);
    assert.equal(drift.result.state, "drift");
    relevant = drift.result.entries.filter((e) =>
      e.path.includes(manifest.fixtureId),
    );
    assert.equal(relevant.length, 2);
    assert.ok(relevant.every((e) => e.installed === "drift"));
    const rollback = await this.tool("devbox_install", {
      name: this.args.name,
      rollback: id,
      background: false,
    });
    assert.equal(rollback.exitCode, 0);
  }
}
const args = arguments_({
  seconds: { type: "string", default: "12" },
  native: { type: "boolean" },
  "build-target": { type: "string", multiple: true },
  reboot: { type: "boolean" },
  "component-only": { type: "boolean" },
  "large-request": { type: "boolean" },
  "input-fixtures": { type: "boolean" },
  "full-stack": { type: "boolean" },
});
args.seconds = Number(args.seconds);
assert.ok(
  Number.isInteger(args.seconds) && args.seconds >= 1 && args.seconds <= 600,
  "seconds must be between 1 and 600",
);
const acceptance = new Acceptance(args);
try {
  await acceptance.run();
} finally {
  await acceptance.client.close();
}
