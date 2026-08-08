'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCHEMA_VERSION = 1;
const INSPECT_SCHEMA_MAJOR = 1;
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
  return ['inspect', '--format', 'json', '--root', path.resolve(workspaceRoot)];
}

function schemaMajor(value) {
  const match = /^(\d+)\./.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function pathsEquivalent(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}

function pathWithin(root, candidate) {
  const absoluteRoot = canonicalPath(root);
  const absoluteCandidate = canonicalPath(candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeV1Action(action, root) {
  if (!action || action.kind !== 'zed-command') {
    throw new Error(`Rejected unsupported inspect action kind '${action?.kind || 'unknown'}'.`);
  }
  const argv = Array.isArray(action.argv) ? action.argv.map(String) : [];
  if (!argv.length || argv[0] !== 'zed') {
    throw new Error(`Rejected unsafe inspect action executable '${argv[0] || 'missing'}'.`);
  }
  if (typeof action.mutates_project !== 'boolean' || typeof action.requires_network !== 'boolean' || typeof action.executes_package_code !== 'boolean') {
    throw new Error(`Rejected incomplete inspect action metadata '${action?.id || 'unknown'}'.`);
  }
  const workingDirectory = canonicalPath(action.cwd || root);
  if (!pathWithin(root, workingDirectory)) {
    throw new Error(`Rejected inspect action outside workspace '${action?.id || 'unknown'}'.`);
  }
  return {
    id: String(action.id || 'unknown'),
    title: String(action.title || action.id || 'Zed action'),
    kind: 'command',
    command: 'zed',
    arguments: argv.slice(1),
    // Command recommendations are never executable from the extension without
    // the existing modal confirmation, even if a future v1 action is read-only.
    requiresConfirmation: true,
    workingDirectory,
    mutatesProject: action.mutates_project,
    requiresNetwork: action.requires_network,
    executesPackageCode: action.executes_package_code,
  };
}

function validateReport(report, root) {
  if (!report || schemaMajor(report.schema_version) !== INSPECT_SCHEMA_MAJOR) {
    return failedReport(root, 'Unsupported Zed inspection schema; expected schema_version 1.x.', 'inspect.schema.unsupported');
  }
  if (
    report.cli?.implementation !== 'zed-pkg' ||
    report.cli?.command !== 'inspect' ||
    report.cli?.offline !== true ||
    report.cli?.mutates_project !== false ||
    report.cli?.loads_credentials !== false
  ) {
    return failedReport(root, 'Rejected Zed inspection report without the v1 read-only/offline safety declaration.', 'inspect.schema.unsafe');
  }
  const reportRoot = canonicalPath(report.root || root);
  if (!pathsEquivalent(root, reportRoot)) {
    return failedReport(root, 'Rejected Zed inspection report for a different project root.', 'inspect.schema.unsafe');
  }
  try {
    const issues = (Array.isArray(report.diagnostics) ? report.diagnostics : []).map((diagnostic) => {
      const locationPath = diagnostic?.location?.path ? String(diagnostic.location.path) : '';
      const files = locationPath ? [locationPath] : [];
      return {
        id: String(diagnostic?.code || 'inspect.issue.unknown'),
        severity: String(diagnostic?.severity || 'warning').toLowerCase(),
        title: String(diagnostic?.message || diagnostic?.code || 'Zed package issue'),
        detail: redact(diagnostic?.detail || ''),
        files,
        actions: (Array.isArray(diagnostic?.actions) ? diagnostic.actions : []).map((action) => normalizeV1Action(action, reportRoot)),
      };
    });
    return {
      schemaVersion: SCHEMA_VERSION,
      workspaceRoot: reportRoot,
      zedVersion: null,
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

  const commandAction = (id, title, args, {requiresNetwork = true, executesPackageCode = args[0] === 'install'} = {}) => ({
    id, title, kind: 'command', command: 'zed', arguments: args,
    requiresConfirmation: true, workingDirectory: absoluteRoot,
    mutatesProject: true, requiresNetwork, executesPackageCode,
  });

  if (!hasManifest && !hasLock) {
    issues.push({id: 'ZED001', severity: 'info', title: 'Folder is not a Zed package', detail: 'No .zpkg.toml or .zpkg.lock was found.', files: [], actions: [commandAction('zed.init', 'Initialize package', ['init'], {requiresNetwork: false})]});
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
