import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  CompleteRequestSchema,
  CompleteResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  LoggingMessageNotificationSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  type ServerCapabilities,
  type ServerNotification,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { SAVE_RENDER_TOOL_NAME, saveRender, saveRenderTool } from "./saveRender.js";
import { VERSION } from "./version.js";

/** Renders can run for minutes; progress notifications from the remote reset this. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const USER_AGENT = `urlbox-screenshot-mcp/${VERSION}`;

export class RemoteConnectError extends Error {}

/** Connects an MCP client to the hosted Urlbox server, sending the key as a bearer token. */
export async function connectRemote(config: Config): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(config.mcpUrl, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "User-Agent": USER_AGENT,
      },
    },
  });
  const client = new Client({ name: "urlbox-screenshot-mcp", version: VERSION });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => {});
    if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
      throw new RemoteConnectError(
        `Urlbox rejected the API key (HTTP ${error.code}). Check URLBOX_API_KEY or SECRET_KEY.`
      );
    }
    throw new RemoteConnectError(
      `Could not connect to the Urlbox MCP server at ${config.mcpUrl.href}: ${(error as Error).message}`
    );
  }
  return client;
}

type Extra = {
  signal: AbortSignal;
  sendNotification: (notification: ServerNotification) => Promise<void>;
};

type ForwardableParams = { _meta?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Prepares a downstream request for the remote: drops the downstream progress
 * token (the SDK client assigns its own) and relays remote progress back
 * under the token the downstream client asked for.
 */
function forward<P extends ForwardableParams | undefined>(
  params: P,
  extra: Extra
): { params: P; options: RequestOptions; flush: () => Promise<void> } {
  const progressToken = params?._meta?.progressToken as string | number | undefined;
  let outParams = params;
  if (params?._meta && "progressToken" in params._meta) {
    const { progressToken: _dropped, ...meta } = params._meta;
    outParams = { ...params, _meta: Object.keys(meta).length > 0 ? meta : undefined };
  }
  const options: RequestOptions = {
    signal: extra.signal,
    timeout: REQUEST_TIMEOUT_MS,
    resetTimeoutOnProgress: true,
  };
  // Progress is relayed in order, and flushed before the result is returned,
  // so the downstream client never sees progress after the response.
  let pending: Promise<void> = Promise.resolve();
  if (progressToken !== undefined) {
    options.onprogress = (progress) => {
      pending = pending.then(() =>
        extra
          .sendNotification({
            method: "notifications/progress",
            params: { ...progress, progressToken },
          })
          .catch(() => {})
      );
    };
  }
  return { params: outParams, options, flush: () => pending };
}

/** Keeps JSON-RPC errors from the remote intact; wraps transport failures. */
function asMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
    return new McpError(
      ErrorCode.InvalidRequest,
      `Urlbox rejected the API key (HTTP ${error.code}). Check URLBOX_API_KEY or SECRET_KEY.`
    );
  }
  return new McpError(
    ErrorCode.InternalError,
    `Urlbox MCP request failed: ${error instanceof Error ? error.message : String(error)}`
  );
}

async function relay<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw asMcpError(error);
  }
}

/**
 * Builds the local stdio-facing server. Every tool, prompt and resource is
 * listed and served by the remote; only `save_render` runs locally.
 */
export function createBridgeServer(remote: Client, config: Config): Server {
  const remoteCaps: ServerCapabilities = remote.getServerCapabilities() ?? {};
  const remoteInfo = remote.getServerVersion();

  const capabilities: ServerCapabilities = {
    tools: { listChanged: remoteCaps.tools?.listChanged ?? false },
  };
  if (remoteCaps.prompts) capabilities.prompts = { listChanged: remoteCaps.prompts.listChanged };
  if (remoteCaps.resources) {
    capabilities.resources = { listChanged: remoteCaps.resources.listChanged };
  }
  if (remoteCaps.completions) capabilities.completions = {};
  if (remoteCaps.logging) capabilities.logging = {};

  const server = new Server(
    { name: remoteInfo?.name ?? "urlbox", title: remoteInfo?.title ?? "Urlbox", version: VERSION },
    { capabilities, instructions: remote.getInstructions() }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const { params, options } = forward(request.params, extra);
    const result = await relay(() =>
      remote.request({ method: "tools/list", params }, ListToolsResultSchema, options)
    );
    // Append the local tool to the first page, unless the remote already has one by that name.
    if (!request.params?.cursor && !result.tools.some((t) => t.name === SAVE_RENDER_TOOL_NAME)) {
      result.tools.push(saveRenderTool);
    }
    return result;
  });

  let remoteHasSaveRender: boolean | undefined;
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === SAVE_RENDER_TOOL_NAME) {
      if (remoteHasSaveRender === undefined) {
        const listed = await relay(() => remote.listTools(undefined, { signal: extra.signal }));
        remoteHasSaveRender = listed.tools.some((t) => t.name === SAVE_RENDER_TOOL_NAME);
      }
      if (!remoteHasSaveRender) {
        return saveRender(request.params.arguments, config.downloadDir, extra.signal);
      }
    }
    const { params, options, flush } = forward(request.params, extra);
    // Use request() rather than callTool() so results pass through untouched,
    // without client-side output schema validation.
    const result = await relay(() =>
      remote.request({ method: "tools/call", params }, CallToolResultSchema, options)
    );
    await flush();
    return result;
  });

  if (remoteCaps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request, extra) => {
      const { params, options } = forward(request.params, extra);
      return relay(() =>
        remote.request({ method: "prompts/list", params }, ListPromptsResultSchema, options)
      );
    });
    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      const { params, options } = forward(request.params, extra);
      return relay(() =>
        remote.request({ method: "prompts/get", params }, GetPromptResultSchema, options)
      );
    });
  }

  if (remoteCaps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
      const { params, options } = forward(request.params, extra);
      return relay(() =>
        remote.request({ method: "resources/list", params }, ListResourcesResultSchema, options)
      );
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) => {
      const { params, options } = forward(request.params, extra);
      return relay(() =>
        remote.request(
          { method: "resources/templates/list", params },
          ListResourceTemplatesResultSchema,
          options
        )
      );
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const { params, options } = forward(request.params, extra);
      return relay(() =>
        remote.request({ method: "resources/read", params }, ReadResourceResultSchema, options)
      );
    });
  }

  if (remoteCaps.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
      const { params, options } = forward(request.params, extra);
      return relay(() =>
        remote.request({ method: "completion/complete", params }, CompleteResultSchema, options)
      );
    });
  }

  // Relay list_changed and log notifications from the remote, when it sends them.
  remote.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    remoteHasSaveRender = undefined;
    await server.sendToolListChanged().catch(() => {});
  });
  remote.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
    if (remoteCaps.prompts) await server.sendPromptListChanged().catch(() => {});
  });
  remote.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
    if (remoteCaps.resources) await server.sendResourceListChanged().catch(() => {});
  });
  remote.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
    if (remoteCaps.logging) await server.sendLoggingMessage(notification.params).catch(() => {});
  });

  return server;
}
