import { accountUsageRpcContract } from "./account-usage-rpc-contract.js"
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
    /**
     * Structural shape of the host's RPC subclient, not this contract's exact
     * handler type. The host types `client.rpc` as returning an index
     * signature, and TypeScript will not assign an index signature to a type
     * with required members — so naming `AccountUsageRpcHandlers` here would
     * make this context unassignable from the real host context and force the
     * compile-time conformance check in `test/opencode2-conformance.types.ts`
     * to cast. The value is narrowed at the call site instead.
     */
    readonly rpc: (
      contract: typeof accountUsageRpcContract,
    ) => {
      readonly [method: string]: (input: any) => Promise<unknown>
    }
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

/**
 * The TUI is a separate process from the server that owns the credentials, so a
 * missing server plugin looks exactly like a broken call unless it is told
 * apart. The host's documented system errors (`@opencode/schema/rpc`) cover
 * `rpc.unavailable` and `rpc.method_not_found`; those mean "not installed",
 * which is a setup problem the user can fix, not a Cursor hiccup they should
 * retry. Everything else stays the classified transient phrase, and neither
 * branch renders upstream text.
 */
const RPC_MISSING_ERRORS = ["rpc.unavailable", "rpc.method_not_found"] as const

function isRpcUnavailable(error: unknown): boolean {
  const type = (error as { type?: unknown } | undefined)?.type
  if (typeof type === "string" && (RPC_MISSING_ERRORS as readonly string[]).includes(type)) return true
  const message = error instanceof Error ? error.message : ""
  return RPC_MISSING_ERRORS.some((candidate) => message.includes(candidate))
}

const RPC_MISSING_TOAST: UsageToast = {
  title: "Cursor usage unavailable",
  message: "Usage unavailable (server plugin not loaded)",
  variant: "warning",
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
    } catch (error) {
      // The RPC failure is a transport/protocol fact, not upstream text: show a
      // classified phrase only, and tell a missing server plugin apart from a
      // Cursor-side hiccup.
      showToast(isRpcUnavailable(error)
        ? RPC_MISSING_TOAST
        : toastBodyFromSnapshot({
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
