# Work Extension Integration Guide

Purpose: explain how to transplant this spike into another VS Code-based extension while keeping scope tight.

Target milestone:

- existing extension starts the local gateway
- gateway exposes `/control/status`
- gateway is registered as MCP
- assistant can invoke the echo tool
- Connections view or command shows health
- Test Echo can crash/restart
- no manual `mcp.json` edits

Do not integrate real GitHub, Atlassian, or Playwright yet. Keep those as placeholder/detected/external/future rows until the gateway/supervisor UX is proven inside the host extension.

## Required VS Code Version

Use VS Code engine:

```json
{
  "engines": {
    "vscode": "^1.99.0"
  }
}
```

The important API is:

```ts
vscode.lm.registerMcpServerDefinitionProvider(...)
new vscode.McpHttpServerDefinition(...)
```

## What To Copy

Copy these packages or their equivalent source into the target extension repo:

```text
packages/shared/
packages/gateway/
packages/fake-mcp-server/
```

Copy these extension-side pieces or adapt them into the existing extension:

```text
packages/extension/src/gateway/GatewayProcess.ts
packages/extension/src/gateway/GatewayClient.ts
packages/extension/src/providers/ManagedMcpProvider.ts
packages/extension/src/connections/ConnectionRegistry.ts
packages/extension/src/connections/ConnectionManager.ts
packages/extension/src/health/HealthMonitor.ts
packages/extension/src/providers/ConnectionPresentation.ts
packages/extension/src/providers/ConnectionsTreeProvider.ts
packages/extension/src/commands/CommandRules.ts
packages/extension/src/commands/SetupVerifier.ts
packages/extension/src/ui/DiagnosticsPanel.ts
packages/extension/resources/connections.svg
```

At minimum for milestone 1:

```text
GatewayProcess.ts
GatewayClient.ts
ManagedMcpProvider.ts
ConnectionRegistry.ts with only test-echo
ConnectionManager.ts with only test-echo
SetupVerifier.ts
packages/gateway/
packages/shared/
packages/fake-mcp-server/
```

## Build And Package The Gateway

During development, `GatewayProcess` resolves:

```text
packages/gateway/dist/index.js
```

For a packaged extension, copy the built gateway into the extension package:

```text
dist/gateway-server/index.js
```

Also copy the fake MCP server into a stable packaged location, for example:

```text
dist/fake-mcp-server/index.js
```

The current resolver already checks:

```text
dist/gateway-server/index.js
../gateway/dist/index.js
```

For the fake server, `ConnectionManager.resolveFakeServerEntrypoint()` checks:

```text
dist/fake-mcp-server/index.js
../fake-mcp-server/dist/index.js
```

The target extension’s packaging step should include these built files.

## Start And Stop The Gateway

In the target extension activation:

```ts
const gatewayProcess = new GatewayProcess(context);
context.subscriptions.push(gatewayProcess);

const gatewayPort = await gatewayProcess.start();
const gatewayClient = new GatewayClient(gatewayPort, gatewayProcess.authToken);
```

On deactivation, VS Code disposes `context.subscriptions`, which calls `GatewayProcess.dispose()` and kills the gateway.

The gateway also exits when stdin closes, preventing orphan processes.

## Register The Gateway As MCP

Add package contribution:

```json
{
  "contributes": {
    "mcpServerDefinitionProviders": [
      {
        "id": "managed-connections",
        "label": "Managed Connections"
      }
    ]
  }
}
```

Register on activation:

```ts
const mcpProvider = new ManagedMcpProvider(gatewayProcess, connectionManager);
context.subscriptions.push(
  vscode.lm.registerMcpServerDefinitionProvider("managed-connections", mcpProvider)
);
```

The provider returns:

```ts
new vscode.McpHttpServerDefinition(
  "Managed Connections",
  vscode.Uri.parse(gatewayProcess.mcpUri),
  authHeader(gatewayProcess.authToken),
  "0.1.0"
)
```

Do not use `McpStdioServerDefinition` for the gateway. That would make VS Code spawn a second process and break lifecycle ownership.

## Feature Flag Example

Add a setting in the target extension:

```json
{
  "workbenchProduct.managedMcp.enabled": {
    "type": "boolean",
    "default": false,
    "description": "Enable managed MCP gateway prototype.",
    "scope": "window"
  }
}
```

Activation guard:

```ts
const enabled = vscode.workspace
  .getConfiguration("workbenchProduct.managedMcp")
  .get<boolean>("enabled");

if (!enabled) {
  return;
}
```

For dogfooding, default it to `true` in an internal build profile only.

## Commands To Add

Minimum:

```json
[
  {
    "command": "managedConnections.verifyLocalSetup",
    "title": "Verify Local Setup",
    "category": "Managed Connections"
  },
  {
    "command": "managedConnections.restart",
    "title": "Restart Connection",
    "category": "Connections"
  },
  {
    "command": "managedConnections.simulateConnectionMode",
    "title": "Simulate Connection State",
    "category": "Connections"
  },
  {
    "command": "managedConnections.openDiagnostics",
    "title": "Open Diagnostics",
    "category": "Connections"
  },
  {
    "command": "managedConnections.copyDiagnosticsJson",
    "title": "Copy Diagnostics JSON",
    "category": "Connections"
  }
]
```

Useful command implementation files:

```text
registerCommands.ts
SetupVerifier.ts
CommandRules.ts
```

## Views To Add

Add a first-class Activity Bar view:

```json
{
  "viewsContainers": {
    "activitybar": [
      {
        "id": "managedConnections",
        "title": "Connections",
        "icon": "resources/connections.svg"
      }
    ]
  },
  "views": {
    "managedConnections": [
      {
        "id": "managedConnections.connectionsView",
        "name": "Connections",
        "contextualTitle": "Connections"
      }
    ]
  }
}
```

Wire it:

```ts
const healthMonitor = new HealthMonitor(gatewayClient);
healthMonitor.start();

const treeProvider = new ConnectionsTreeProvider(healthMonitor);
context.subscriptions.push(
  vscode.window.createTreeView("managedConnections.connectionsView", {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  })
);
```

## Secrets And Session Tokens

Gateway bearer token:

- generated in `GatewayProcess`
- random per activation
- stored only in memory
- passed to gateway through `GATEWAY_AUTH_TOKEN`
- sent to `/mcp` and `/control/*` as `Authorization: Bearer ...`

Vendor secrets:

- not needed for milestone 1
- should live in `context.secrets`
- never pass secrets in process args
- pass downstream auth through environment variables only

VS Code auth sessions:

- not needed for milestone 1
- future GitHub flow should use `vscode.authentication.getSession(...)`

## What Not To Integrate Yet

Do not integrate yet:

- real GitHub remote MCP
- real Atlassian MCP
- real Playwright MCP
- arbitrary user-defined MCP server config
- packaged marketplace flow
- admin policy system beyond placeholder states
- persistent gateway sessions

Keep milestone 1 deterministic with Test Echo.

## Known Risks

- VS Code MCP first-run behavior may require manually enabling/starting the registered MCP server once in the tools UI.
- Packaging must include the built gateway and fake server entrypoints.
- If the host extension has strict content security or activation timing, gateway startup may need to be moved behind a feature flag or explicit command.
- `McpHttpServerDefinition` API requires recent VS Code versions.
- Long-running downstream servers need timeout/backoff tuning before production.
- Assistant tool visibility depends on Copilot/VS Code MCP tool refresh behavior.

## Milestone 1 Acceptance Test

Run:

```bash
npm install
npm run build
npm run smoke
npm test
npm run test:vscode
```

In the target extension:

1. Launch Extension Development Host.
2. Open Connections view.
3. Confirm `Test Echo` is `Connected`.
4. Run `Managed Connections: Verify Local Setup`.
5. Ask assistant to use echo tool.
6. Simulate `crash_after_delay`.
7. Restart connection.
8. Simulate `unsafe_tools`.
9. Verify unsafe tools are hidden.
10. Confirm no one edited `mcp.json`.
