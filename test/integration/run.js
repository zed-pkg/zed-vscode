'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {runTests} = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  const fixture = path.resolve(__dirname, '../fixtures/workspace');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-vscode-e2e-'));
  const userDataDir = path.join(scratch, 'user-data');
  const extensionsDir = path.join(scratch, 'extensions');
  fs.mkdirSync(userDataDir, {recursive: true});
  fs.mkdirSync(extensionsDir, {recursive: true});

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        fixture,
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
    });
  } finally {
    fs.rmSync(scratch, {recursive: true, force: true});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
