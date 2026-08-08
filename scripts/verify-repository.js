'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extension = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
const inspector = fs.readFileSync(path.join(root, 'src', 'inspector.js'), 'utf8');
const conformance = JSON.parse(fs.readFileSync(path.join(root, 'conformance', 'ide-integration.json'), 'utf8'));

assert.equal(manifest.publisher, 'zed-pkg');
assert.equal(manifest.repository.url, 'https://github.com/zed-pkg/zed-vscode.git');
assert.equal(manifest.main, './src/extension.js');
assert.equal(conformance.repository, 'zed-pkg/zed-vscode');
assert.ok(manifest.activationEvents.includes('workspaceContains:**/.zpkg.toml'));
assert.ok(manifest.activationEvents.includes('workspaceContains:**/.zpkg.lock'));
assert.match(extension, /createFileSystemWatcher\('\*\*\/\{\.zpkg\.toml,\.zpkg\.lock,\.zpkg-staging\/\*\*\}'\)/);
assert.match(extension, /modal:\s*true/);
assert.match(extension, /Unsafe Zed command action rejected/);
assert.match(inspector, /shell:\s*false/);
assert.match(inspector, /NO_COLOR:\s*'1'/);
assert.match(inspector, /requiresConfirmation/);
assert.doesNotMatch(inspector, /execSync|execFileSync/);

console.log('zed-vscode repository contract verified');
