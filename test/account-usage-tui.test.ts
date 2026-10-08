import { beforeEach, describe, expect, it } from "bun:test"
import {
  createCursorAccountUsageTuiPlugin,
  cursorAccountUsageTuiPlugin,
} from "../src/plugin-tui.js"
import { cursorUsageStoreBearer } from "../src/account-usage-tool.js"
import { CursorAuthError } from "../src/errors.js"
import { resetAuthRenewalState } from "../src/auth-renewal.js"
import type { CursorUsageTuiApi, CursorUsageTuiCommand, TuiToast } from "../src/plugin-tui.js"
import type { AccountUsageCache } from "../src/account-usage.js"

function fakeApi() {
  const commands: CursorUsageTuiCommand[] = []
  const toasts: TuiToast[] = []
  let disposeCalled = 0
  const disposers: Array<() => void> = []
  const api: CursorUsageTuiApi = {
    command: {
      register: (factory) => {
        commands.push(...factory())
        return () => { disposeCalled++ }
      },
    },
    ui: {
      toast: (toast) => { toasts.push(toast) },
    },
    lifecycle: {
      onDispose: (dispose) => { disposers.push(dispose) },
    },
  }
  return {
    api,
    commands,
    toasts,
    disposers,
    disposeCallCount: () => disposeCalled,
  }
}

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
  plan: { totalPercentUsed: 78, autoPercentUsed: 8, apiPercentUsed: 25 },
  onDemand: { state: "fixed", hardLimitDollars: 10, remainingDollars: 7.5 },
}

describe("OpenCode 1.x account usage TUI plugin", () => {
  it("exposes the default { id, tui } export shape", () => {
    expect(typeof cursorAccountUsageTuiPlugin.id).toBe("string")
    expect(typeof cursorAccountUsageTuiPlugin.tui).toBe("function")
  })

  it("registers a single /cursor-usage command and no timers", async () => {
    const handle = fakeApi()
    await createCursorAccountUsageTuiPlugin({ cache: cacheStub(okSnapshot) })(handle.api)
    expect(handle.commands.length).toBe(1)
    expect(handle.commands[0].slash.name).toBe("cursor-usage")
    expect(handle.commands[0].title).toBe("Cursor usage")
    expect(handle.disposers.length).toBe(1)
  })

  it("shows a toast from the shared core snapshot on selection", async () => {
    const handle = fakeApi()
    const cache = cacheStub(okSnapshot)
    await createCursorAccountUsageTuiPlugin({ cache })(handle.api)
    handle.commands[0].onSelect()
    await Promise.resolve()
    await Promise.resolve()
    expect(cache.counter.calls).toBe(1)
    expect(handle.toasts.length).toBe(1)
    expect(handle.toasts[0].message).toContain("Included")
    expect(handle.toasts[0].message).toContain("On-Demand")
    expect(handle.toasts[0].duration).toBeGreaterThan(0)
  })

  it("collapses rapid double selections into one probe (single-flight)", async () => {
    const handle = fakeApi()
    const cache = cacheStub(okSnapshot)
    await createCursorAccountUsageTuiPlugin({ cache })(handle.api)
    handle.commands[0].onSelect()
    handle.commands[0].onSelect()
    await Promise.resolve()
    await Promise.resolve()
    expect(cache.counter.calls).toBe(1)
    expect(handle.toasts.length).toBe(1)
  })

  it("renders classified failures without leaking cache internals", async () => {
    const handle = fakeApi()
    const cache = cacheStub({
      status: "auth",
      fetchedAtMs: 1,
      error: "unavailable (auth required)",
      internalNote: "secret-token",
    })
    await createCursorAccountUsageTuiPlugin({ cache })(handle.api)
    handle.commands[0].onSelect()
    await Promise.resolve()
    await Promise.resolve()
    expect(handle.toasts.length).toBe(1)
    expect(handle.toasts[0].message).toContain("unavailable (auth required)")
    expect(JSON.stringify(handle.toasts)).not.toContain("secret-token")
  })

  it("shows a safe toast even when the cache itself rejects", async () => {
    const handle = fakeApi()
    const cache = {
      snapshot: async () => {
        throw new Error("raw network detail https://evil.test")
      },
    } as unknown as AccountUsageCache
    await createCursorAccountUsageTuiPlugin({ cache })(handle.api)
    handle.commands[0].onSelect()
    await Promise.resolve()
    await Promise.resolve()
    expect(handle.toasts.length).toBe(1)
    expect(handle.toasts[0].variant).toBe("error")
    expect(JSON.stringify(handle.toasts)).not.toContain("evil.test")
  })

  it("builds the default cache over an injected bearer when no cache is given", async () => {
    const handle = fakeApi()
    await createCursorAccountUsageTuiPlugin({
      bearer: async () => {
        throw new CursorAuthError("No Cursor login found; sign in to Cursor", { code: "no_credential" })
      },
    })(handle.api)
    handle.commands[0].onSelect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handle.toasts.length).toBe(1)
    expect(handle.toasts[0].message).toContain("unavailable (auth required)")
  })

  it("unregisters the command exactly once via lifecycle dispose", async () => {
    const handle = fakeApi()
    await createCursorAccountUsageTuiPlugin({ cache: cacheStub(okSnapshot) })(handle.api)
    handle.disposers[0]()
    handle.disposers[0]()
    expect(handle.disposeCallCount()).toBe(1)
  })

  it("uses the default shared-core cache backed by the durable store", async () => {
    const handle = fakeApi()
    const previous = process.env.OPENCODE_AUTH_CONTENT
    process.env.OPENCODE_AUTH_CONTENT = "{}"
    try {
      await cursorAccountUsageTuiPlugin.tui(handle.api)
      handle.commands[0].onSelect()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(handle.toasts.length).toBe(1)
      expect(handle.toasts[0].message).toContain("unavailable (auth required)")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = previous
    }
  })
})

describe("cursor usage durable-store bearer", () => {
  it("passes an oauth session token through Bearer resolution unchanged", async () => {
    const bearer = cursorUsageStoreBearer({
      read: async () => ({ type: "oauth", access: "session-jwt", refresh: "r", expires: 1 }),
    })
    await expect(bearer()).resolves.toBe("session-jwt")
  })

  it("throws a classified auth error when the store has no cursor credential", async () => {
    const bearer = cursorUsageStoreBearer({ read: async () => undefined })
    await expect(bearer()).rejects.toBeInstanceOf(CursorAuthError)
  })

  it("rejects a raw crsr_ key stored as an oauth access token (never a Bearer)", async () => {
    const bearer = cursorUsageStoreBearer({
      read: async () => ({ type: "oauth", access: "crsr_raw", refresh: "r", expires: 1 }),
    })
    await expect(bearer()).rejects.toBeInstanceOf(CursorAuthError)
  })

  it("exchanges a raw crsr_ api credential through the shared API-key path", async () => {
    const server = Bun.serve({ port: 0, fetch: async () => new Response("denied", { status: 401 }) })
    try {
      const bearer = cursorUsageStoreBearer({
        read: async () => ({ type: "api", key: "crsr_rejected" }),
        baseUrl: `http://localhost:${server.port}`,
      })
      await expect(bearer()).rejects.toBeInstanceOf(CursorAuthError)
    } finally {
      server.stop(true)
    }
  })
})

describe("cursor usage bearer renewal awareness", () => {
  const DAY_S = 86_400

  /** Cursor-shaped session JWT with a `time` issue claim and `exp`. */
  function sessionJwt(issuedAgoS: number, lifetimeS = 60 * DAY_S): string {
    const issued = Math.floor(Date.now() / 1000) - issuedAgoS
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")
    const payload = Buffer.from(JSON.stringify({
      type: "session",
      time: String(issued),
      exp: issued + lifetimeS,
      randomness: Math.random().toString(36).slice(2),
    })).toString("base64url")
    return `${header}.${payload}.sig`
  }

  let requests = 0
  let stub: ReturnType<typeof Bun.serve> | undefined

  function startStub(respond: () => Response): string {
    requests = 0
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        requests++
        return respond()
      },
    })
    stub = server
    return `http://localhost:${server.port}`
  }

  beforeEach(() => {
    resetAuthRenewalState()
    return () => {
      stub?.stop(true)
      stub = undefined
    }
  })

  it("renews a due oauth session through the shared renewal path (no duplicated refresh logic)", async () => {
    const dueToken = sessionJwt(8 * DAY_S)
    const renewedToken = sessionJwt(0)
    const base = startStub(() => Response.json({ access_token: renewedToken, shouldLogout: false }))
    const bearer = cursorUsageStoreBearer({
      read: async () => ({ type: "oauth", access: dueToken, refresh: "r-renew", expires: 1 }),
      baseUrl: base,
    })
    await expect(bearer()).resolves.toBe(renewedToken)
    expect(requests).toBe(1)
  })

  it("keeps the still-valid stored token when a renewal transiently fails", async () => {
    const dueToken = sessionJwt(8 * DAY_S)
    const base = startStub(() => new Response("unavailable", { status: 503 }))
    const bearer = cursorUsageStoreBearer({
      read: async () => ({ type: "oauth", access: dueToken, refresh: "r-transient", expires: 1 }),
      baseUrl: base,
    })
    await expect(bearer()).resolves.toBe(dueToken)
  })

  it("does not contact Cursor while the stored session is not due", async () => {
    const freshToken = sessionJwt(0)
    const base = startStub(() => Response.json({ access_token: sessionJwt(0), shouldLogout: false }))
    const bearer = cursorUsageStoreBearer({
      read: async () => ({ type: "oauth", access: freshToken, refresh: "r-fresh", expires: 1 }),
      baseUrl: base,
    })
    await expect(bearer()).resolves.toBe(freshToken)
    expect(requests).toBe(0)
  })
})
