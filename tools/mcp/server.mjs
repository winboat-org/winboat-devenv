import { spawn } from 'node:child_process';
import readline from 'node:readline';

// This file only validates protocol arguments and proxies the Nix wb command.
// Repository, build and installation behavior belongs to shared operations.
const string = { type: 'string', minLength: 1 };
const bool = { type: 'boolean' };
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
];
const catalog = definitions.map(([name, description, command, properties, required = []]) => ({ name, description, command,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: ['workspace_status', 'repo_list', 'repo_status', 'repo_plan', 'job_status'].includes(name) },
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
    if (typeof value !== schema.type) throw new Error(`${path} must be ${schema.type}`);
    if (schema.type === 'string' && (!value.length || value.includes('\n') || value.includes('\0'))) throw new Error(`${path} is invalid`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} has an unsupported value`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} has an invalid format`);
  }
}

function command(tool, args) {
  const argv = [...tool.command];
  const flags = { subset: '--subset', activation: '--activation', shellConfig: '--shell-config', message: '--message',
    revision: '--rev', ref: '--ref', sourceUrl: '--source-url', remote: '--remote', source: '--source',
    namespace: '--namespace', name: '--name', operation: '--operation', id: '--id',
    forceWithLease: '--force-with-lease', dryRun: '--dry-run', deferCheckpoint: '--defer-checkpoint', apply: '--apply' };
  for (const [key, value] of Object.entries(args)) {
    if (key === 'background') continue;
    if (key === 'repos' || key === 'paths') {
      for (const item of value) argv.push(key === 'repos' ? '--repo' : '--path', item);
    } else if (typeof value === 'boolean') {
      if (value) argv.push(flags[key]);
    } else argv.push(flags[key], value);
  }
  if (['repo_sync', 'repo_push', 'repo_verify'].includes(tool.name) && args.background !== false) argv.push('--background');
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
