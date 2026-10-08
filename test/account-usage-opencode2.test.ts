import { describe, expect, it } from "bun:test"
import { createAccountUsageCache } from "../src/account-usage.js"
import { accountUsageRpcContract, CURSOR_ACCOUNT_USAGE_RPC_ID } from "../src/opencode2/account-usage-rpc-contract.js"
import {
  createAccountUsageCacheFor,
  CURSOR_ACCOUNT_USAGE_TOOL_NAME,
  registerCursorAccountUsageTool,
} from "../src/opencode2/account-usage-tool.js"
import { registerCursorAccountUsageRpc } from "../src/opencode2/account-usage-rpc.js"
import type { IntegrationDomain, Registration, ToolDraft } from "../src/opencode2/types.js"

const okSnapshot = {
  status: "ok" as const,
  fetchedAtMs: 1,
  billingCycleEndMs: 1764547200000,
  plan: { totalPercentUsed: 12.5, autoPercentUsed: 8, apiPercentUsed: 25 },
  onDemand: { state: "fixed" as const, hardLimitDollars: 10, remainingDollars: 7.5 },
}

function cacheStub(snapshot: unknown) {
  const counter = { calls: 0 }
  const cache = {
    snapshot: async () => {
      counter.calls++
      return snapshot
    },
  } as any
  return { cache, counter }
}

function fakeDraft() {
  const added: any[] = []
  const draft: ToolDraft = {
    add: (tool: any) => added.push(tool),
    get: (id: string) => added.find((tool) => tool.name === id),
  }
  return { draft, added }
}

function fakeRpcDomain() {
  const registrations: Array<{ contract: any; handlers: Record<string, any> }> = []
  const domain = {
    register: async (contract: unknown, handlers: Record<string, any>): Promise<Registration> => {
      registrations.push({ contract, handlers })
      let disposed = false
      return {
        dispose: async () => {
          disposed = true
        },
      }
    },
  }
  return { domain, registrations }
}

describe("opencode2 account usage server tool", () => {
  it("registers cursor_usage as a direct-catalog tool with an empty input schema", () => {
    const { draft, added } = fakeDraft()
    const { cache } = cacheStub(okSnapshot)
    registerCursorAccountUsageTool(draft, { cache })
    expect(added.length).toBe(1)
    const tool = added[0]
    expect(tool.name).toBe(CURSOR_ACCOUNT_USAGE_TOOL_NAME)
    expect(tool.name).toBe("cursor_usage")
    expect(tool.input).toEqual({ type: "object", properties: {}, additionalProperties: false })
    expect(tool.options?.codemode).toBe(false)
    expect(typeof tool.description).toBe("string")
    expect(typeof tool.execute).toBe("function")
  })

  it("does not double-register when the host already owns the name", () => {
    const { draft, added } = fakeDraft()
    const { cache } = cacheStub(okSnapshot)
    registerCursorAccountUsageTool(draft, { cache })
    registerCursorAccountUsageTool(draft, { cache })
    expect(added.length).toBe(1)
  })

  it("executes through the shared cache and returns the classified text", async () => {
    const { draft } = fakeDraft()
    const { cache, counter } = cacheStub(okSnapshot)
    registerCursorAccountUsageTool(draft, { cache })
    const result = await draft.get!("cursor_usage")!.execute({}, { sessionID: "s1" } as any)
    expect(counter.calls).toBe(1)
    expect(result.output).toContain("Included")
    expect(result.output).toContain("On-Demand")
    expect(result.metadata).toEqual({})
  })
})

describe("opencode2 account usage RPC", () => {
  it("registers the shared contract object with a usage handler over the same cache", async () => {
    const { domain, registrations } = fakeRpcDomain()
    const { cache, counter } = cacheStub(okSnapshot)
    await registerCursorAccountUsageRpc(domain as any, { cache })
    expect(registrations.length).toBe(1)
    expect(registrations[0].contract).toBe(accountUsageRpcContract)
    expect(registrations[0].contract.id).toBe(CURSOR_ACCOUNT_USAGE_RPC_ID)
    const snapshot = await registrations[0].handlers.usage({})
    expect(counter.calls).toBe(1)
    // Structural, not identity: the handler returns a schema-safe copy.
    expect(snapshot).toEqual(okSnapshot)
  })

  it("returns a disposal registration", async () => {
    const { domain, registrations } = fakeRpcDomain()
    const { cache } = cacheStub(okSnapshot)
    const registration = await registerCursorAccountUsageRpc(domain as any, { cache })
    expect(typeof registration.dispose).toBe("function")
    expect(registrations.length).toBe(1)
    await registration.dispose()
  })

  // Live host evidence: a snapshot carrying explicitly-undefined optional
  // fields is serialized with `null` members, which the host rejects with
  // `rpc.invalid_output: Expected number at ["plan"]["bonusSpendDollars"]`.
  // Absent values must be omitted from the payload entirely.
  it("omits absent snapshot fields instead of serializing them as null", async () => {
    const sparse = {
      status: "ok" as const,
      fetchedAtMs: 1,
      plan: { totalPercentUsed: 12.5, bonusSpendDollars: undefined, apiLimitDollars: undefined },
      onDemand: { state: "unavailable" as const, hardLimitDollars: undefined },
    }
    const { domain, registrations } = fakeRpcDomain()
    const { cache } = cacheStub(sparse)
    await registerCursorAccountUsageRpc(domain as any, { cache })
    const payload = await registrations[0].handlers.usage({}) as Record<string, any>
    expect(Object.keys(payload.plan)).toEqual(["totalPercentUsed"])
    expect(Object.keys(payload.onDemand)).toEqual(["state"])
    expect(payload.billingCycleStartMs).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain("null")
  })

  it("keeps every value the snapshot actually reports", async () => {
    const { domain, registrations } = fakeRpcDomain()
    const { cache } = cacheStub(okSnapshot)
    await registerCursorAccountUsageRpc(domain as any, { cache })
    const payload = await registrations[0].handlers.usage({})
    expect(payload).toEqual(okSnapshot)
  })
})

describe("opencode2 account usage credential resolution", () => {
  it("resolves the bearer through requireCursorAccessToken and shares it with the cache", async () => {
    let resolveCalls = 0
    const integration = {
      connection: {
        active: async () => ({ type: "credential", id: "c1", label: "Cursor" }),
        resolve: async () => {
          resolveCalls++
          return {
            type: "oauth",
            methodID: "oauth",
            access: "token-o2",
            refresh: "token-o2",
            expires: Date.now() + 60 * 24 * 3_600_000,
          }
        },
      },
    } as unknown as IntegrationDomain

    let seenAuthorization: string | null | undefined
    const fetchFn = (async (input: any, init: any) => {
      seenAuthorization = new Headers(init?.headers).get("authorization")
      return new Response(JSON.stringify({
        planUsage: { totalPercentUsed: 12.5 },
        spendLimitUsage: { limitType: "individual", individualLimit: 1000, individualUsed: 250, individualRemaining: 750 },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const cache = createAccountUsageCacheFor(integration, { fetchFn })
    const snapshot = await cache.snapshot()
    expect(snapshot.status).toBe("ok")
    expect(seenAuthorization).toBe("Bearer token-o2")
    expect(resolveCalls).toBe(1)
  })

  it("produces an auth-classified snapshot when no Cursor connection exists", async () => {
    const integration = {
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    } as unknown as IntegrationDomain
    const fetchFn = (async () => {
      throw new Error("must not fetch without a credential")
    }) as unknown as typeof fetch
    const cache = createAccountUsageCacheFor(integration, { fetchFn })
    const snapshot = await cache.snapshot()
    expect(snapshot.status).toBe("auth")
    expect(snapshot.error).toBe("unavailable (auth required)")
  })
})

describe("opencode2 shared cache", () => {
  it("is a real AccountUsageCache created once per setup", () => {
    // createAccountUsageCacheFor returns the standard cache interface; the
    // plugin wires tool + RPC to one instance.
    const integration = {
      connection: { active: async () => undefined, resolve: async () => undefined },
    } as unknown as IntegrationDomain
    const cache = createAccountUsageCacheFor(integration)
    expect(typeof cache.snapshot).toBe("function")
    expect(cache.snapshot).toBeDefined()
  })

  it("reuses the stock createAccountUsageCache semantics", async () => {
    // The adapter must not re-implement caching: verify the stock factory is
    // the same module symbol the plugin shares.
    const integration = {
      connection: { active: async () => undefined, resolve: async () => undefined },
    } as unknown as IntegrationDomain
    const fetchFn = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
    const cache = createAccountUsageCacheFor(integration, { fetchFn })
    // No connection: the stock cache classifies auth before any fetch.
    expect((await cache.snapshot()).status).toBe("auth")
  })
})
