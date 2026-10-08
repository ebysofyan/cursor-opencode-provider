import { createAccountUsageCache, type AccountUsageCache, type BearerSource } from "./account-usage.js"
import { cursorUsageStoreBearer } from "./account-usage-tool.js"
import { toastBodyFromSnapshot } from "./account-usage-toast.js"

/**
 * OpenCode 1.x TUI plugin for the Cursor account usage slash command.
 *
 * The host loads a `{ id, tui }` module export and calls `tui(api)` with the
 * TUI plugin API (duck-typed exactly like the reference integration in
 * `opencode-codex-usage/tui.ts`): `command.register` for palette/slash
 * commands, `ui.toast` for display, `lifecycle.onDispose` for cleanup.
 *
 * This adapter holds no probe logic: it calls the shared account-usage core
 * (one cache instance backed by the durable-store bearer — the same source the
 * host's `getAuth()` reads) and renders whatever the pure toast formatter
 * returns. No polling, no timers, no background toasts; the command runs only
 * when selected, collapsed to one in-flight probe by the single-flight guard
 * (the cache adds per-credential dedupe beneath it).
 */

const TOAST_DURATION_MS = 8_000

export type TuiToast = {
  title?: string
  message: string
  variant?: "info" | "success" | "warning" | "error"
  duration?: number
}

export type CursorUsageTuiCommand = {
  title: string
  value: string
  description: string
  category: string
  slash: { name: string }
  onSelect: () => void
}

export type CursorUsageTuiApi = {
  command: {
    register: (commands: () => CursorUsageTuiCommand[]) => () => void
  }
  ui: {
    toast: (toast: TuiToast) => void
  }
  lifecycle: {
    onDispose: (dispose: () => void) => void
  }
}

export type CursorAccountUsageTuiPluginDeps = {
  /** Test seam; defaults to one shared-core cache over the durable-store bearer. */
  cache?: AccountUsageCache
  /**
   * Bearer for the default cache; ignored when `cache` is injected. Defaults
   * to the renewal-aware durable-store bearer (`cursorUsageStoreBearer`), the
   * same auth path the classic plugin's per-Run resolution uses.
   */
  bearer?: BearerSource
}

export function createCursorAccountUsageTuiPlugin(
  deps: CursorAccountUsageTuiPluginDeps = {},
): (api: CursorUsageTuiApi) => Promise<void> {
  return async (api: CursorUsageTuiApi): Promise<void> => {
    const cache = deps.cache ?? createAccountUsageCache({ bearer: deps.bearer ?? cursorUsageStoreBearer() })
    let running = false
    let registered: (() => void) | undefined

    const runProbe = async (): Promise<void> => {
      if (running) return
      running = true
      try {
        api.ui.toast({ ...toastBodyFromSnapshot(await cache.snapshot()), duration: TOAST_DURATION_MS })
      } catch {
        // The cache classifies probe failures into snapshots; a rejection here
        // is a bug or a broken formatter — surface the fixed phrase only.
        api.ui.toast({
          title: "Cursor usage",
          message: "unavailable (temporary error)",
          variant: "error",
          duration: TOAST_DURATION_MS,
        })
      } finally {
        running = false
      }
    }

    const unregister = api.command.register(() => [
      {
        title: "Cursor usage",
        value: "cursor-usage",
        description: "Show current Cursor account usage",
        category: "Cursor",
        slash: { name: "cursor-usage" },
        onSelect: () => {
          void runProbe()
        },
      },
    ])
    registered = unregister
    api.lifecycle.onDispose(() => {
      if (!registered) return
      registered = undefined
      unregister()
    })
  }
}

/** Host-facing module export: OpenCode 1.x loads `{ id, tui }`. */
export const cursorAccountUsageTuiPlugin = {
  id: "opencode-cursor-usage",
  tui: createCursorAccountUsageTuiPlugin(),
}

export default cursorAccountUsageTuiPlugin
