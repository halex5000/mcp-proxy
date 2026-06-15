/**
 * Production bundle script — run before `vsce package`.
 *
 * Creates three self-contained CJS bundles inside packages/extension/dist/:
 *
 *   extension.js          The VS Code extension (replaces tsc output for prod)
 *   gateway-server/index.cjs  The gateway HTTP+MCP supervisor process
 *   fake-mcp-server/index.cjs The fake downstream MCP server (test-echo)
 *
 * All three are bundled by esbuild so the resulting .vsix carries zero
 * node_modules — the only external the extension bundle marks is "vscode"
 * (provided by the host), and the two server bundles mark a handful of
 * optional native modules that are handled gracefully by their dependents.
 *
 * Node requirement: the spawned gateway and fake-server use process.execPath,
 * which in VS Code's extension host is VS Code's bundled Node.js — no system
 * Node installation is required on the end-user machine.
 */

import { build } from "esbuild";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(__dirname);
const ext = path.join(root, "packages", "extension");
const gw = path.join(root, "packages", "gateway");
const fake = path.join(root, "packages", "fake-mcp-server");

// Native modules that ws / fsevents pull in optionally; their absence is
// handled gracefully by the owning library (ws falls back to pure JS).
const OPTIONAL_NATIVE = ["bufferutil", "utf-8-validate", "fsevents"];

/** Shared esbuild options for the two spawned Node.js server processes. */
const serverOpts = {
  platform: "node",
  target: "node18",
  format: "cjs",
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  external: OPTIONAL_NATIVE,
};

/** Options for the VS Code extension bundle. */
const extensionOpts = {
  ...serverOpts,
  // "vscode" is a virtual module provided by the extension host at runtime.
  external: ["vscode", ...OPTIONAL_NATIVE],
};

async function bundleAll() {
  // Ensure output directories exist
  for (const dir of [
    path.join(ext, "dist", "gateway-server"),
    path.join(ext, "dist", "fake-mcp-server"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  console.log("Bundling extension + gateway + fake-mcp-server …");

  await Promise.all([
    // 1. VS Code extension (replaces tsc dist/extension.js for production)
    build({
      ...extensionOpts,
      entryPoints: [path.join(ext, "src", "extension.ts")],
      outfile: path.join(ext, "dist", "extension.js"),
      // tsconfig in the extension directory for alias resolution
      tsconfig: path.join(ext, "tsconfig.json"),
    }),

    // 2. Gateway HTTP/MCP supervisor
    build({
      ...serverOpts,
      entryPoints: [path.join(gw, "src", "index.ts")],
      outfile: path.join(ext, "dist", "gateway-server", "index.cjs"),
      tsconfig: path.join(gw, "tsconfig.json"),
    }),

    // 3. Fake downstream MCP server (test-echo)
    build({
      ...serverOpts,
      entryPoints: [path.join(fake, "src", "index.ts")],
      outfile: path.join(ext, "dist", "fake-mcp-server", "index.cjs"),
      tsconfig: path.join(fake, "tsconfig.json"),
    }),
  ]);

  console.log("Bundle complete.");
}

bundleAll().catch((err) => {
  console.error("Bundle failed:", err);
  process.exit(1);
});
