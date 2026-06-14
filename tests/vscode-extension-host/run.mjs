import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const extensionDevelopmentPath = resolve(repoRoot, "packages/extension");
const extensionTestsPath = resolve(
  repoRoot,
  "packages/extension/dist/test/suite/index.js"
);
const testWorkspace = resolve(repoRoot, "tests/fixtures/vscode-workspace");

if (!existsSync(extensionTestsPath)) {
  throw new Error(
    `Extension tests are not built at ${extensionTestsPath}. Run npm run build first.`
  );
}

await runTests({
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: [
    testWorkspace,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
  ],
  extensionTestsEnv: {
    MANAGED_CONNECTIONS_EXTENSION_HOST_TEST: "1",
  },
  version: process.env["VSCODE_TEST_VERSION"] ?? "stable",
  vscodeExecutablePath: process.env["VSCODE_TEST_EXECUTABLE"],
});
