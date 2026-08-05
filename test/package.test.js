'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');

test('manifest exposes native commands, view, and safety settings', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commands = new Set(manifest.contributes.commands.map((item) => item.command));
  for (const command of ['zedPackageInsights.refresh', 'zedPackageInsights.show', 'zedPackageInsights.actions', 'zedPackageInsights.openSettings']) assert.ok(commands.has(command));
  assert.ok(manifest.contributes.views.zedPackageInsights.some((item) => item.id === 'zedPackageInsights.packages'));
  assert.equal(manifest.main, './src/extension.js');
});
