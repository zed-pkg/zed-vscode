# Zed Package Insights for Visual Studio Code

Native VS Code integration for Zed Package Manager diagnostics and confirmation-gated actions.

Implemented surface:

- multi-root package discovery across all workspace folders;
- versioned `zed inspect --workspace <root> --json` adapter with deterministic read-only fallback;
- Problems diagnostics, Activity Bar package tree, output channel, refresh/show/action commands;
- exact executable, argv, and cwd preview before mutation;
- mandatory modal confirmation for command actions;
- no-shell process execution, timeout, no-color environment, and credential redaction;
- Node unit tests and repository-contract verification on fixed Linux/macOS/Windows runners;
- a clean VS Code Extension Development Host test using disposable user data, a disposable fixture workspace, and an intentionally unavailable CLI;
- a committed npm lock with exact `@vscode/test-electron` and `@vscode/vsce` tool identities, enforced through `npm ci`;
- immutable third-party Action pins and unpersisted checkout credentials in permanent CI;
- retained VSIX artifacts.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run verify
xvfb-run -a npm run test:extension
npm run package
```

The dedicated repository and clean Extension Host gate are established. Remaining distribution gates are adoption of the final shared `zed inspect` schema and Marketplace signing/publication with final artifact provenance.
