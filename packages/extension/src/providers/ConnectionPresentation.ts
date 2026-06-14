import type {
  ConnectionAction,
  ConnectionHealth,
  ConnectionHealthStatus,
} from "@mcp-proxy/shared";

export interface ConnectionPresentation {
  status: ConnectionHealthStatus;
  description: string;
  userMessage: string;
  tooltipMarkdown: string;
  iconId: string;
  iconColor?: string;
  contextValue: string;
  primaryAction?: ConnectionAction;
  secondaryAction?: ConnectionAction;
}

export interface ConnectionInfoPresentation {
  label: string;
  iconId: string;
}

const PRIMARY_ACTIONS: Partial<Record<ConnectionHealthStatus, ConnectionAction>> = {
  not_configured: "open-settings",
  auth_required: "sign-in",
  degraded: "restart",
  crashed: "restart",
  dependency_missing: "install-dependency",
  blocked_by_policy: "contact-admin",
  version_mismatch: "update-extension",
  unsafe_disabled: "enable",
};

const ICONS: Record<ConnectionHealthStatus, { id: string; color?: string }> = {
  ready: { id: "check", color: "testing.iconPassed" },
  starting: { id: "loading~spin" },
  stopping: { id: "loading~spin" },
  not_configured: { id: "circle-outline" },
  auth_required: { id: "key" },
  degraded: { id: "warning", color: "list.warningForeground" },
  crashed: { id: "error", color: "testing.iconFailed" },
  dependency_missing: { id: "cloud-download" },
  blocked_by_policy: { id: "lock" },
  version_mismatch: { id: "versions" },
  unsafe_disabled: { id: "circle-slash" },
};

export function presentConnection(
  health: ConnectionHealth
): ConnectionPresentation {
  const icon = ICONS[health.status];
  return {
    status: health.status,
    description: health.label,
    userMessage: health.userMessage ?? health.message,
    tooltipMarkdown: buildTooltip(health),
    iconId: icon.id,
    iconColor: icon.color,
    contextValue: `connection-${health.status}`,
    primaryAction: PRIMARY_ACTIONS[health.status],
    secondaryAction: "open-diagnostics",
  };
}

export function presentConnectionInfoItems(
  health: ConnectionHealth
): ConnectionInfoPresentation[] {
  const items: ConnectionInfoPresentation[] = [];

  if (health.toolCount > 0) {
    items.push({
      label: `${health.toolCount} tools available`,
      iconId: "tools",
    });
  }

  if (health.hiddenToolCount > 0) {
    items.push({
      label: `${health.hiddenToolCount} advanced tools hidden`,
      iconId: "shield",
    });
  }

  return items;
}

function buildTooltip(health: ConnectionHealth): string {
  const lines = [`**${health.label}**`, "", health.userMessage ?? health.message];

  if (health.toolCount > 0) {
    lines.push("", `${health.toolCount} tools available`);
  }

  if (health.hiddenToolCount > 0) {
    lines.push(`${health.hiddenToolCount} advanced tools hidden for safety`);
  }

  if (health.crashCount > 0) {
    lines.push("", `Restart attempts: ${health.restartCount}`);
  }

  return lines.join("\n");
}
