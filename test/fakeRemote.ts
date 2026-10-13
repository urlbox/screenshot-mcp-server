import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export const VALID_KEY = "ubx_org_test_key_123";

export interface FakeRemote {
  url: string;
  authHeaders: (string | undefined)[];
  close: () => Promise<void>;
}

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "urlbox", version: "9.9.9" },
    { instructions: "Fake Urlbox remote for tests." }
  );

  server.registerTool(
    "screenshot",
    {
      description: "Take a screenshot",
      inputSchema: { url: z.string() },
    },
    async ({ url }) => ({
      content: [{ type: "text", text: `screenshot of ${url}` }],
      structuredContent: { renderUrl: `https://renders.example/${encodeURIComponent(url)}.png` },
    })
  );

  server.registerTool(
    "fail_render",
    { description: "Always fails", inputSchema: { reason: z.string() } },
    async ({ reason }) => ({
      isError: true,
      content: [{ type: "text", text: `render failed: ${reason}` }],
    })
  );

  server.registerTool(
    "slow_render",
    { description: "Reports progress", inputSchema: {} },
    async (_args, extra) => {
      const token = extra._meta?.progressToken;
      if (token !== undefined) {
        for (let i = 1; i <= 3; i++) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: i, total: 3, message: `step ${i}` },
          });
          // Space updates out like a real render. The SDK client handles progress in a
          // microtask, so progress arriving in the same chunk as the result is dropped.
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return { content: [{ type: "text", text: "done" }] };
    }
  );

  server.registerPrompt(
    "capture_site",
    { description: "Capture a site", argsSchema: { url: z.string() } },
    ({ url }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Capture ${url}` } }],
    })
  );

  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** A stateless Streamable HTTP MCP server on a random port, with a bearer check. */
export async function startFakeRemote(): Promise<FakeRemote> {
  const authHeaders: (string | undefined)[] = [];
  const httpServer: Server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    authHeaders.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${VALID_KEY}`) {
      res
        .writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer resource_metadata="http://localhost/.well-known"',
        })
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Invalid API key" },
            id: null,
          })
        );
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const body = await readBody(req);
    const mcp = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    authHeaders,
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
  };
}

/** Serves a fixed PNG-ish payload, standing in for a render result URL. */
export async function startFileServer(payload: Buffer) {
  const httpServer = createServer((req, res) => {
    if (req.url === "/renders/shot.png") {
      res.writeHead(200, { "content-type": "image/png" }).end(payload);
    } else if (req.url === "/renders/noext") {
      res.writeHead(200, { "content-type": "application/pdf" }).end(payload);
    } else {
      res.writeHead(404).end("missing");
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
