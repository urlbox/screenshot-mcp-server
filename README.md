# Urlbox MCP Server

[![image](urlbox-graphic.jpg)](https://urlbox.com)

Give your AI assistant a real browser. The [Urlbox](https://urlbox.com) MCP server takes screenshots, makes PDFs and videos, extracts HTML, markdown and article text, compares pages, and manages your Urlbox projects, webhooks and usage.

## Use the hosted server (recommended)

Connect your client to `https://api.urlbox.com/mcp`. Nothing to install.

- **Claude** (claude.ai and desktop): Settings, Connectors, Add custom connector, enter `https://api.urlbox.com/mcp`, then sign in to Urlbox.
- **ChatGPT**: add a connector with the URL `https://api.urlbox.com/mcp`, then sign in to Urlbox.
- **Claude Code**: `claude mcp add --transport http urlbox https://api.urlbox.com/mcp`, then run `/mcp` to sign in.
- **Codex**: `codex mcp add urlbox --url https://api.urlbox.com/mcp --bearer-token-env-var URLBOX_API_KEY`
- **Cursor**: add this to `~/.cursor/mcp.json`:

  ```json
  {
    "mcpServers": {
      "urlbox": {
        "url": "https://api.urlbox.com/mcp",
        "headers": { "Authorization": "Bearer YOUR_URLBOX_API_KEY" }
      }
    }
  }
  ```

Clients that can't sign in can send an API key as `Authorization: Bearer <key>`. An organisation API key (`ubx_org_...`) unlocks every tool. A project secret key works for the rendering tools only. Find your keys in the [Urlbox dashboard](https://urlbox.com/dashboard).

## Local bridge (this package)

Some clients can only start local servers. This package is a small local bridge: it runs on your machine over stdio and forwards everything to the hosted server, so you get exactly the same tools, always up to date.

```json
{
  "mcpServers": {
    "urlbox": {
      "command": "npx",
      "args": ["-y", "@urlbox/screenshot-mcp"],
      "env": {
        "URLBOX_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Requires Node.js 20 or later.

| Variable | Description |
| --- | --- |
| `URLBOX_API_KEY` | Your organisation API key or project secret key. |
| `SECRET_KEY` | Also accepted, for configs written for 1.x. `URLBOX_API_KEY` wins if both are set. |
| `URLBOX_DOWNLOAD_DIR` | Where `save_render` saves files. Defaults to `~/Downloads`. |

The bridge adds one local tool, `save_render`, which downloads a render URL returned by any Urlbox tool and saves it to your computer. Just ask, for example "screenshot example.com and save it to my computer". Existing files are never overwritten.

## Upgrading from 1.x

Your existing config keeps working: `SECRET_KEY` is still read and the package name and command are unchanged.

- Tools now come from the hosted server, so there are many more of them, and they keep improving without an update.
- `render` is still there. Its `store_renders` option and the `download` tool are replaced by `save_render`.
- Files are saved to `~/Downloads` instead of `~/Downloads/urlbox-renders`. Set `URLBOX_DOWNLOAD_DIR` to keep the old location.
- With a project secret key you get the rendering tools. Use an organisation API key to also manage projects, webhooks and usage.
- Node.js 20 or later is required.

## Example prompts

- Take a screenshot of https://example.com without ads or cookie banners.
- Save https://urlbox.com as a tagged PDF with an outline and download it to my computer.
- Turn this article into markdown: https://example.com/blog/post
- How does https://example.com look on a phone?

## Development

```bash
npm install
npm test
```

The tests run the bridge against a local fake server, so they need no Urlbox account.

## License

MIT
