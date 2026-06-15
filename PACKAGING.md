# Packaging and cold-start guide

How to build a `.vsix`, what the end-user machine must have, and whether
first-run is zero-click.

---

## TL;DR — cold-start checklist

| Step | Who | Required? |
|---|---|---|
| Install VS Code | End user | ✅ |
| Install the `.vsix` | End user | ✅ |
| Have Node.js on PATH | End user | ❌ — not needed |
| Have npm on PATH | End user | ❌ — not needed |
| Any admin / elevated permissions | End user | ❌ — not needed |
| Click anything extra after install | End user | ❌ — zero-click |

The extension activates on VS Code startup (`onStartupFinished`), boots the
gateway in the background using **VS Code's own bundled Node.js runtime**
(`process.execPath` in the extension host), and announces itself ready — no
user action required.

---

## Why no system Node.js is needed

VS Code ships its own Node.js runtime (the same one that powers the Electron
renderer and extension host). When the extension spawns the gateway process, it
uses `process.execPath` — the path to VS Code's bundled `node` binary — not
whatever `node` might or might not be on the user's `PATH`.

The gateway and fake-mcp-server bundles are **esbuild CJS bundles** with all
dependencies inlined. They are self-contained single files; no `node_modules`
directory is needed alongside them.

---

## Host machine requirements

| Requirement | Minimum |
|---|---|
| VS Code | 1.99.0 or newer |
| Operating system | Windows 10/11, macOS 13+, or Linux (glibc 2.28+) |
| Administrator / elevated privileges | **None required** — VS Code per-user install is sufficient |
| Internet access | Only for GitHub / Atlassian connections; not needed to activate |
| Node.js | Not needed on end-user machine |

### Windows specifics

- VS Code has a per-user installer (`VSCodeUserSetup-*.exe`) that installs to
  `%LOCALAPPDATA%\Programs\Microsoft VS Code\` without admin rights. Use that.
- The extension uses only standard Win32 APIs via Node.js `child_process`. No
  UAC prompts, no registry writes, no services.
- Paths inside the gateway use `path.join()` throughout — no forward-slash
  assumptions that would break on Windows.

---

## Building the `.vsix` (developer steps)

Prerequisites for the developer/CI machine (not the end-user machine):

- Node.js ≥ 20 and npm ≥ 9
- `@vscode/vsce` (installed automatically by the package script via `npx`)
- This repository cloned and `npm install` run at the root

### One-shot package command

```bash
# From the repository root:
npm run package
```

This runs three steps in sequence:

1. **`npm run build`** — `tsc` compiles all four packages to their `dist/`
   directories (type-checked, source maps generated).

2. **`node scripts/bundle.mjs`** — esbuild creates three self-contained
   production bundles inside `packages/extension/dist/`:

   | Bundle | Path in vsix | Contents |
   |---|---|---|
   | VS Code extension | `dist/extension.js` | Extension + `@mcp-proxy/shared` |
   | Gateway server | `dist/gateway-server/index.cjs` | Express HTTP server, MCP supervisor, all deps |
   | Fake MCP server | `dist/fake-mcp-server/index.cjs` | Test-echo downstream server, all deps |

3. **`vsce package --no-dependencies`** — assembles the `.vsix`. The
   `--no-dependencies` flag skips `npm install --production` because the
   esbuild bundles carry their own deps; no `node_modules` directory goes
   into the vsix.

The resulting `.vsix` is self-contained: VS Code's built-in Node.js is the
only runtime it relies on.

---

## Verifying a bundled build on a clean machine

### On the same machine (smoke test)

```bash
# After npm run package produces managed-mcp-connections-0.1.0.vsix:
node packages/extension/dist/gateway-server/index.cjs
# Expected output within 2 seconds:
# GATEWAY_READY port=XXXXX
# MCP endpoint: http://127.0.0.1:XXXXX/mcp
```

### On a clean machine (full cold-start test)

1. Install VS Code (per-user installer — no admin).
2. Install the `.vsix`:
   ```
   code --install-extension managed-mcp-connections-0.1.0.vsix
   ```
   Or: Extensions panel → `...` → "Install from VSIX…"
3. Reload VS Code.
4. Open the Connections Center (`Cmd/Ctrl+Shift+P` →
   "Managed Connections: Open Connections Center").
5. Within 5 seconds the **Test Echo** card should show **Connected** with
   "3 tools available".

No other steps. No npm. No Node.js. No admin.

---

## Development vs production path resolution

The extension resolves the gateway entrypoint in this order (first match wins):

| Priority | Path | Present in |
|---|---|---|
| 1 | `dist/gateway-server/index.cjs` | Production vsix (esbuild bundle) |
| 2 | `dist/gateway-server/index.js` | Manual copy / future tsc copy |
| 3 | `../gateway/dist/index.js` | Monorepo dev (Extension Development Host) |

The fake-mcp-server follows the same pattern under `dist/fake-mcp-server/`.

In the **Extension Development Host** (`F5` from the monorepo), path 3 is used
— the gateway runs from `packages/gateway/dist/index.js` compiled by tsc, and
`@mcp-proxy/shared` resolves via the workspace node_modules symlink. This
requires `npm run build` to have been run first.

In a **packaged vsix**, path 1 is used — the esbuild bundles are always present,
carry all deps inline, and need no workspace.

---

## Bundle sizes (approximate, without minification)

| Bundle | Size | Sourcemap |
|---|---|---|
| Extension | ~100 KB | ~180 KB |
| Gateway server | ~1.9 MB | ~3.0 MB |
| Fake MCP server | ~720 KB | ~1.2 MB |

Total vsix overhead from bundles: ~2.7 MB uncompressed (~1 MB zipped).
Run `node scripts/bundle.mjs` then `vsce ls` to inspect the exact vsix manifest.

To strip sourcemaps (saves ~4 MB in the vsix), uncomment the `**/*.map` line in
`packages/extension/.vsixignore`.

---

## Adding esbuild flags (minification, target tuning)

Edit `scripts/bundle.mjs`. Useful flags:

```js
minify: true,            // ~40-50% size reduction; harder to diagnose crashes
target: "node18",        // already set; VS Code 1.99 ships node 18
sourcemap: "external",   // .map files alongside instead of inline
```
