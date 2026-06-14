import * as assert from "assert";
import * as vscode from "vscode";

type AsyncTest = {
  name: string;
  run: () => Promise<void>;
};

const EXTENSION_NAME = "managed-mcp-connections";
const TEST_ITEM = {
  connectionId: "test-echo",
  label: "Test Echo",
};

const REQUIRED_COMMANDS = [
  "managedConnections.refresh",
  "managedConnections.restart",
  "managedConnections.openDiagnostics",
  "managedConnections.simulateConnectionMode",
  "managedConnections.showGatewayOutput",
];

export async function run(): Promise<void> {
  const tests: AsyncTest[] = [
    {
      name: "extension activates in an Extension Development Host",
      run: testActivation,
    },
    {
      name: "managed commands are registered",
      run: testRegisteredCommands,
    },
    {
      name: "gateway-backed commands run against Test Echo",
      run: testGatewayBackedCommands,
    },
  ];

  const failures: string[] = [];

  for (const test of tests) {
    try {
      console.log(`Running extension-host test: ${test.name}`);
      await test.run();
      console.log(`Passed extension-host test: ${test.name}`);
    } catch (err) {
      failures.push(`${test.name}: ${formatError(err)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Extension-host tests failed:\n${failures.join("\n\n")}`);
  }
}

async function testActivation(): Promise<void> {
  const extension = findExtension();
  assert.ok(extension, `Could not find extension named ${EXTENSION_NAME}`);

  await extension.activate();

  assert.equal(extension.isActive, true);
  assert.equal(extension.packageJSON.name, EXTENSION_NAME);
  assert.ok(extension.packageJSON.contributes.views.managedConnections);
  assert.ok(extension.packageJSON.contributes.mcpServerDefinitionProviders);
}

async function testRegisteredCommands(): Promise<void> {
  await findExtension().activate();
  const commands = await vscode.commands.getCommands(true);

  for (const command of REQUIRED_COMMANDS) {
    assert.ok(commands.includes(command), `${command} is not registered`);
  }
}

async function testGatewayBackedCommands(): Promise<void> {
  await findExtension().activate();
  await waitForCommand("managedConnections.restart");

  await vscode.commands.executeCommand("managedConnections.refresh");
  await vscode.commands.executeCommand("managedConnections.restart", TEST_ITEM);
  await vscode.commands.executeCommand(
    "managedConnections.simulateConnectionMode",
    TEST_ITEM,
    "unsafe_tools"
  );
  await vscode.commands.executeCommand("managedConnections.restart", TEST_ITEM);
  await vscode.commands.executeCommand(
    "managedConnections.simulateConnectionMode",
    TEST_ITEM,
    "ready"
  );
  await vscode.commands.executeCommand("managedConnections.openDiagnostics", TEST_ITEM);
}

function findExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.all.find(
    (candidate) => candidate.packageJSON?.name === EXTENSION_NAME
  );
  assert.ok(extension, `Extension ${EXTENSION_NAME} was not loaded by VS Code`);
  return extension;
}

async function waitForCommand(command: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes(command)) return;
    await delay(250);
  }

  throw new Error(`Timed out waiting for command ${command}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.message}\n${err.stack ?? ""}`;
  }
  return String(err);
}
