'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('zed-pkg.zed-package-insights');
  assert.ok(extension, 'development extension should be discoverable');
  await extension.activate();

  const folders = vscode.workspace.workspaceFolders || [];
  assert.equal(folders.length, 1, 'test host should open exactly one fixture workspace');
  const root = folders[0].uri.fsPath;
  const manifestPath = path.join(root, '.zpkg.toml');
  const manifestBefore = fs.readFileSync(manifestPath, 'utf8');

  const settings = vscode.workspace.getConfiguration('zedPackageInsights');
  await settings.update('zedPath', path.join(root, '__missing_zed_cli__'), vscode.ConfigurationTarget.Global);
  await settings.update('autoRefresh', false, vscode.ConfigurationTarget.Global);

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    'zedPackageInsights.refresh',
    'zedPackageInsights.show',
    'zedPackageInsights.actions',
    'zedPackageInsights.openSettings',
  ]) {
    assert.ok(commands.has(command), `expected registered command ${command}`);
  }

  await vscode.commands.executeCommand('zedPackageInsights.refresh');

  const uri = vscode.Uri.file(manifestPath);
  const diagnostics = vscode.languages.getDiagnostics(uri);
  const codes = diagnostics.map((item) => String(item.code));
  assert.ok(codes.includes('ZED003'), `expected missing-lock fallback diagnostic, got ${codes.join(', ')}`);
  assert.ok(codes.includes('cli.unavailable'), `expected unavailable-CLI diagnostic, got ${codes.join(', ')}`);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBefore, 'read-only refresh must not mutate the fixture manifest');
  assert.ok(!fs.existsSync(path.join(root, '.zpkg.lock')), 'read-only refresh must not create a lockfile');
  assert.ok(!fs.existsSync(path.join(root, 'zed_modules')), 'read-only refresh must not materialize dependencies');
}

module.exports = {run};
