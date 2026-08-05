'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCHEMA_VERSION = 1;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.idea', '.vscode', 'node_modules', 'zed_modules',
  'target', 'build', 'dist', '.dart_tool', '.gradle', '.vendor'
]);

function redact(value) {
  if (!value) return '';
  return String(value)
    .replace(/(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED]');
}

function quoteArg(argument) {
  const text = String(argument);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : JSON.stringify(text);
}

function displayCommand(executable, args) {
  return [executable, ...args].map(quoteArg).join(' ');
}

function inspectArgs(workspaceRoot) {
  return ['inspect', '--workspace', path.resolve(workspaceRoot), '--json'];
}

function normalizeAction(action, root) {
  const kind = String(action?.kind || '');
  const command = String(action?.command || '');
  const args = Array.isArray(action?.arguments) ? action.arguments.map(String) : [];
  const requiresConfirmation = Boolean(action?.requiresConfirmation);
  if (kind === 'command' && !requiresConfirmation) {
    throw new Error(`Rejected unsafe command action '${action?.id || 'unknown'}'.`);
  }
  return {
    id: String(action?.id || 'unknown'),
    title: String(action?.title || action?.id || 'Zed action'),
    kind,
    command,
    arguments: args,
    requiresConfirmation,
    workingDirectory: path.resolve(action?.workingDirectory || root),
  };
}

function validateReport(report, root) {
  if (!report || report.schemaVersion !== SCHEMA_VERSION) {
    return failedReport(root, 'Unsupported Zed inspection schema; expected schemaVersion 1.', 'inspect.schema.unsupported');
  }
  try {
    const issues = (Array.isArray(report.issues) ? report.issues : []).map((issue) => ({
      id: String(issue?.id || 'inspect.issue.unknown'),
      severity: String(issue?.severity || 'warning').toLowerCase(),
      title: String(issue?.title || issue?.id || 'Zed package issue'),
      detail: redact(issue?.detail || ''),
      files: Array.isArray(issue?.files) ? issue.files.map(String) : [],
      actions: (Array.isArray(issue?.actions) ? issue.actions : []).map((action) => normalizeAction(action, root)),
    }));
    return {
      schemaVersion: SCHEMA_VERSION,
      workspaceRoot: path.resolve(report.workspaceRoot || root),
      zedVersion: report.zedVersion ? String(report.zedVersion) : null,
      source: 'cli',
      issues,
    };
  } catch (error) {
    return failedReport(root, error.message, 'inspect.action.unsafe');
  }
}

function failedReport(root, detail, id = 'inspect.failed') {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceRoot: path.resolve(root),
    zedVersion: null,
    source: 'fallback',
    issues: [{id, severity: 'error', title: 'Zed inspection failed', detail: redact(detail), files: [], actions: []}],
  };
}

function unavailableReport(root, detail) {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceRoot: path.resolve(root),
    zedVersion: null,
    source: 'fallback',
    issues: [{
      id: 'cli.unavailable', severity: 'warning', title: 'Zed CLI is unavailable', detail: redact(detail), files: [],
      actions: [{id: 'open-install-docs', title: 'Open installation instructions', kind: 'url', command: 'https://zpkg.tech', arguments: [], requiresConfirmation: false, workingDirectory: path.resolve(root)}],
    }],
  };
}

function runProcess(executable, args, cwd, timeoutMs, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {...env, NO_COLOR: '1', CLICOLOR: '0', TERM: 'dumb'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const error = new Error(`Zed command timed out after ${timeoutMs} ms.`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({code: code ?? -1, signal, stdout: redact(stdout), stderr: redact(stderr)});
    });
  });
}

async function inspectWithCli(root, options = {}) {
  const executable = options.executable || 'zed';
  const timeoutMs = options.timeoutMs || 8000;
  const runner = options.runner || runProcess;
  const args = inspectArgs(root);
  const result = await runner(executable, args, path.resolve(root), timeoutMs);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `zed exited with code ${result.code}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Zed returned invalid JSON: ${error.message}`);
  }
  return validateReport(report, root);
}

function directoryHasEntries(directory) {
  try {
    return fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

function basicTomlLooksValid(text) {
  let openSection = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      if (!line.endsWith(']') || line === '[]') return false;
      openSection = true;
    } else if (!line.includes('=') && !openSection) {
      return false;
    }
  }
  return true;
}

function fallbackReport(root, cliFailure = '') {
  const absoluteRoot = path.resolve(root);
  const manifest = path.join(absoluteRoot, '.zpkg.toml');
  const lock = path.join(absoluteRoot, '.zpkg.lock');
  const staging = path.join(absoluteRoot, '.zpkg-staging');
  const modules = path.join(absoluteRoot, 'zed_modules');
  const hasManifest = fs.existsSync(manifest);
  const hasLock = fs.existsSync(lock);
  const issues = [];

  const commandAction = (id, title, args) => ({
    id, title, kind: 'command', command: 'zed', arguments: args,
    requiresConfirmation: true, workingDirectory: absoluteRoot,
  });

  if (!hasManifest && !hasLock) {
    issues.push({id: 'ZED001', severity: 'info', title: 'Folder is not a Zed package', detail: 'No .zpkg.toml or .zpkg.lock was found.', files: [], actions: [commandAction('zed.init', 'Initialize package', ['init'])]});
  } else if (!hasManifest && hasLock) {
    issues.push({id: 'ZED002', severity: 'warning', title: 'Lockfile exists without a manifest', detail: 'Restore the frozen package state without generating a manifest.', files: [lock], actions: [commandAction('zed.restoreFrozen', 'Restore frozen state', ['install', '--frozen', '--do-not-write-new-manifest'])]});
  } else if (hasManifest && !hasLock) {
    issues.push({id: 'ZED003', severity: 'warning', title: 'Manifest has no lockfile', detail: 'Resolve and materialize the declared package graph.', files: [manifest], actions: [commandAction('zed.install', 'Install dependencies', ['install'])]});
  }

  if (hasManifest) {
    let manifestText = '';
    try { manifestText = fs.readFileSync(manifest, 'utf8'); } catch (error) {
      issues.push({id: 'ZED013', severity: 'error', title: 'Manifest could not be read', detail: redact(error.message), files: [manifest], actions: []});
    }
    if (manifestText && !basicTomlLooksValid(manifestText)) {
      issues.push({id: 'ZED014', severity: 'error', title: 'Manifest TOML is invalid', detail: 'The local fallback found malformed TOML structure.', files: [manifest], actions: []});
    }
    if (manifestText && /\[(dev-)?dependencies\]/.test(manifestText) && !fs.existsSync(modules)) {
      issues.push({id: 'ZED006', severity: 'warning', title: 'Dependencies are not materialized', detail: 'The manifest declares dependencies but zed_modules is missing.', files: [manifest], actions: [commandAction('zed.install', 'Install dependencies', ['install'])]});
    }
  }

  if (hasManifest && hasLock) {
    try {
      if (fs.statSync(manifest).mtimeMs > fs.statSync(lock).mtimeMs + 1) {
        issues.push({id: 'ZED004', severity: 'warning', title: 'Manifest is newer than the lockfile', detail: 'The lockfile may not reflect the current manifest.', files: [manifest, lock], actions: [commandAction('zed.install', 'Refresh lockfile', ['install'])]});
      }
    } catch (error) {
      issues.push({id: 'ZED015', severity: 'error', title: 'Lockfile could not be inspected', detail: redact(error.message), files: [lock], actions: []});
    }
  }

  if (directoryHasEntries(staging)) {
    const args = ['install'];
    if (hasLock) args.push('--frozen');
    if (hasLock && !hasManifest) args.push('--do-not-write-new-manifest');
    issues.push({id: 'ZED007', severity: 'error', title: 'Interrupted Zed transaction needs recovery', detail: '.zpkg-staging contains transaction state.', files: [staging], actions: [commandAction('zed.recover', 'Run lifecycle recovery', args)]});
  }

  if (cliFailure) {
    issues.push(...unavailableReport(absoluteRoot, cliFailure).issues);
  }
  return {schemaVersion: SCHEMA_VERSION, workspaceRoot: absoluteRoot, zedVersion: null, source: 'fallback', issues};
}

async function inspectRoot(root, options = {}) {
  try {
    const report = await inspectWithCli(root, options);
    if (report.issues.length === 1 && report.issues[0].id === 'inspect.schema.unsupported') {
      return fallbackReport(root, report.issues[0].detail);
    }
    return report;
  } catch (error) {
    return fallbackReport(root, error.message);
  }
}

async function discoverPackageRoots(folders, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const roots = [];
  const seen = new Set();
  async function walk(directory, depth) {
    const absolute = path.resolve(directory);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    let entries;
    try { entries = await fsp.readdir(absolute, {withFileTypes: true}); } catch { return; }
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has('.zpkg.toml') || names.has('.zpkg.lock')) roots.push(absolute);
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      await walk(path.join(absolute, entry.name), depth + 1);
    }
  }
  for (const folder of folders) await walk(folder, 0);
  return [...new Set(roots)].sort();
}

module.exports = {
  SCHEMA_VERSION,
  redact,
  displayCommand,
  inspectArgs,
  validateReport,
  failedReport,
  unavailableReport,
  runProcess,
  inspectWithCli,
  fallbackReport,
  inspectRoot,
  discoverPackageRoots,
};
