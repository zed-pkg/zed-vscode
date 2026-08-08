'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  redact,
  inspectArgs,
  validateReport,
  fallbackReport,
  discoverPackageRoots,
} = require('../src/inspector');

function safeCliReport(root, diagnostics = []) {
  return {
    schema_version: '1.0',
    root,
    cli: {
      implementation: 'zed-pkg',
      command: 'inspect',
      offline: true,
      mutates_project: false,
      loads_credentials: false,
    },
    diagnostics,
  };
}

test('redacts assignment, bearer, and GitHub token shapes', () => {
  const value = redact('Authorization: Bearer abc.def token=secret ghp_abcdefghijklmnopqrstuvwxyz');
  assert.equal(value.includes('secret'), false);
  assert.equal(value.includes('ghp_'), false);
  assert.match(value, /\[REDACTED\]/);
});

test('constructs the stable v1 argv inspection command', () => {
  const root = path.resolve('work space');
  assert.deepEqual(inspectArgs(root), ['inspect', '--format', 'json', '--root', root]);
});

test('normalizes v1 diagnostics into confirmation-gated extension actions', () => {
  const root = path.resolve('/workspace');
  const report = validateReport(safeCliReport(root, [{
    code: 'LOCK_MISSING',
    severity: 'warning',
    message: 'No lockfile exists.',
    detail: 'token=secret',
    location: {path: path.join(root, '.zpkg.lock')},
    actions: [{
      id: 'create-lock',
      title: 'Resolve and create the lockfile',
      kind: 'zed-command',
      argv: ['zed', 'install'],
      cwd: root,
      mutates_project: true,
      requires_network: true,
      executes_package_code: false,
    }],
  }]));

  assert.equal(report.source, 'cli');
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].id, 'LOCK_MISSING');
  assert.equal(report.issues[0].detail.includes('secret'), false);
  assert.deepEqual(report.issues[0].files, [path.join(root, '.zpkg.lock')]);
  assert.deepEqual(report.issues[0].actions[0], {
    id: 'create-lock',
    title: 'Resolve and create the lockfile',
    kind: 'command',
    command: 'zed',
    arguments: ['install'],
    requiresConfirmation: true,
    workingDirectory: root,
  });
});

test('fails closed on unsupported or unsafe v1 reports', () => {
  const root = path.resolve('/workspace');
  assert.equal(validateReport({schema_version: '2.0'}, root).issues[0].id, 'inspect.schema.unsupported');

  const unsafeDeclaration = safeCliReport(root);
  unsafeDeclaration.cli.offline = false;
  assert.equal(validateReport(unsafeDeclaration, root).issues[0].id, 'inspect.schema.unsafe');

  const unsafeExecutable = safeCliReport(root, [{
    code: 'UNSAFE', severity: 'warning', message: 'Unsafe', location: {path: root},
    actions: [{
      id: 'shell', title: 'Shell', kind: 'zed-command', argv: ['sh', '-c', 'echo nope'], cwd: root,
      mutates_project: true, requires_network: false, executes_package_code: true,
    }],
  }]);
  assert.equal(validateReport(unsafeExecutable, root).issues[0].id, 'inspect.action.unsafe');

  const outsideWorkspace = safeCliReport(root, [{
    code: 'OUTSIDE', severity: 'warning', message: 'Outside', location: {path: root},
    actions: [{
      id: 'outside', title: 'Outside', kind: 'zed-command', argv: ['zed', 'install'], cwd: path.resolve(root, '..'),
      mutates_project: true, requires_network: true, executes_package_code: false,
    }],
  }]);
  assert.equal(validateReport(outsideWorkspace, root).issues[0].id, 'inspect.action.unsafe');
});

test('discovers nested package roots and skips dependency trees', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'zed-vscode-roots-'));
  const first = path.join(base, 'first');
  const nested = path.join(first, 'packages', 'nested');
  const ignored = path.join(first, 'node_modules', 'ignored');
  await fsp.mkdir(nested, {recursive: true});
  await fsp.mkdir(ignored, {recursive: true});
  await fsp.writeFile(path.join(first, '.zpkg.toml'), '[package]\n');
  await fsp.writeFile(path.join(nested, '.zpkg.lock'), 'version = 1\n');
  await fsp.writeFile(path.join(ignored, '.zpkg.toml'), '[package]\n');
  const roots = await discoverPackageRoots([first]);
  assert.deepEqual(roots, [path.resolve(first), path.resolve(nested)].sort());
  await fsp.rm(base, {recursive: true, force: true});
});

test('fallback reports staging recovery without mutating the workspace', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zed-vscode-fallback-'));
  await fsp.writeFile(path.join(root, '.zpkg.toml'), '[package]\norg = "acme"\nname = "widget"\nversion = "1.0.0"\n');
  await fsp.writeFile(path.join(root, '.zpkg.lock'), 'version = 1\n');
  await fsp.mkdir(path.join(root, '.zpkg-staging'));
  await fsp.writeFile(path.join(root, '.zpkg-staging', 'journal.json'), '{}');
  const before = fs.readFileSync(path.join(root, '.zpkg-staging', 'journal.json'), 'utf8');
  const report = fallbackReport(root, 'token=secret');
  assert.ok(report.issues.some((issue) => issue.id === 'ZED007'));
  assert.ok(report.issues.some((issue) => issue.id === 'cli.unavailable'));
  assert.equal(JSON.stringify(report).includes('token=secret'), false);
  assert.equal(fs.readFileSync(path.join(root, '.zpkg-staging', 'journal.json'), 'utf8'), before);
  const recovery = report.issues.find((issue) => issue.id === 'ZED007').actions[0];
  assert.equal(recovery.requiresConfirmation, true);
  assert.equal(path.resolve(recovery.workingDirectory), path.resolve(root));
  await fsp.rm(root, {recursive: true, force: true});
});
