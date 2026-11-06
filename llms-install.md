# Installing the Urlbox MCP server

Urlbox gives the agent full-page screenshots, PDFs and Markdown of any site, including bot-protected ones.

1. The user needs a Urlbox account and an organisation API key from https://urlbox.com/dashboard. Ask them for it; never invent one.
2. Add this to the MCP settings (for Cline, `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "urlbox": {
      "command": "npx",
      "args": ["-y", "@urlbox/screenshot-mcp"],
      "env": { "URLBOX_API_KEY": "<the user's key>" }
    }
  }
}
```

3. This needs Node.js 20 or later. Restart the server and check that tools such as `screenshot` and `pdf` are listed. If it exits with "Urlbox rejected the API key", the key is wrong.
4. Without Node: connect to `https://api.urlbox.com/mcp` (streamable HTTP) and sign in with the Urlbox account, or send the key as `Authorization: Bearer <key>`.

Renders count against the user's Urlbox plan.
