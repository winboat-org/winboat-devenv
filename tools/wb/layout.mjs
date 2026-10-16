import {
  fs,
  path,
  git,
  hash,
  digest,
  write_json,
  mkdir,
  exists,
  Failure,
  identity,
} from "./common.mjs";
import { Workspace, discover } from "./workspace.mjs";
import { pathToFileURL } from "node:url";

function snapshot(root) {
  return {
    head: git(root, "rev-parse", "HEAD").stdout.trim(),
    refs: git(root, "show-ref", { check: false }).stdout,
    status: git(root, "status", "--porcelain=v1", "--untracked-files=all")
      .stdout,
    staged: hash(git(root, "diff", "--cached", "--binary").stdout),
    unstaged: hash(git(root, "diff", "--binary").stdout),
    untracked: Object.fromEntries(
      git(root, "ls-files", "--others", "--exclude-standard", "-z")
        .stdout.split("\0")
        .filter(Boolean)
        .map((p) => [p, digest(path.join(root, p))]),
    ),
    remotes: git(root, "config", "--get-regexp", "^remote\\.").stdout,
  };
}
export function move_checkout(source, destination, receipt) {
  if (exists(destination))
    throw new Failure(
      "migration destination already exists: " + destination,
      2,
    );
  const children = git(
    source,
    "submodule",
    "foreach",
    "--quiet",
    "--recursive",
    "git rev-parse --show-toplevel",
  )
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const rows = [source, ...children].map((root) => {
    if (
      git(root, "worktree", "list", "--porcelain")
        .stdout.split("\n")
        .filter((l) => l.startsWith("worktree ")).length !== 1
    )
      throw new Failure(
        "migration requires one worktree per component: " + root,
        2,
      );
    return {
      root,
      gitdir: git(root, "rev-parse", "--absolute-git-dir").stdout.trim(),
      before: snapshot(root),
    };
  });
  const oldGitdir = rows[0].gitdir,
    ownGitdir = path.join(source, ".git");
  if (
    oldGitdir !== ownGitdir &&
    (!fs.lstatSync(ownGitdir).isFile() || !fs.statSync(oldGitdir).isDirectory())
  )
    throw new Failure("unsupported absorbed Git directory", 2);
  const state = {
    schemaVersion: 1,
    state: "prepared",
    source,
    destination,
    rows,
    oldGitdir,
    ownGitdir,
    oldGitFile:
      oldGitdir === ownGitdir ? null : fs.readFileSync(ownGitdir, "utf8"),
  };
  write_json(receipt, state);
  if (oldGitdir !== ownGitdir) {
    fs.unlinkSync(ownGitdir);
    try {
      fs.renameSync(oldGitdir, ownGitdir);
    } catch (e) {
      fs.writeFileSync(ownGitdir, state.oldGitFile);
      throw e;
    }
  }
  state.state = "gitdir-adopted";
  write_json(receipt, state);
  mkdir(path.dirname(destination));
  fs.renameSync(source, destination);
  state.state = "moved";
  write_json(receipt, state);
  for (const row of rows) {
    const root = path.join(destination, path.relative(source, row.root));
    const gitdir = path.join(
      destination,
      ".git",
      path.relative(oldGitdir, row.gitdir),
    );
    if (row.root !== source)
      fs.writeFileSync(
        path.join(root, ".git"),
        "gitdir: " + path.relative(root, gitdir) + "\n",
      );
    git(
      destination,
      "--git-dir=" + gitdir,
      "--work-tree=" + root,
      "config",
      "core.worktree",
      path.relative(gitdir, root),
    );
    row.destination = root;
    row.newGitdir = gitdir;
  }
  state.state = "configured";
  write_json(receipt, state);
  for (const row of rows) {
    row.after = snapshot(row.destination);
    if (JSON.stringify(row.before) !== JSON.stringify(row.after))
      throw new Failure(
        "migration preservation check differs; retain receipt and checkout",
        74,
        { receipt },
      );
  }
  state.state = "verified";
  write_json(receipt, state);
  return state;
}
export function recover_checkout(receipt) {
  const state = JSON.parse(fs.readFileSync(receipt, "utf8"));
  if (state.schemaVersion !== 1 || !Array.isArray(state.rows))
    throw new Failure("invalid layout recovery receipt", 2);
  if (exists(state.destination)) {
    if (exists(state.source)) throw new Failure("both recovery paths exist", 2);
    mkdir(path.dirname(state.source));
    fs.renameSync(state.destination, state.source);
  }
  if (
    state.oldGitdir !== state.ownGitdir &&
    fs.statSync(state.ownGitdir).isDirectory()
  ) {
    if (exists(state.oldGitdir))
      throw new Failure("original Git directory already exists", 2);
    mkdir(path.dirname(state.oldGitdir));
    fs.renameSync(state.ownGitdir, state.oldGitdir);
    fs.writeFileSync(state.ownGitdir, state.oldGitFile);
  }
  for (const row of state.rows) {
    if (row.root !== state.source)
      fs.writeFileSync(
        path.join(row.root, ".git"),
        "gitdir: " + path.relative(row.root, row.gitdir) + "\n",
      );
    git(
      row.root,
      "--git-dir=" + row.gitdir,
      "--work-tree=" + row.root,
      "config",
      "core.worktree",
      path.relative(row.gitdir, row.root),
    );
  }
  state.state = "recovered";
  write_json(receipt, state);
  return state;
}
const previous = {
  "qemu-helios": "helios/qemu-helios",
  dxvk: "helios/dxvk-helios",
  virglrenderer: "helios/virglrenderer",
  "mesa-helios": "helios/icd/mesa",
  "vkd3d-proton": "helios/vkd3d-proton-helios",
  "venus-protocol": "helios/venus-protocol",
};
export function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--recover" && argv.length === 2) {
    const ws = new Workspace(discover());
    const receipt = fs.realpathSync(argv[1]);
    if (
      !receipt.startsWith(
        fs.realpathSync(path.join(ws.state, "layout-migrations")) + path.sep,
      )
    )
      throw new Failure(
        "recovery receipt is outside workspace layout history",
        2,
      );
    console.log(JSON.stringify(recover_checkout(receipt)));
    return;
  }
  if (argv.some((x) => !["--apply", "--plan"].includes(x)))
    throw new Failure("usage: wb-migrate-layout [--plan|--apply]", 2);
  const ws = new Workspace(discover());
  if (ws.manifest.layoutVersion !== 2)
    throw new Failure("layout migration requires manifest version 2", 2);
  const moves = Object.entries(previous)
    .map(([name, p]) => ({
      name,
      source: path.join(ws.repo_root, p),
      destination: ws.paths[name],
    }))
    .filter((r) => exists(path.join(r.source, ".git")));
  for (const r of moves)
    if (exists(r.destination))
      throw new Failure("both old and new checkout paths exist: " + r.name, 2);
  const directory = path.join(ws.state, "layout-migrations", identity());
  mkdir(directory);
  const plan = {
    schemaVersion: 1,
    from: 1,
    to: 2,
    moves,
    directory,
    state: argv.includes("--apply") ? "applying" : "planned",
  };
  write_json(path.join(directory, "plan.json"), plan);
  if (argv.includes("--apply")) {
    for (const r of moves)
      move_checkout(
        r.source,
        r.destination,
        path.join(directory, r.name + ".json"),
      );
    plan.state = "verified";
    write_json(path.join(directory, "plan.json"), plan);
  }
  console.log(JSON.stringify(plan));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
