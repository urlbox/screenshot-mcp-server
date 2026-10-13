# Changelog

## 2.0.0

### Breaking changes

- The package is now a local bridge to the hosted Urlbox MCP server at `https://api.urlbox.com/mcp`. Every hosted tool, prompt and resource is available locally, with the hosted names, and new tools arrive without a package update.
- The 1.x `render` tool's `store_renders` option and the `download` tool are replaced by `save_render`, a local tool that saves any render URL to disk.
- Files are saved to `~/Downloads` by default (was `~/Downloads/urlbox-renders`). Set `URLBOX_DOWNLOAD_DIR` to change it.
- Requires Node.js 20 or later.

### Added

- `URLBOX_API_KEY` for organisation API keys or project secret keys. `SECRET_KEY` keeps working.
- Progress updates from long renders are passed through to your client.
- A clear startup error when no key is set or the key is rejected.
- `server.json` for the MCP Registry.

## 1.0.3

- Local `render` and `download` tools calling the Urlbox render API.
