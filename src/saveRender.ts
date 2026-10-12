import { mkdir, open, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export const SAVE_RENDER_TOOL_NAME = "save_render";

export const saveRenderTool: Tool = {
  name: SAVE_RENDER_TOOL_NAME,
  title: "Save render to disk",
  description:
    "Download a file from a URL returned by another Urlbox tool (for example a screenshot, PDF, " +
    "video, HTML or markdown render URL) and save it on this computer. Returns the saved file path. " +
    "Files go to the user's download folder unless they configured a different one.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The http(s) URL of the render result to download.",
      },
      filename: {
        type: "string",
        description:
          "Optional file name, without any directory. Defaults to the name in the URL. " +
          "An existing file is never overwritten; a number is added instead.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the saved file." },
      bytes: { type: "number", description: "Size of the saved file in bytes." },
    },
    required: ["path", "bytes"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "application/json": ".json",
  "multipart/related": ".mhtml",
  "application/x-mimearchive": ".mhtml",
};

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Keeps only a safe base name: no directories, no control or reserved characters. */
function sanitizeFilename(name: string): string {
  const base = basename(name.replace(/\\/g, "/"))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters on purpose
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return base.slice(0, 200);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pickFilename(url: URL, contentType: string | null, requested?: string): string {
  let name = requested ? sanitizeFilename(requested) : "";
  if (!name) {
    const fromPath = sanitizeFilename(safeDecode(url.pathname.split("/").pop() ?? ""));
    name = fromPath || `urlbox-render-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  }
  if (!extname(name)) {
    const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
    name += EXTENSIONS[mime] ?? "";
  }
  return name;
}

/** Opens a new file exclusively, adding " (n)" before the extension if the name is taken. */
async function openUnique(dir: string, name: string) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const path = join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      return { path, handle: await open(path, "wx") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not find a free file name for ${name} in ${dir}`);
}

export async function saveRender(
  args: Record<string, unknown> | undefined,
  downloadDir: string,
  signal?: AbortSignal
): Promise<CallToolResult> {
  const rawUrl = args?.url;
  const filename = args?.filename;
  if (typeof rawUrl !== "string" || !rawUrl) {
    return errorResult("save_render needs a `url` argument.");
  }
  if (filename !== undefined && typeof filename !== "string") {
    return errorResult("`filename` must be a string.");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return errorResult(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return errorResult("Only http and https URLs can be saved.");
  }

  let response: Response;
  try {
    response = await fetch(url, { signal, redirect: "follow" });
  } catch (error) {
    return errorResult(`Could not download ${url.href}: ${(error as Error).message}`);
  }
  if (!response.ok || !response.body) {
    return errorResult(`Could not download ${url.href}: HTTP ${response.status}`);
  }

  const name = pickFilename(url, response.headers.get("content-type"), filename);
  let saved: { path: string; handle: Awaited<ReturnType<typeof open>> };
  try {
    await mkdir(downloadDir, { recursive: true });
    saved = await openUnique(downloadDir, name);
  } catch (error) {
    await response.body.cancel().catch(() => {});
    return errorResult(`Could not create a file in ${downloadDir}: ${(error as Error).message}`);
  }

  let bytes: number;
  try {
    const source = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    await pipeline(source, saved.handle.createWriteStream(), { signal });
    bytes = (await stat(saved.path)).size;
  } catch (error) {
    await saved.handle.close().catch(() => {});
    await unlink(saved.path).catch(() => {});
    return errorResult(`Download of ${url.href} failed: ${(error as Error).message}`);
  }

  return {
    content: [{ type: "text", text: `Saved ${bytes} bytes to ${saved.path}` }],
    structuredContent: { path: saved.path, bytes },
  };
}
