import {
  accountUsageRpcContract,
  type AccountUsageRpcHandlers,
} from "../account-usage-rpc.js"
import {
  toastBodyFromSnapshot,
  type UsageToast,
} from "../account-usage-toast.js"
import type { CursorAccountUsageSnapshot } from "../account-usage.js"

export const CURSOR_ACCOUNT_USAGE_TUI_COMMAND = {
  id: "cursor_usage",
  slash: "cursor-usage",
  title: "Cursor usage",
  description: "Show current Cursor account usage",
  group: "Cursor",
  // No `bind`: the ctrl+x u chord collides with a host binding. Slash and
  // palette registration stay; the command remains keyboard-reachable there.
} as const

const TOAST_DURATION_MS = 8_000
const TRANSIENT_UNAVAILABLE = "unavailable (temporary error)"

type KeymapCommand = {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly group: string
  readonly palette: boolean
  readonly slash: { readonly name: string }
  readonly run: () => Promise<void>
}

type KeymapLayer = {
  readonly mode: string
  readonly priority: number
  readonly bindings: readonly string[]
  readonly commands: readonly KeymapCommand[]
}

/**
 * Duck-typed OpenCode 2.0 TUI plugin context (mirrors the reference
 * integration's `opencode2-tui.ts`): the TUI process owns a client proxy, a
 * keymap layer, and toast/slot UI. It has no integration domain, no auth
 * store, and no fetch — all account data arrives via the server RPC.
 */
export type CursorUsageTuiContext = {
  readonly client: {
    readonly rpc: (
      contract: typeof accountUsageRpcContract,
    ) => AccountUsageRpcHandlers
  }
  readonly keymap: {
    readonly layer: (factory: () => KeymapLayer) => unknown
  }
  readonly ui: {
    readonly slot: (options: { append: string; render: () => null }) => unknown
    readonly toast: { readonly show: (toast: UsageToast & { duration: number }) => void }
  }
}

/**
 * `/cursor-usage` for OpenCode 2.0: install the slash command, then answer
 * every invocation by calling the server plugin's `usage` RPC and showing the
 * shared toast rendering. No auth, no fetch, no auth-store import here —
 * duplicating the probe in the TUI process would bypass the host credential
 * path and the single shared cache.
 */
/** Releases the slot and keymap registrations installed by setup. */
export type CursorUsageTuiDispose = () => void

/** A host primitive may hand back a disposer; anything else is ignored. */
function toDisposer(value: unknown): (() => void) | undefined {
  return typeof value === "function" ? (value as () => void) : undefined
}

export function CursorAccountUsageOpenCode2TuiPlugin(context: CursorUsageTuiContext): CursorUsageTuiDispose {
  let running = false
  let disposeSlot: (() => void) | undefined
  let disposeLayer: (() => void) | undefined

  const usage = context.client.rpc(accountUsageRpcContract).usage
  const showToast = (toast: UsageToast): void => {
    context.ui.toast.show({ ...toast, duration: TOAST_DURATION_MS })
  }

  const runProbe = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const snapshot = await usage({}) as CursorAccountUsageSnapshot
      showToast(toastBodyFromSnapshot(snapshot))
    } catch {
      // The RPC failure is a transport/protocol fact, not upstream text: show
      // the classified transient phrase only.
      showToast(toastBodyFromSnapshot({
        status: "transient",
        fetchedAtMs: Date.now(),
        error: TRANSIENT_UNAVAILABLE,
      }))
    } finally {
      running = false
    }
  }

  const slot = context.ui.slot({
    append: "app",
    render: () => {
      disposeLayer = toDisposer(context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        bindings: [CURSOR_ACCOUNT_USAGE_TUI_COMMAND.id],
        commands: [
          {
            id: CURSOR_ACCOUNT_USAGE_TUI_COMMAND.id,
            title: CURSOR_ACCOUNT_USAGE_TUI_COMMAND.title,
            description: CURSOR_ACCOUNT_USAGE_TUI_COMMAND.description,
            group: CURSOR_ACCOUNT_USAGE_TUI_COMMAND.group,
            palette: true,
            slash: { name: CURSOR_ACCOUNT_USAGE_TUI_COMMAND.slash },
            run: () => runProbe(),
          },
        ],
      })))
      return null
    },
  })
  disposeSlot = toDisposer(slot)
  return () => {
    disposeLayer?.()
    disposeSlot?.()
    disposeLayer = undefined
    disposeSlot = undefined
  }
}

// Plain { id, setup } — the repo duck-types the 2.0 host and must not import
// `@opencode/plugin`.
export default {
  id: "opencode-cursor-usage",
  setup: CursorAccountUsageOpenCode2TuiPlugin,
}
