# OpenCode 1.x

Classic OpenCode and the 1.18 Effect/Promise **v2** plugin API. For OpenCode 2.0, see [opencode-2.md](./opencode-2.md). Shared catalog behavior (variants, 1M, Fast, images) lives in the [root README](../README.md#select-a-model).

## From npm

OpenCode installs npm plugins with Bun at startup (cached under `~/.cache/opencode/node_modules/`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["cursor-opencode-provider"],
  "provider": {
    "cursor": {
      "npm": "cursor-opencode-provider",
      "name": "Cursor",
      "models": {}
    }
  }
}
```

Pin a version if you want: `"cursor-opencode-provider@0.4.1"`.

You can also install it yourself first:

```bash
npm install cursor-opencode-provider
# or: bun add cursor-opencode-provider
```

If the `cursor` provider block is omitted, the classic plugin auto-registers it on startup (as **Cursor Integration**) using this package's entry. Model entries come from the local cache, which is filled after auth and again on startup when the cache is empty but credentials remain.

## From a local clone

```bash
git clone https://github.com/oakimov/cursor-opencode-provider.git
cd cursor-opencode-provider
bun install
bun run build
```

Point classic OpenCode config at the built files with absolute `file://` URLs:

```json
{
  "plugin": ["file:///absolute/path/to/cursor-opencode-provider/dist/plugin.js"],
  "provider": {
    "cursor": {
      "npm": "file:///absolute/path/to/cursor-opencode-provider/dist/index.js",
      "name": "Cursor",
      "models": {}
    }
  }
}
```

OpenCode does not install dependencies for a copied-out plugin file. Load the plugin from inside the clone so `protobufjs` resolves. Rebuild (`bun run build`) after every change; the host reads `dist/`, not `src/`.

## 1.18 v2 plugin API

For OpenCode builds that use the Effect/Promise **v2** plugin API (`plugins` field), also load:

```json
{
  "plugins": ["cursor-opencode-provider/plugin/v2"]
}
```

Local clone equivalent: `"file:///absolute/path/to/cursor-opencode-provider/dist/plugin-v2.js"`.

That entry registers the provider via `ctx.aisdk.sdk` / `ctx.aisdk.language`. Keep the classic `plugin` entry for auth **and** plugin tools (notably `cursor_image_save` / `custom_websearch`): the 1.18 `/v2/promise` API has no `tool` domain, so a v2-only load silently disables Cursor image generation.

Do **not** load `cursor-opencode-provider/plugin/opencode2` under OpenCode 1.x. That entrypoint is OpenCode 2.0 only.

OpenCode 1.18 prefers `package.json` `exports["./server"]` when resolving a package-dir plugin. That subpath is the OpenCode 2 module, but it dual-exports `server: CursorPlugin`, so classic 1.x hooks still run. Keep using `"plugin": ["cursor-opencode-provider"]` or `/plugin` — do not point 1.x config at `/plugin/opencode2` for its `setup()` API.

## Authenticate

```bash
opencode auth login
```

Choose the **cursor** provider, then browser login (PKCE) or an API key (`crsr_...` from [cursor.com/settings](https://cursor.com/settings)). After login, the plugin fetches available models into `<host-cache>/cursor-models.json`.

## Select a model

```bash
opencode run --model cursor/composer-2.5 "Hello from Cursor via OpenCode"
```

Variant, long-context, Fast, image, and Max Mode behavior is the same on every host — see [Select a model](../README.md#select-a-model) in the root README.

## Account usage

The classic plugin registers a read-only `cursor_usage` tool (no arguments). Calling it — or asking the model about your Cursor usage — returns the current billing-period summary: Included / Auto / API / on-demand rows with dollar amounts and percent-used bars, the cycle reset date, and a link to the [usage dashboard](https://cursor.com/dashboard?tab=usage). The probe uses your existing Cursor login; it is read-only and does not change per-message context/token accounting.

For a quick check without spending a model turn, `/cursor-usage` shows the same summary as a TUI toast (warning at ≥75%, error at ≥90% of the highest row). There is no background polling: the probe runs only when the command is selected or the tool is called, and repeated calls within 60 seconds reuse the cached result. Without a Cursor login both surfaces report `unavailable (auth required)`.

The classic `plugin` entry alone registers only the tool; the slash command needs a separate TUI plugin entry in `~/.config/opencode/tui.json`:

```jsonc
{
  "plugin": ["cursor-opencode-provider/tui"]
}
```

Local-clone equivalent: `"file:///absolute/path/to/cursor-opencode-provider/dist/plugin-tui.js"`. Restart OpenCode and run `/cursor-usage` from the command palette.

> **Live-check note:** which OpenCode 1.x config file accepts a `{ id, tui }` TUI export (spec risk R3) is grounded here against the `opencode-codex-usage` reference installer, which writes its `{ id, tui }` TUI entry into `tui.json`'s `plugin` array (`resolveTuiConfigPath` in its `lib/codex-usage-cli.ts`). This repo has not yet recorded its own O1 load test: if `/cursor-usage` does not appear after a restart, also add `"cursor-opencode-provider/tui"` to the `opencode.json` `plugin` array and record which file accepted it.

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| No Cursor models in the picker | Confirm Cursor auth (`opencode auth login` → **cursor**). Restart OpenCode — if auth is present and the cache is empty, models are fetched on startup. Confirm `provider.cursor.npm` is the package name (or a built `file://…/dist/index.js`). |
| Empty or stale model list | Delete `<host-cache>/cursor-models.json` (default `~/.cache/opencode/`) and restart. Existing Cursor auth is enough to refill the cache. |
| Image save / web search missing | You loaded v2 without the classic `plugin` entry. Keep both. |
| `401` / "sign in to Cursor again" | A browser login renews itself through Cursor's `/oauth/token` and is saved back to `auth.json`; an API-key login re-exchanges its stored key. Run `opencode auth login` → **cursor** again when the error says the session was ended, the key was rejected, or the login was saved without its key (API-key logins made before the key was kept in `metadata.apiKey`). |
