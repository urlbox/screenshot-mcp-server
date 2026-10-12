#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RemoteConnectError, connectRemote, createBridgeServer } from "./bridge.js";
import { ConfigError, readConfig } from "./config.js";

// stdout carries the MCP protocol, so every diagnostic goes to stderr.
async function main() {
  const config = readConfig();
  const remote = await connectRemote(config);
  const server = createBridgeServer(remote, config);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => {});
    await remote.close().catch(() => {});
    process.exit(0);
  };
  server.onclose = () => void shutdown();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await server.connect(new StdioServerTransport());
  console.error(`Urlbox MCP bridge running on stdio, connected to ${config.mcpUrl.origin}`);
}

main().catch((error) => {
  if (error instanceof ConfigError || error instanceof RemoteConnectError) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error("Fatal error:", error instanceof Error ? error.message : error);
  }
  process.exit(1);
});
