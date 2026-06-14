import * as vscode from "vscode";
import type { GatewayClient } from "../gateway/GatewayClient.js";
import type {
  GatewayConfig,
  ActiveConnectionConfig,
  ConnectionId,
} from "@mcp-proxy/shared";
import { HEALTH_MESSAGES } from "@mcp-proxy/shared";
import { CONNECTION_REGISTRY } from "./ConnectionRegistry.js";
import { DependencyChecker } from "./DependencyChecker.js";

const GITHUB_SCOPES = ["repo", "read:org", "read:user"];

/**
 * ConnectionManager assembles the gateway configuration from:
 *   - VS Code settings (which connections are enabled, URLs)
 *   - VS Code authentication sessions (GitHub OAuth)
 *   - Secrets storage (Atlassian email + API token)
 *   - Dependency checks (Playwright, Atlassian npx packages)
 *
 * It pushes config to the gateway over /control/configure whenever anything
 * changes, and exposes sign-in/sign-out methods for each connection.
 *
 * Remote connections (GitHub) are NOT included in the gateway config — they
 * are registered directly with VS Code via ManagedMcpProvider. ConnectionManager
 * handles their auth independently.
 */
export class ConnectionManager implements vscode.Disposable {
  private client: GatewayClient;
  private context: vscode.ExtensionContext;
  private depChecker = new DependencyChecker();
  private disposables: vscode.Disposable[] = [];

  constructor(client: GatewayClient, context: vscode.ExtensionContext) {
    this.client = client;
    this.context = context;

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("managedConnections")) {
          this.pushConfig().catch(console.error);
        }
      })
    );

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

  // ── Sign-in / Sign-out ─────────────────────────────────────────────────────

  async signIn(id: ConnectionId): Promise<void> {
    switch (id) {
      case "github":
        await vscode.authentication.getSession("github", GITHUB_SCOPES, {
          createIfNone: true,
        });
        break;

      case "atlassian":
        await this.signInAtlassian();
        break;

      case "playwright":
        await vscode.window.showInformationMessage(
          "Browser Automation doesn't require sign-in. Enable it in Settings to use it.",
          "Open Settings"
        ).then((c) => {
          if (c === "Open Settings") {
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "managedConnections.enabledConnections"
            );
          }
        });
        return;

      default:
        await vscode.window.showErrorMessage(`Sign-in for "${id}" is not supported yet.`);
        return;
    }
    await this.pushConfig();
  }

  async signOut(id: ConnectionId): Promise<void> {
    switch (id) {
      case "atlassian":
        await this.context.secrets.delete("managedConnections.atlassian.email");
        await this.context.secrets.delete("managedConnections.atlassian.token");
        await this.context.secrets.delete("managedConnections.atlassian.siteName");
        break;
      // GitHub: VS Code manages its own sessions; we don't sign out of those.
      default:
        break;
    }
    await this.pushConfig();
  }

  /** Resolve the GitHub token for the MCP provider (used in resolveMcpServerDefinition). */
  async getGitHubToken(): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession(
        "github",
        GITHUB_SCOPES,
        { silent: true }
      );
      return session?.accessToken;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  // ── Config assembly ────────────────────────────────────────────────────────

  private async buildConfig(): Promise<GatewayConfig> {
    const settings = vscode.workspace.getConfiguration("managedConnections");
    const enabledIds: string[] = settings.get("enabledConnections") ?? ["github", "local-knowledge"];

    // Build configs only for local-stdio connections — remote ones go direct to VS Code
    const localDefinitions = CONNECTION_REGISTRY.filter(
      (d) => d.kind === "local-stdio"
    );

    const connections: ActiveConnectionConfig[] = await Promise.all(
      localDefinitions.map((def) => this.buildConnectionConfig(def, enabledIds))
    );

    return { connections, gatewayVersion: "0.1.0" };
  }

  private async buildConnectionConfig(
    def: import("@mcp-proxy/shared").ConnectionDefinition,
    enabledIds: string[]
  ): Promise<ActiveConnectionConfig> {
    const requestedEnabled = enabledIds.includes(def.id);

    // 1. Connections requiring explicit enable are `unsafe_disabled` until opted in
    if (def.requiresExplicitEnable && !requestedEnabled) {
      return {
        id: def.id,
        definition: def,
        enabled: false,
        settings: {},
        healthOverride: {
          status: "unsafe_disabled",
          message: HEALTH_MESSAGES["unsafe_disabled"],
        },
      };
    }

    if (!requestedEnabled) {
      return { id: def.id, definition: def, enabled: false, settings: {} };
    }

    // 2. Check dependencies
    const depResult = await this.depChecker.check(def);
    if (!depResult.installed) {
      return {
        id: def.id,
        definition: def,
        enabled: false,
        settings: {},
        healthOverride: {
          status: "dependency_missing",
          message: HEALTH_MESSAGES["dependency_missing"],
          detail: depResult.error,
        },
      };
    }

    // 3. Check auth / resolve settings
    const { settings, authMissing } = await this.resolveSettings(def.id);

    if (authMissing) {
      return {
        id: def.id,
        definition: def,
        enabled: false,
        settings,
        healthOverride: {
          status: "auth_required",
          message: HEALTH_MESSAGES["auth_required"],
        },
      };
    }

    return { id: def.id, definition: def, enabled: true, settings };
  }

  private async resolveSettings(
    id: ConnectionId
  ): Promise<{ settings: Record<string, string>; authMissing: boolean }> {
    const vsConfig = vscode.workspace.getConfiguration("managedConnections");
    const settings: Record<string, string> = {};

    switch (id) {
      case "local-knowledge": {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (folder) settings["WORKSPACE_FOLDER"] = folder;
        return { settings, authMissing: false };
      }

      case "atlassian": {
        const siteName = await this.context.secrets.get(
          "managedConnections.atlassian.siteName"
        );
        const email = await this.context.secrets.get(
          "managedConnections.atlassian.email"
        );
        const token = await this.context.secrets.get(
          "managedConnections.atlassian.token"
        );

        if (!siteName || !email || !token) {
          return { settings, authMissing: true };
        }

        settings["ATLASSIAN_SITE_NAME"] = siteName;
        settings["ATLASSIAN_USER_EMAIL"] = email;
        settings["ATLASSIAN_API_TOKEN"] = token;
        return { settings, authMissing: false };
      }

      case "playwright": {
        const headless = vsConfig.get<boolean>("playwright.headless") ?? true;
        settings["PLAYWRIGHT_HEADLESS"] = headless ? "1" : "0";
        return { settings, authMissing: false };
      }

      default:
        return { settings, authMissing: false };
    }
  }

  // ── Atlassian sign-in flow ─────────────────────────────────────────────────

  private async signInAtlassian(): Promise<void> {
    const siteName = await vscode.window.showInputBox({
      title: "Jira & Confluence — Step 1 of 3",
      prompt:
        "Enter your Atlassian site name (the part before .atlassian.net)",
      placeHolder: "yourcompany",
      ignoreFocusOut: true,
    });
    if (!siteName) return;

    const email = await vscode.window.showInputBox({
      title: "Jira & Confluence — Step 2 of 3",
      prompt: "Enter the email address associated with your Atlassian account",
      placeHolder: "you@yourcompany.com",
      ignoreFocusOut: true,
    });
    if (!email) return;

    const tokenAction = await vscode.window.showInformationMessage(
      "You'll need an Atlassian API token. Open the token page to create one, then come back.",
      "Open Token Page",
      "I already have one"
    );
    if (tokenAction === "Open Token Page") {
      await vscode.env.openExternal(
        vscode.Uri.parse(
          "https://id.atlassian.com/manage-profile/security/api-tokens"
        )
      );
    }

    const token = await vscode.window.showInputBox({
      title: "Jira & Confluence — Step 3 of 3",
      prompt: "Paste your Atlassian API token",
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return;

    await this.context.secrets.store(
      "managedConnections.atlassian.siteName",
      siteName
    );
    await this.context.secrets.store(
      "managedConnections.atlassian.email",
      email
    );
    await this.context.secrets.store(
      "managedConnections.atlassian.token",
      token
    );

    vscode.window.showInformationMessage(
      `Jira & Confluence connected for ${siteName}.atlassian.net`
    );
  }
}
