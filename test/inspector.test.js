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

test('redacts assignment, bearer, and GitHub token shapes', () => {
  const value = redact('Authorization: Bearer abc.def token=secret ghp_abcdefghijklmnopqrstuvwxyz');
  assert.equal(value.includes('secret'), false);
  assert.equal(value.includes('ghp_'), false);
  assert.match(value, /\[REDACTED\]/);
});

test('constructs an argv inspection command', () => {
  const root = path.resolve('work space');
  assert.deepEqual(inspectArgs(root), ['inspect', '--workspace', root, '--json']);
});

test('rejects unsupported schemas and unsafe command actions', () => {
  const root = path.resolve('/workspace');
  assert.equal(validateReport({schemaVersion: 2, issues: []}, root).issues[0].id, 'inspect.schema.unsupported');
  const report = validateReport({
    schemaVersion: 1,
    workspaceRoot: root,
    issues: [{id: 'lock.stale', severity: 'warning', title: 'Stale', detail: 'token=x', actions: [{id: 'install', title: 'Install', kind: 'command', command: 'zed', arguments: ['install'], requiresConfirmation: false}]}]
  }, root);
  assert.equal(report.issues[0].id, 'inspect.action.unsafe');
  assert.equal(report.issues[0].detail.includes('token=x'), false);
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
