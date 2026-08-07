# Zed Package Insights for Visual Studio Code

Native VS Code integration for Zed Package Manager diagnostics and confirmation-gated actions.

Implemented surface:

- multi-root package discovery across all workspace folders;
- versioned `zed inspect --workspace <root> --json` adapter with deterministic read-only fallback;
- Problems diagnostics, Activity Bar package tree, output channel, refresh/show/action commands;
- exact executable, argv, and cwd preview before mutation;
- mandatory modal confirmation for command actions;
- no-shell process execution, timeout, no-color environment, and credential redaction;
- Node unit tests, repository contract verification, cross-platform CI, and retained VSIX artifacts.

```sh
npm test
npm run verify
npm run package
```

The dedicated repository is established. Remaining distribution gates are a clean VS Code extension-host test and Marketplace signing/publication.
