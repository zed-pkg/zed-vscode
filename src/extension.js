'use strict';

const path = require('node:path');
const vscode = require('vscode');
const {
  discoverPackageRoots,
  displayCommand,
  inspectRoot,
  runProcess,
  redact,
} = require('./inspector');

let reports = [];
let refreshGeneration = 0;

class ZedTreeItem extends vscode.TreeItem {
  constructor(label, collapsibleState, contextValue, description, command) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
    this.description = description;
    this.command = command;
  }
}

class ZedTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(element) { return element; }
  getChildren(element) {
    if (!element) {
      return reports.map((report) => {
        const errors = report.issues.filter((item) => item.severity === 'error').length;
        const warnings = report.issues.filter((item) => item.severity === 'warning').length;
        return Object.assign(
          new ZedTreeItem(path.basename(report.workspaceRoot), vscode.TreeItemCollapsibleState.Expanded, 'zedPackage', `${errors} error(s), ${warnings} warning(s)`),
          {report}
        );
      });
    }
    if (element.report) {
      return element.report.issues.map((issue) => Object.assign(
        new ZedTreeItem(issue.title, vscode.TreeItemCollapsibleState.None, 'zedIssue', issue.id, {
          command: 'zedPackageInsights.show', title: 'Show Zed package insights'
        }),
        {issue, tooltip: `${issue.id}: ${issue.detail}`}
      ));
    }
    return [];
  }
}

function severity(value) {
  switch (String(value).toLowerCase()) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'warning': return vscode.DiagnosticSeverity.Warning;
    case 'info': return vscode.DiagnosticSeverity.Information;
    default: return vscode.DiagnosticSeverity.Hint;
  }
}

function config() {
  const settings = vscode.workspace.getConfiguration('zedPackageInsights');
  return {
    executable: settings.get('zedPath', 'zed'),
    inspectTimeoutMs: settings.get('inspectTimeoutMs', 8000),
    actionTimeoutMs: settings.get('actionTimeoutMs', 120000),
    autoRefresh: settings.get('autoRefresh', true),
  };
}

function renderReports(output) {
  output.clear();
  for (const report of reports) {
    output.appendLine(`=== ${report.workspaceRoot} (${report.source}) ===`);
    if (!report.issues.length) output.appendLine('Healthy package state.');
    for (const issue of report.issues) {
      output.appendLine(`[${issue.severity.toUpperCase()}] ${issue.id}: ${issue.title}`);
      if (issue.detail) output.appendLine(`  ${issue.detail}`);
      for (const action of issue.actions || []) {
        if (action.kind === 'command') output.appendLine(`  action: ${displayCommand(action.command, action.arguments)} (cwd: ${action.workingDirectory})`);
      }
    }
    output.appendLine('');
  }
}

function publishDiagnostics(collection) {
  collection.clear();
  for (const report of reports) {
    const byUri = new Map();
    for (const issue of report.issues) {
      const files = issue.files.length ? issue.files : [path.join(report.workspaceRoot, '.zpkg.toml')];
      for (const file of files) {
        const absolute = path.isAbsolute(file) ? file : path.join(report.workspaceRoot, file);
        const uri = vscode.Uri.file(absolute);
        const key = uri.toString();
        const values = byUri.get(key) || [];
        const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `${issue.id}: ${issue.title}\n${issue.detail}`, severity(issue.severity));
        diagnostic.source = 'zed-pkg';
        diagnostic.code = issue.id;
        values.push(diagnostic);
        byUri.set(key, values);
      }
    }
    for (const [uri, values] of byUri) collection.set(vscode.Uri.parse(uri), values);
  }
}

async function refresh(provider, collection, output, show = false) {
  const generation = ++refreshGeneration;
  const folders = (vscode.workspace.workspaceFolders || []).map((item) => item.uri.fsPath);
  const roots = await discoverPackageRoots(folders);
  const currentConfig = config();
  const next = [];
  for (const root of roots) {
    next.push(await inspectRoot(root, {executable: currentConfig.executable, timeoutMs: currentConfig.inspectTimeoutMs}));
  }
  if (generation !== refreshGeneration) return;
  reports = next;
  provider.refresh();
  publishDiagnostics(collection);
  renderReports(output);
  const issueCount = reports.reduce((count, report) => count + report.issues.length, 0);
  vscode.window.setStatusBarMessage(`Zed: ${reports.length} package(s), ${issueCount} issue(s)`, 5000);
  if (show) output.show(true);
}

async function runRecommendedAction(provider, collection, output) {
  const actions = reports.flatMap((report) => (report.issues || []).flatMap((issue) => (issue.actions || []).map((action) => ({report, issue, action}))));
  if (!actions.length) {
    void vscode.window.showInformationMessage('Zed Package Insights: no recommended actions.');
    return;
  }
  const selected = await vscode.window.showQuickPick(actions.map((item) => ({
    label: item.action.title,
    description: path.basename(item.report.workspaceRoot),
    detail: item.action.kind === 'command' ? `${displayCommand(item.action.command, item.action.arguments)} — cwd: ${item.action.workingDirectory}` : item.action.command,
    item,
  })), {placeHolder: 'Select a Zed recommended action'});
  if (!selected) return;
  const {action} = selected.item;
  if (action.kind === 'url') {
    await vscode.env.openExternal(vscode.Uri.parse(action.command));
    return;
  }
  if (action.kind !== 'command') {
    void vscode.window.showErrorMessage(`Unsupported Zed action kind: ${action.kind}`);
    return;
  }
  if (!action.requiresConfirmation) {
    void vscode.window.showErrorMessage('Unsafe Zed command action rejected: explicit confirmation is required.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Run this command?\n\n${displayCommand(action.command, action.arguments)}\n\ncwd: ${action.workingDirectory}`,
    {modal: true, detail: 'Zed Package Insights never mutates package state without confirmation.'},
    'Run Command'
  );
  if (choice !== 'Run Command') return;
  output.show(true);
  output.appendLine(`$ ${displayCommand(action.command, action.arguments)}`);
  output.appendLine(`cwd: ${action.workingDirectory}`);
  try {
    const result = await runProcess(action.command, action.arguments, action.workingDirectory, config().actionTimeoutMs);
    output.appendLine(`exit: ${result.code}`);
    if (result.stdout.trim()) output.appendLine(redact(result.stdout.trim()));
    if (result.stderr.trim()) output.appendLine(`stderr:\n${redact(result.stderr.trim())}`);
  } catch (error) {
    output.appendLine(`failed: ${redact(error.message)}`);
  }
  await refresh(provider, collection, output, false);
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Zed Package Insights');
  const diagnostics = vscode.languages.createDiagnosticCollection('zed-pkg');
  const provider = new ZedTreeProvider();
  context.subscriptions.push(output, diagnostics, provider, vscode.window.registerTreeDataProvider('zedPackageInsights.packages', provider));
  context.subscriptions.push(
    vscode.commands.registerCommand('zedPackageInsights.refresh', () => refresh(provider, diagnostics, output, false)),
    vscode.commands.registerCommand('zedPackageInsights.show', async () => { renderReports(output); output.show(true); }),
    vscode.commands.registerCommand('zedPackageInsights.actions', () => runRecommendedAction(provider, diagnostics, output)),
    vscode.commands.registerCommand('zedPackageInsights.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:zed-pkg.zed-package-insights')),
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.zpkg.toml,.zpkg.lock,.zpkg-staging/**}');
  const schedule = () => { if (config().autoRefresh) void refresh(provider, diagnostics, output, false); };
  watcher.onDidCreate(schedule, null, context.subscriptions);
  watcher.onDidChange(schedule, null, context.subscriptions);
  watcher.onDidDelete(schedule, null, context.subscriptions);
  context.subscriptions.push(watcher, vscode.workspace.onDidChangeWorkspaceFolders(schedule), vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('zedPackageInsights')) schedule();
  }));
  void refresh(provider, diagnostics, output, false);
}

function deactivate() {}

module.exports = {activate, deactivate, ZedTreeProvider};
