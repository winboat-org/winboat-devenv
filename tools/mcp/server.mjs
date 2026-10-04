import { spawn } from 'node:child_process';
import readline from 'node:readline';

// This file only validates protocol arguments and proxies the Nix wb command.
// Repository, build and installation behavior belongs to shared operations.
const string = { type: 'string', minLength: 1 };
const bool = { type: 'boolean' };
const strings = { type: 'array', items: string, minItems: 1 };
const selection = { subset: { type: 'string', enum: ['all', 'helios', 'winboat', 'winboat-accel'] },
  repos: { type: 'array', items: string, minItems: 1 } };
const definitions = [
  ['workspace_status', 'Inspect the workspace and activation prerequisites.', ['doctor'], selection],
  ['workspace_setup', 'Prepare local state; activation is an explicit option.', ['setup'],
    { activation: { type: 'string', enum: ['bash', 'zsh', 'fish', 'nu'] }, shellConfig: string }],
  ...['list', 'status', 'plan'].map(action => [`repo_${action}`, `Repository ${action}.`, ['repo', action], selection]),
  ['repo_verify', 'Verify pinned source objects and development refs.', ['repo', 'verify'], { ...selection, background: bool }],
  ['repo_sync', 'Sync exact source pins; defaults to a durable background job.', ['repo', 'sync'], { ...selection, background: bool }],
  ['repo_checkpoint', 'Commit explicit file paths in selected repositories.', ['repo', 'checkpoint'],
    { ...selection, paths: { type: 'array', items: string, minItems: 1 }, message: string }, ['paths', 'message']],
  ['repo_pin', 'Verify and checkpoint an explicit immutable source pin.', ['repo', 'pin'],
    { ...selection, revision: { type: 'string', pattern: '^[0-9a-f]{40}$' }, ref: string, sourceUrl: string, deferCheckpoint: bool }, ['repos', 'revision']],
  ['repo_push', 'Publish in dependency order and record verified pins.', ['repo', 'push'],
    { ...selection, remote: string, source: string, forceWithLease: bool, dryRun: bool, deferCheckpoint: bool, background: bool }],
  ['repo_fork', 'Validate fork remotes; apply must be explicit.', ['repo', 'fork'],
    { ...selection, namespace: string, apply: bool }, ['namespace']],
  ['repo_branch', 'Create a development branch in one selected checkout.', ['repo', 'branch'], { repos: selection.repos, name: string }, ['repos']],
  ['repo_reconcile', 'Complete a verified push receipt without repeating the push.', ['repo', 'reconcile'], { operation: string }, ['operation']],
  ...['status', 'cancel', 'resume'].map(action => [`job_${action}`, `Durable job ${action}.`, ['job', action], { id: string }, ['id']]),
  ['build_list', 'List Nix-declared native, cross and devbox targets.', ['build', 'list'], {}],
  ['build_run', 'Build an exact source closure; defaults to a durable job.', ['build'],
    { target: string, name: string, configuration: { type: 'string', enum: ['release', 'debug'] },
      mode: { type: 'string', enum: ['release', 'development'] }, plan: bool, background: bool }, ['target']],
  ['build_verify', 'Verify the complete exported artifact file set and hashes.', ['build', 'verify'], { manifest: string }, ['manifest']],
  ['devbox_capabilities', 'Inspect KVM, render nodes, displays and usable container runtimes.', ['devbox', 'capabilities'], {}],
  ['devbox_run', 'Hash-verify a PowerShell script and start a durable guest task. Build/install/system run as SYSTEM; desktop requires the interactive wbdev session and refuses session 0. Returned queued/running is not completion.', ['devbox', 'run'],
    { name: string, purpose: { type: 'string', enum: ['build', 'install', 'desktop', 'system'] }, script: string,
      arguments: { type: 'array', items: { type: 'string' } }, direct: bool }, ['purpose', 'script']],
  ['devbox_mirror', 'Export selected pinned Git sources, transfer hash/size-verified inputs, and verify every file in a unique local C: mirror. Builds never execute on the share.', ['devbox', 'mirror'],
    { name: string, repos: selection.repos, mode: { type: 'string', enum: ['release', 'development'] }, background: bool }, ['repos']],
  ...['show', 'verify', 'reconcile'].map(action =>
    [`devbox_registry_${action}`, 'Observe actual PnP/DriverStore, both registry views, DLL hashes, certificates, provisioning and mapped process code. Unknown loaded kernel identity remains unknown.', ['devbox', 'registry', action], { name: string, background: bool }]),
  ['devbox_install', 'Install an exact verified package as a durable SYSTEM transaction preserving prior state. Resume uses its original ID and manifest. Installer success alone does not verify loaded identities.', ['devbox', 'install'],
    { name: string, manifest: string, resume: string, rollback: string, fixture: bool, failureAfterCopy: bool, background: bool }],
  ['devbox_build', 'Build the Nix component recipe on the host when cross compilation is supported; otherwise use a verified guest mirror. Also collect a completed guest build after a host/client interruption.', ['devbox', 'build'],
    { name: string, target: string, collect: string, dependencyManifests: strings, configuration: {type:'string',enum:['release','debug']}, mode: {type:'string',enum:['release','development']}, background: bool }],
  ['devbox_smoke', 'Run native and WoW64 graphics workloads as the interactive desktop user and compare actual mapped DLL code with an exact installation transaction.', ['devbox', 'smoke'],
    { name: string, transaction: string, background: bool }],
  ['devbox_migrate_host', 'Prepare an explicit clean QEMU-only host upgrade for a stopped, verified devbox. Preserve its previous artifact/image; loaded host and Windows graphics verification remain required.', ['devbox', 'migrate-host'],
    { name: string, manifest: string, background: bool }, ['manifest']],
  ...['status', 'cancel', 'resume'].map(action =>
    [`devbox_job_${action}`, `Observe or recover the exact durable Windows task; status retains native exit/reboot codes and bounded logs.`, ['devbox', 'job', action], { name: string, id: string }, ['id']]),
  ['devbox_cdi_prepare', 'Generate and validate private NVIDIA CDI using the Nix-pinned vendor toolkit for rootless Podman; never writes system configuration.', ['devbox', 'cdi', 'prepare'], { renderNode: string }],
  ['devbox_media', 'Hash and inspect user-supplied Windows ISO image metadata.', ['devbox', 'media'],
    { iso: string, isoSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, index: { type: 'integer', minimum: 1 }, edition: string, locale: string }, ['iso']],
  ['devbox_create', 'Prepare an isolated devbox; start is explicit and execution uses shared Nix operations.', ['devbox', 'create'],
    { name: string, iso: string, isoSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, manifest: string,
      diskGiB: { type: 'integer', minimum: 64, maximum: 2048 },
      runtime: { type: 'string', enum: ['docker', 'podman'] },
      renderNode: string, graphicsProvider: { type: 'string', enum: ['auto', 'mesa', 'nvidia-cdi'] }, cdiDevice: string,
      index: { type: 'integer', minimum: 1 }, edition: string, locale: string, start: bool, background: bool }],
  ...['up', 'down', 'restart', 'status', 'logs', 'guest-status'].map(action =>
    [`devbox_${action.replace('-', '_')}`, `Devbox ${action}.`, ['devbox', action],
      { name: string, ...(action === 'up' ? { rebuildImage: bool } : {}), ...(action === 'down' ? { force: bool } : {}),
        ...(['down', 'restart'].includes(action) ? { timeout: { type: 'integer', minimum: 10, maximum: 600 } } : {}),
        ...(['up', 'down', 'restart', 'guest-status'].includes(action) ? { background: bool } : {}) }]),
  ['devbox_destroy', 'Permanently delete a stopped owned devbox after identity confirmation.', ['devbox', 'destroy'],
    { name: string, confirm: { type: 'string', pattern: '^[0-9a-f]{32}$' } }, ['confirm']],
  ...['open', 'close', 'status'].map(action =>
    [`devbox_viewer_${action}`, `Independent VNC viewer ${action}; VM lifecycle is separate.`, ['devbox', 'viewer', action], { name: string }]),
];
const catalog = definitions.map(([name, description, command, properties, required = []]) => ({ name, description, command,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: ['workspace_status', 'repo_list', 'repo_status', 'repo_plan', 'job_status', 'build_list', 'build_verify',
    'devbox_status', 'devbox_logs', 'devbox_viewer_status'].includes(name) },
  outputSchema: { type: 'object', properties: { schemaVersion: { type: 'integer' }, operationId: string,
    state: string, exitCode: { type: 'integer' } }, required: ['schemaVersion', 'operationId', 'state', 'exitCode'], additionalProperties: true } }));

function validate(value, schema, path = 'arguments') {
  if (schema.type === 'object') {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${path} must be an object`);
    for (const required of schema.required ?? []) if (!(required in value)) throw new Error(`${path}.${required} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (!schema.properties[key]) throw new Error(`unknown ${path}.${key}`);
      validate(item, schema.properties[key], `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0)) throw new Error(`${path} must be a nonempty array`);
    for (const item of value) validate(item, schema.items, path);
  } else {
    if (schema.type === 'integer') {
      if (!Number.isInteger(value) || value < schema.minimum || value > (schema.maximum ?? Infinity)) throw new Error(`${path} is outside its integer range`);
    } else if (typeof value !== schema.type) throw new Error(`${path} must be ${schema.type}`);
    if (schema.type === 'string' && (value.length < (schema.minLength ?? 0) || value.includes('\0'))) throw new Error(`${path} is invalid`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} has an unsupported value`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} has an invalid format`);
  }
}

function command(tool, args) {
  const argv = [...tool.command];
  const flags = { subset: '--subset', activation: '--activation', shellConfig: '--shell-config', message: '--message',
    revision: '--rev', ref: '--ref', sourceUrl: '--source-url', remote: '--remote', source: '--source',
    namespace: '--namespace', name: '--name', operation: '--operation', id: '--id',
    forceWithLease: '--force-with-lease', dryRun: '--dry-run', deferCheckpoint: '--defer-checkpoint', apply: '--apply',
    configuration: '--configuration', mode: '--mode', plan: '--plan', manifest: '--manifest',
    iso: '--iso', isoSha256: '--iso-sha256', index: '--index', edition: '--edition', locale: '--locale',
    start: '--start', confirm: '--confirm', rebuildImage: '--rebuild-image', force: '--force', runtime: '--runtime', timeout: '--timeout',
    renderNode: '--render-node', graphicsProvider: '--graphics-provider', cdiDevice: '--cdi-device', diskGiB: '--disk-gib' };
  Object.assign(flags, { purpose: '--purpose', script: '--script', direct: '--direct', resume: '--resume', rollback: '--rollback', collect: '--collect', fixture: '--fixture', failureAfterCopy: '--failure-after-copy', transaction: '--transaction' });
  for (const [key, value] of Object.entries(args)) {
    if (key === 'background') continue;
    if (key === 'target') { if(tool.name==='devbox_build') argv.push('--target',value); else argv.splice(1, 0, value); continue; }
    if (key === 'arguments') { for (const item of value) argv.push('--argument=' + item); continue; }
    if (key === 'dependencyManifests') { for (const item of value) argv.push('--dependency-manifest', item); continue; }
    if (key === 'repos' || key === 'paths') {
      for (const item of value) argv.push(key === 'repos' ? '--repo' : '--path', item);
    } else if (typeof value === 'boolean') {
      if (value) argv.push(flags[key]);
    } else argv.push(flags[key], value);
  }
  if (['repo_sync', 'repo_push', 'repo_verify', 'build_run'].includes(tool.name) && args.background !== false && !args.plan) argv.push('--background');
  if (['devbox_create', 'devbox_up', 'devbox_down', 'devbox_restart', 'devbox_guest_status', 'devbox_migrate_host', 'devbox_mirror', 'devbox_install', 'devbox_build', 'devbox_smoke', 'devbox_registry_show', 'devbox_registry_reconcile', 'devbox_registry_verify'].includes(tool.name) && args.background !== false) argv.push('--background');
  return argv;
}

function invoke(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.WB_COMMAND, ['--workspace', process.env.WB_WORKSPACE_ROOT, '--json', ...argv],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => process.stderr.write(data));
    child.on('error', reject);
    child.on('close', code => {
      try {
        const result = JSON.parse(stdout);
        resolve({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: code !== 0 });
      } catch { reject(new Error(`wb returned no JSON receipt (exit ${code})`)); }
    });
  });
}

let initialized = false;
async function handle(request) {
  const { method, params = {}, id } = request;
  if (id === undefined) return; // Notifications have no response.
  try {
    let result;
    if (method === 'initialize') {
      initialized = true;
      const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      result = { protocolVersion: supported.includes(params.protocolVersion) ? params.protocolVersion : supported[0],
        capabilities: { tools: {} }, serverInfo: { name: 'winboat-workspace', version: '1.0.0' } };
    } else if (method === 'ping') result = {};
    else if (!initialized) throw Object.assign(new Error('initialize first'), { rpcCode: -32000 });
    else if (method === 'tools/list') result = { tools: catalog.map(({ command, ...tool }) => tool) };
    else if (method === 'tools/call') {
      const tool = catalog.find(item => item.name === params.name);
      if (!tool) throw Object.assign(new Error('unknown tool'), { rpcCode: -32602 });
      const args = params.arguments ?? {};
      try { validate(args, tool.inputSchema); }
      catch (error) { throw Object.assign(error, { rpcCode: -32602 }); }
      result = await invoke(command(tool, args));
    } else throw Object.assign(new Error('method not found'), { rpcCode: -32601 });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: error.rpcCode ?? -32603, message: error.message } }) + '\n');
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw new Error('invalid request');
    void handle(request);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON-RPC request' } }) + '\n');
  }
});
