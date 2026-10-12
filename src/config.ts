import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_MCP_URL = "https://api.urlbox.com/mcp";

export interface Config {
  apiKey: string;
  mcpUrl: URL;
  downloadDir: string;
}

export class ConfigError extends Error {}

/**
 * Reads the bridge configuration from the environment.
 *
 * URLBOX_API_KEY takes precedence over SECRET_KEY (the 1.x variable), so a
 * 1.x config keeps working unchanged and a newer config can use either name.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = (env.URLBOX_API_KEY || env.SECRET_KEY || "").trim();
  if (!apiKey) {
    throw new ConfigError(
      "No Urlbox API key found. Set URLBOX_API_KEY to an organisation API key (ubx_org_...) " +
        "or a project secret key, or set SECRET_KEY as in 1.x. " +
        "Find your keys at https://urlbox.com/dashboard."
    );
  }

  const rawUrl = env.URLBOX_MCP_URL?.trim() || DEFAULT_MCP_URL;
  let mcpUrl: URL;
  try {
    mcpUrl = new URL(rawUrl);
  } catch {
    throw new ConfigError(`URLBOX_MCP_URL is not a valid URL: ${rawUrl}`);
  }
  if (mcpUrl.protocol !== "https:" && mcpUrl.protocol !== "http:") {
    throw new ConfigError(`URLBOX_MCP_URL must be an http(s) URL: ${rawUrl}`);
  }

  const downloadDir = resolveHome(env.URLBOX_DOWNLOAD_DIR?.trim() || join(homedir(), "Downloads"));

  return { apiKey, mcpUrl, downloadDir };
}

function resolveHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}
