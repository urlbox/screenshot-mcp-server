import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type Progress } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeRemote, VALID_KEY, startFakeRemote, startFileServer } from "./fakeRemote.js";

const ENTRY = resolve(import.meta.dirname, "../dist/index.js");

/** Minimal env so the child never sees real Urlbox keys from the developer's shell. */
function baseEnv(extra: Record<string, string>): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra };
}

async function connectBridge(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: baseEnv(env),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

function runBridge(env: Record<string, string>) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((done) => {
    const child = spawn(process.execPath, [ENTRY], { env: baseEnv(env) });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.on("close", (code) => done({ code, stderr, stdout }));
  });
}

describe("stdio bridge to the remote MCP server", () => {
  let remote: FakeRemote;
  let client: Client;
  let stderr: () => string;
  let files: Awaited<ReturnType<typeof startFileServer>>;
  let downloadDir: string;
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

  beforeAll(async () => {
    remote = await startFakeRemote();
    files = await startFileServer(payload);
    downloadDir = await mkdtemp(join(tmpdir(), "urlbox-mcp-test-"));
    ({ client, stderr } = await connectBridge({
      SECRET_KEY: VALID_KEY,
      URLBOX_MCP_URL: remote.url,
      URLBOX_DOWNLOAD_DIR: downloadDir,
    }));
  });

  afterAll(async () => {
    await client?.close();
    await remote?.close();
    await files?.close();
    if (downloadDir) await rm(downloadDir, { recursive: true, force: true });
  });

  it("mirrors the remote server's identity and instructions", () => {
    expect(client.getServerVersion()?.name).toBe("urlbox");
    expect(client.getInstructions()).toBe("Fake Urlbox remote for tests.");
    expect(client.getServerCapabilities()?.prompts).toBeDefined();
  });

  it("lists the remote tools with their exact names, plus save_render", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "screenshot",
      "fail_render",
      "slow_render",
      "save_render",
    ]);
    const screenshot = tools.find((t) => t.name === "screenshot");
    expect(screenshot?.inputSchema.properties).toHaveProperty("url");
  });

  it("sends the key as a bearer token on every remote request", () => {
    expect(remote.authHeaders.length).toBeGreaterThan(0);
    for (const header of remote.authHeaders) {
      expect(header).toBe(`Bearer ${VALID_KEY}`);
    }
  });

  it("calls remote tools and returns their results untouched", async () => {
    const result = await client.callTool({
      name: "screenshot",
      arguments: { url: "https://example.com" },
    });
    expect(result.content).toEqual([{ type: "text", text: "screenshot of https://example.com" }]);
    expect(result.structuredContent).toEqual({
      renderUrl: "https://renders.example/https%3A%2F%2Fexample.com.png",
    });
  });

  it("passes tool errors through faithfully", async () => {
    const result = await client.callTool({ name: "fail_render", arguments: { reason: "blocked" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "render failed: blocked" }]);
  });

  it("passes protocol errors (unknown tool, bad arguments) through", async () => {
    const unknown = await client
      .callTool({ name: "no_such_tool", arguments: {} })
      .catch((e: Error) => e);
    const unknownText = unknown instanceof Error ? unknown.message : JSON.stringify(unknown);
    expect(unknownText).toContain("no_such_tool");
  });

  it("forwards progress notifications", async () => {
    const seen: Progress[] = [];
    const result = await client.request(
      { method: "tools/call", params: { name: "slow_render", arguments: {} } },
      CallToolResultSchema,
      { onprogress: (p) => seen.push(p) }
    );
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(seen.map((p) => p.progress)).toEqual([1, 2, 3]);
    expect(seen[2]?.message).toBe("step 3");
  });

  it("forwards prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["capture_site"]);
    const prompt = await client.getPrompt({
      name: "capture_site",
      arguments: { url: "https://a.example" },
    });
    expect(prompt.messages[0]?.content).toEqual({
      type: "text",
      text: "Capture https://a.example",
    });
  });

  it("save_render downloads a render URL into the download directory", async () => {
    const result = await client.callTool({
      name: "save_render",
      arguments: { url: `${files.baseUrl}/renders/shot.png` },
    });
    expect(result.isError).toBeFalsy();
    const saved = result.structuredContent as { path: string; bytes: number };
    expect(saved.path).toBe(join(downloadDir, "shot.png"));
    expect(saved.bytes).toBe(payload.length);
    expect(await readFile(saved.path)).toEqual(payload);

    // A second save never overwrites the first.
    const again = await client.callTool({
      name: "save_render",
      arguments: { url: `${files.baseUrl}/renders/shot.png` },
    });
    expect((again.structuredContent as { path: string }).path).toBe(
      join(downloadDir, "shot (1).png")
    );
  });

  it("save_render names files from the content type and ignores directories in filename", async () => {
    const fromType = await client.callTool({
      name: "save_render",
      arguments: { url: `${files.baseUrl}/renders/noext` },
    });
    expect((fromType.structuredContent as { path: string }).path).toBe(
      join(downloadDir, "noext.pdf")
    );

    const escaped = await client.callTool({
      name: "save_render",
      arguments: { url: `${files.baseUrl}/renders/shot.png`, filename: "../../evil.png" },
    });
    expect((escaped.structuredContent as { path: string }).path).toBe(
      join(downloadDir, "evil.png")
    );
    expect((await readdir(downloadDir)).sort()).toEqual([
      "evil.png",
      "noext.pdf",
      "shot (1).png",
      "shot.png",
    ]);
  });

  it("save_render reports download failures as tool errors", async () => {
    const result = await client.callTool({
      name: "save_render",
      arguments: { url: `${files.baseUrl}/renders/missing.png` },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("HTTP 404");
  });

  it("never writes the key to stderr", () => {
    expect(stderr()).toContain("running on stdio");
    expect(stderr()).not.toContain(VALID_KEY);
  });
});

describe("startup errors", () => {
  let remote: FakeRemote;

  beforeAll(async () => {
    remote = await startFakeRemote();
  });

  afterAll(async () => {
    await remote?.close();
  });

  it("exits with a clear message when no key is set", async () => {
    const { code, stderr, stdout } = await runBridge({ URLBOX_MCP_URL: remote.url });
    expect(code).toBe(1);
    expect(stderr).toContain("No Urlbox API key found");
    expect(stderr).toContain("URLBOX_API_KEY");
    expect(stdout).toBe("");
  });

  it("accepts URLBOX_API_KEY and prefers it over SECRET_KEY", async () => {
    remote.authHeaders.length = 0;
    const { client } = await connectBridge({
      URLBOX_API_KEY: VALID_KEY,
      SECRET_KEY: "old-project-key",
      URLBOX_MCP_URL: remote.url,
    });
    await client.listTools();
    await client.close();
    expect(remote.authHeaders).toContain(`Bearer ${VALID_KEY}`);
    expect(remote.authHeaders).not.toContain("Bearer old-project-key");
  });

  it("exits with a clear message when the key is rejected, without printing it", async () => {
    const badKey = "ubx_org_wrong_key_456";
    const { code, stderr } = await runBridge({
      URLBOX_API_KEY: badKey,
      URLBOX_MCP_URL: remote.url,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("Urlbox rejected the API key (HTTP 401)");
    expect(stderr).not.toContain(badKey);
  });
});
