import * as cp from "child_process";
import type { ConnectionDefinition } from "@mcp-proxy/shared";

export interface DependencyResult {
  installed: boolean;
  version?: string;
  error?: string;
}

/**
 * DependencyChecker runs a connection's installCheck.checkCommand in a shell
 * and reports whether the required tool is present and meets the minimum version.
 *
 * This runs in the extension host (before gateway config is pushed) so that
 * the extension can set a healthOverride of `dependency_missing` when the
 * required tooling isn't installed, rather than letting the gateway attempt
 * to spawn a process that immediately crashes.
 */
export class DependencyChecker {
  async check(definition: ConnectionDefinition): Promise<DependencyResult> {
    const check = definition.installCheck;
    if (!check) return { installed: true };

    try {
      const output = await exec(check.checkCommand);
      const version = this.parseVersion(output);
      const meetsMin = this.meetsMinVersion(version, check.minVersion);

      if (!meetsMin) {
        return {
          installed: false,
          version,
          error: `Found ${version} but ${check.minVersion} is required`,
        };
      }

      return { installed: true, version };
    } catch (err) {
      return {
        installed: false,
        error: String(err),
      };
    }
  }

  private parseVersion(output: string): string {
    const match = output.match(/v?(\d+\.\d+[\.\d]*)/);
    return match ? match[1] : output.trim().split("\n")[0];
  }

  private meetsMinVersion(
    version: string | undefined,
    minVersion: string | undefined
  ): boolean {
    if (!minVersion || !version) return true;
    const toNum = (v: string) =>
      v.split(".").map((p) => parseInt(p, 10) || 0);
    const [av, bv] = [toNum(version), toNum(minVersion)];
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      const a = av[i] ?? 0;
      const b = bv[i] ?? 0;
      if (a > b) return true;
      if (a < b) return false;
    }
    return true;
  }
}

function exec(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(command, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout || stderr);
    });
  });
}
