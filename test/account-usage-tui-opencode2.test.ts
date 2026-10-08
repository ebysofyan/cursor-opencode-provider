import { describe, expect, it } from "bun:test"
import { accountUsageRpcContract } from "../src/opencode2/account-usage-rpc-contract.js"
import {
  CursorAccountUsageOpenCode2TuiPlugin,
  CURSOR_ACCOUNT_USAGE_TUI_COMMAND,
  type CursorUsageTuiContext,
} from "../src/opencode2/account-usage-tui.js"

const okSnapshot = {
  status: "ok" as const,
  fetchedAtMs: 1,
  billingCycleEndMs: 1764547200000,
  plan: { totalPercentUsed: 12.5, autoPercentUsed: 8, apiPercentUsed: 25 },
  onDemand: { state: "fixed" as const, hardLimitDollars: 10, remainingDollars: 7.5 },
}

type RecordedToast = { title?: string; message: string; variant?: string; duration?: number }

function fakeContext(snapshot: unknown, rpcBehavior?: () => Promise<unknown>) {
  const toasts: RecordedToast[] = []
  const rpcCalls: Array<{ contract: unknown; input: unknown }> = []
  let layerInstalled: { commands: any[] } | undefined
  const context = {
    client: {
      rpc: (contract: unknown) => {
        return {
          usage: async (input: unknown) => {
            rpcCalls.push({ contract, input })
            if (rpcBehavior) return await rpcBehavior()
            return await Promise.resolve(snapshot)
          },
        }
      },
    },
    keymap: {
      layer: (factory: () => any) => {
        layerInstalled = factory()
        return layerInstalled
      },
    },
    ui: {
      slot: (_options: unknown) => undefined,
      toast: { show: (toast: RecordedToast) => toasts.push(toast) },
    },
  }
  return { context: context as unknown as CursorUsageTuiContext, toasts, rpcCalls, layer: () => layerInstalled }
}

async function installedCommand(context: CursorUsageTuiContext) {
  const layers: any[] = []
  const slotDisposals: number[] = []
  const layerDisposals: number[] = []
  const wrapped = {
    ...context,
    keymap: {
      layer: (factory: () => any) => {
        const l = factory()
        layers.push(l)
        return () => {
          layerDisposals.push(1)
        }
      },
    },
    ui: {
      ...context.ui,
      slot: (options: { append?: string; render?: () => void }) => {
        options.render?.()
        return () => {
          slotDisposals.push(1)
        }
      },
    },
  } as unknown as CursorUsageTuiContext
  const dispose = CursorAccountUsageOpenCode2TuiPlugin(wrapped)
  return {
    layers,
    command: layers[0]?.commands?.[0],
    dispose,
    slotDisposals,
    layerDisposals,
  }
}

describe("opencode2 account usage TUI", () => {
  it("installs a /cursor-usage command through ui.slot + keymap.layer", async () => {
    const { layers, command } = await installedCommand(await Promise.resolve(fakeContext(okSnapshot).context))
    expect(layers.length).toBe(1)
    expect(command.title).toBe("Cursor usage")
    expect(command.slash?.name).toBe("cursor-usage")
    expect(command.palette).toBe(true)
    expect(typeof command.run).toBe("function")
  })

  it("runs the command by calling client.rpc with the shared contract only", async () => {
    const { context, toasts, rpcCalls } = fakeContext(okSnapshot)
    const { command } = await installedCommand(context)
    await command.run()
    expect(rpcCalls.length).toBe(1)
    expect(rpcCalls[0].contract).toBe(accountUsageRpcContract)
    expect(rpcCalls[0].input).toEqual({})
    expect(toasts.length).toBe(1)
    expect(toasts[0].title).toBe("Cursor usage")
    expect(toasts[0].message).toContain("Included")
    expect(toasts[0].message).toContain("On-Demand")
  })

  it("maps an RPC failure to a classified error toast without raw internals", async () => {
    const { context, toasts, rpcCalls } = fakeContext(undefined, async () => {
      throw new Error("secret internal detail: token-abc")
    })
    const { command } = await installedCommand(context)
    await command.run()
    expect(rpcCalls.length).toBe(1)
    expect(toasts.length).toBe(1)
    expect(toasts[0].variant).toBe("error")
    expect(toasts[0].message).toContain("unavailable (temporary error)")
    expect(toasts[0].message).not.toContain("secret")
  })

  it("collapses concurrent runs into one RPC call (single-flight)", async () => {
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => { release = resolve })
    const { context, rpcCalls, toasts } = fakeContext(undefined, async () => {
      await gate
      return okSnapshot
    })
    const { command } = await installedCommand(context)
    const first = command.run()
    const second = command.run()
    release(undefined)
    await Promise.all([first, second])
    expect(rpcCalls.length).toBe(1)
    expect(toasts.length).toBe(1)
    await Promise.resolve()
  })

  it("registers no keybinding: slash and palette only", async () => {
    const { layers, command } = await installedCommand(await Promise.resolve(fakeContext(okSnapshot).context))
    expect(command.bind).toBeUndefined()
    expect(command.palette).toBe(true)
    expect(command.slash?.name).toBe("cursor-usage")
    expect(layers[0].bindings).toEqual([CURSOR_ACCOUNT_USAGE_TUI_COMMAND.id])
    expect("bind" in CURSOR_ACCOUNT_USAGE_TUI_COMMAND).toBe(false)
  })

  it("returns a setup disposer that releases the ui.slot and keymap layer", async () => {
    const { context } = fakeContext(okSnapshot)
    const { dispose, slotDisposals, layerDisposals } = await installedCommand(context)
    expect(typeof dispose).toBe("function")
    dispose!()
    expect(slotDisposals).toEqual([1])
    expect(layerDisposals).toEqual([1])
  })

  it("exposes the command id and slash name as shared constants", () => {
    expect(CURSOR_ACCOUNT_USAGE_TUI_COMMAND.id).toBe("cursor_usage")
    expect(CURSOR_ACCOUNT_USAGE_TUI_COMMAND.slash).toBe("cursor-usage")
  })
})

describe("opencode2 account usage TUI failure classification", () => {
  // The TUI is a separate process from the credential-owning server, so an
  // uninstalled server plugin must not be reported as a Cursor hiccup.
  it("reports a missing server plugin instead of a transient error", async () => {
    const missing = Object.assign(new Error("rpc failed"), { type: "rpc.method_not_found" })
    const { context, toasts } = fakeContext(okSnapshot, () => Promise.reject(missing))
    const { command } = await installedCommand(context)
    await command.run()
    expect(toasts.at(-1)).toMatchObject({
      title: "Cursor usage unavailable",
      message: "Usage unavailable (server plugin not loaded)",
      variant: "warning",
    })
  })

  it("matches an rpc.unavailable error carried only in the message", async () => {
    const { context, toasts } = fakeContext(okSnapshot, () => Promise.reject(new Error("rpc.unavailable")))
    const { command } = await installedCommand(context)
    await command.run()
    expect(toasts.at(-1)?.message).toBe("Usage unavailable (server plugin not loaded)")
  })

  it("still reports any other failure as a transient error", async () => {
    const { context, toasts } = fakeContext(okSnapshot, () => Promise.reject(new Error("connection reset")))
    const { command } = await installedCommand(context)
    await command.run()
    expect(toasts.at(-1)).toMatchObject({
      message: "Usage unavailable (temporary error)",
      variant: "error",
    })
  })
})
