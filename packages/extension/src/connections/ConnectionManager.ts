import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/GatewayClient.js";
import type { GatewayConfig, ActiveConnectionConfig, ConnectionId } from "@mcp-proxy/shared";
import { CONNECTION_REGISTRY } from "./ConnectionRegistry.js";

/**
 * ConnectionManager assembles the gateway configuration from:
 *  - VS Code settings (which connections are enabled)
 *  - VS Code authentication sessions (OAuth tokens)
 *  - User secrets stored in SecretStorage
 *
 * It pushes config to the gateway via the control API whenever anything changes.
 */
export class ConnectionManager implements vscode.Disposable {
  private client: GatewayClient;
  private context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];

  constructor(client: GatewayClient, context: vscode.ExtensionContext) {
    this.client = client;
    this.context = context;

    // Re-configure when settings change
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("managedConnections")) {
          this.pushConfig().catch(console.error);
        }
      })
    );

    // Re-configure when auth sessions change (user signs in/out)
    this.disposables.push(
      vscode.authentication.onDidChangeSessions(() => {
        this.pushConfig().catch(console.error);
      })
    );
  }

  async pushConfig(): Promise<void> {
    const config = await this.buildConfig();
    await this.client.configure(config);
  }

  private async buildConfig(): Promise<GatewayConfig> {
    const settings = vscode.workspace.getConfiguration("managedConnections");
    const enabledIds: string[] = settings.get("enabledConnections") ?? ["github"];

    const connections: ActiveConnectionConfig[] = [];

    for (const definition of CONNECTION_REGISTRY) {
      const enabled = enabledIds.includes(definition.id);
      const settings = await this.resolveSettings(definition.id);
      const authToken = enabled ? await this.resolveAuthToken(definition.id) : undefined;

      connections.push({
        id: definition.id,
        definition,
        enabled,
        settings,
        authToken,
      });
    }

    return {
      connections,
      gatewayVersion: "0.1.0",
    };
  }

  private async resolveSettings(id: ConnectionId): Promise<Record<string, string>> {
    const vsConfig = vscode.workspace.getConfiguration("managedConnections");
    const settings: Record<string, string> = {};

    switch (id) {
      case "atlassian": {
        const baseUrl = vsConfig.get<string>("atlassian.baseUrl");
        if (baseUrl) settings["ATLASSIAN_BASE_URL"] = baseUrl;
        break;
      }
      case "playwright": {
        const safeMode = vsConfig.get<boolean>("playwright.safeMode") ?? true;
        settings["PLAYWRIGHT_SAFE_MODE"] = safeMode ? "1" : "0";
        break;
      }
    }

    return settings;
  }

  private async resolveAuthToken(id: ConnectionId): Promise<string | undefined> {
    try {
      switch (id) {
        case "github": {
          const session = await vscode.authentication.getSession(
            "github",
            ["repo", "read:org", "read:user"],
            { silent: true }
          );
          return session?.accessToken;
        }
        case "atlassian": {
          // Atlassian uses a stored secret rather than VS Code's auth API
          return await this.context.secrets.get("managedConnections.atlassian.token");
        }
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }

  async signIn(id: ConnectionId): Promise<void> {
    switch (id) {
      case "github": {
        await vscode.authentication.getSession(
          "github",
          ["repo", "read:org", "read:user"],
          { createIfNone: true }
        );
        break;
      }
      case "atlassian": {
        // Kick off the Atlassian OAuth flow — this is a simplified placeholder.
        // A real implementation would use vscode.env.openExternal + a local redirect handler.
        const token = await vscode.window.showInputBox({
          title: "Atlassian API Token",
          prompt:
            "Create a token at id.atlassian.com/manage-profile/security/api-tokens, then paste it here.",
          password: true,
        });
        if (token) {
          await this.context.secrets.store(
            "managedConnections.atlassian.token",
            token
          );
        }
        break;
      }
      default: {
        await vscode.window.showErrorMessage(`Sign-in for "${id}" is not yet supported.`);
      }
    }

    await this.pushConfig();
  }

  async signOut(id: ConnectionId): Promise<void> {
    switch (id) {
      case "atlassian":
        await this.context.secrets.delete("managedConnections.atlassian.token");
        break;
    }
    await this.pushConfig();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
