import { describe, expect, it } from "bun:test"
import { createOpenCodeAccountUsageTool } from "../src/account-usage-tool.js"
import type { AccountUsageCache } from "../src/account-usage.js"

function cacheStub(snapshot: any, counter = { calls: 0 }): AccountUsageCache & { counter: { calls: number } } {
  return {
    counter,
    snapshot: async () => {
      counter.calls++
      return snapshot
    },
  } as any
}

const okSnapshot = {
  status: "ok",
  fetchedAtMs: 1,
  billingCycleEndMs: 1764547200000,
  plan: { totalPercentUsed: 12.5, autoPercentUsed: 8, apiPercentUsed: 25 },
  onDemand: { state: "fixed", hardLimitDollars: 10, remainingDollars: 7.5 },
}

describe("OpenCode account usage tool", () => {
  it("creates an empty-args tool mirroring the classic helper shape", () => {
    const definitions: any[] = []
    const tool = createOpenCodeAccountUsageTool(
      { tool: (definition: any) => (definitions.push(definition), definition) },
      { cache: cacheStub(okSnapshot) },
    )
    expect(definitions.length).toBe(1)
    expect(tool.args).toEqual({})
    expect(typeof tool.description).toBe("string")
    expect(typeof tool.execute).toBe("function")
  })

  it("renders the cached snapshot through the shared formatter on every call", async () => {
    const cache = cacheStub(okSnapshot)
    const tool = createOpenCodeAccountUsageTool(
      { tool: (definition: any) => definition },
      { cache },
    )
    const first = await tool.execute({}, { sessionID: "s1" })
    const second = await tool.execute({}, { sessionID: "s2" })
    expect(cache.counter.calls).toBe(2)
    expect(first).toContain("Included")
    expect(second).toContain("On-Demand")
  })

  it("propagates only the formatter's classified text, never raw internals", async () => {
    const cache = cacheStub({
      status: "auth",
      fetchedAtMs: 1,
      error: "unavailable (auth required)",
      internalNote: "secret-token",
    })
    const tool = createOpenCodeAccountUsageTool(
      { tool: (definition: any) => definition },
      { cache },
    )
    const output = await tool.execute({})
    expect(output).toBe("Usage unavailable (auth required)")
    expect(output).not.toContain("secret-token")
  })
})

describe("classic-tools account usage integration", () => {
  it("builds the host-helper tool when the host tool() helper is found", async () => {
    const { loadClassicTools } = await import("../src/classic-tools.js")
    const hostDefinitions: any[] = []
    const hostTool = (definition: any) => {
      hostDefinitions.push(definition)
      return definition
    }
    // Chainable Zod-like schema stub: the factory branch also builds the
    // web-search/image-save tools from this helper, so it must survive their
    // schema.string().describe(...).optional() chains.
    const chainable: any = new Proxy(function () {}, {
      get: () => chainable,
      apply: () => chainable,
    })
    ;(hostTool as any).schema = chainable
    const cache = cacheStub(okSnapshot)
    const tools = await loadClassicTools({
      importModule: async () => ({ tool: hostTool }),
      accountUsage: cache,
    })
    // The factory branch builds websearch + image-save + usage from one helper.
    expect(hostDefinitions.length).toBe(3)
    expect(tools.accountUsage.args).toEqual({})
    expect(await tools.accountUsage.execute({})).toContain("Included")
    expect(cache.counter.calls).toBe(1)
  })

  it("falls back to the identity-helper definition when no host helper exists", async () => {
    const { loadClassicTools } = await import("../src/classic-tools.js")
    const cache = cacheStub(okSnapshot)
    const tools = await loadClassicTools({
      importModule: async () => {
        throw new Error("no host plugin package")
      },
      accountUsage: cache,
    })
    expect(tools.accountUsage.args).toEqual({})
    expect(await tools.accountUsage.execute({})).toContain("On-Demand")
  })

  it("defaults to the durable-store bearer when no cache is injected", async () => {
    const { loadClassicTools } = await import("../src/classic-tools.js")
    const previous = process.env.OPENCODE_AUTH_CONTENT
    process.env.OPENCODE_AUTH_CONTENT = "{}"
    try {
      const tools = await loadClassicTools({
        importModule: async () => {
          throw new Error("no host plugin package")
        },
      })
      const output = await tools.accountUsage.execute({})
      expect(output).toBe("Usage unavailable (auth required)")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = previous
    }
  })

  it("registers cursor_usage on the classic plugin tool map (source-level oracle)", async () => {
    const { readFile } = await import("node:fs/promises")
    const source = await readFile(new URL("../src/plugin.ts", import.meta.url), "utf8")
    expect(source).toContain("cursor_usage: classicTools.accountUsage")
    // plugin.ts must keep CursorPlugin as its only export (classic host rule).
    const exportLines = source.split("\n").filter((line) => /^export /.test(line))
    expect(exportLines).toEqual([expect.stringContaining("export async function CursorPlugin")])
  })
})
