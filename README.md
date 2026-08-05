# Zed Package Insights for Visual Studio Code

Source-visible VS Code integration candidate for Zed Package Manager diagnostics and confirmation-gated actions.

Implemented candidate surface:

- multi-root package discovery across all workspace folders;
- versioned `zed inspect --workspace <root> --json` adapter;
- deterministic read-only fallback diagnostics;
- Problems diagnostics, Activity Bar package tree, output channel, refresh/show/action commands;
- exact executable, argv, and cwd preview before mutation;
- mandatory modal confirmation for command actions;
- no-shell process execution, timeout, no-color environment, and credential redaction;
- Node unit tests and VSIX packaging.

```sh
npm test
npx --yes @vscode/vsce package
```

The dedicated `zed-pkg/zed-vscode` repository, clean VS Code instance tests, Marketplace publication, and retained signed release remain promotion gates.
