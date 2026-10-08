import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import {
  createAccountUsageCache,
  parseAccountUsageResponse,
} from "../src/account-usage.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/cursor-account-usage.json", import.meta.url), "utf8")) as {
  currentPeriodUsage: Record<string, unknown>
  hardLimit: Record<string, unknown>
}
const response = fixture.currentPeriodUsage

function okFetch(body: Record<string, unknown>, hardLimitBody: Record<string, unknown> = fixture.hardLimit): {
  fetchFn: typeof fetch
  calls: () => number
  headers: () => Record<string, string>[]
} {
  let count = 0
  const seenHeaders: Record<string, string>[] = []
  const fetchFn = (async (input: any, init: any) => {
    count++
    const url = String(input instanceof Request ? input.url : input)
    seenHeaders.push(Object.fromEntries(new Headers(input instanceof Request ? input.headers : init?.headers)))
    const path = url.includes("GetHardLimit") ? hardLimitBody : body
    return new Response(JSON.stringify(path), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchFn, calls: () => count, headers: () => seenHeaders }
}

const okResponse = () => JSON.parse(JSON.stringify(response)) as Record<string, unknown>
const snapshotJson = (snapshot: unknown) => JSON.stringify(snapshot)

describe("account usage parsing", () => {
  it("parses verified Cursor usage fields and ignores unknown fields", () => {
    const snapshot = parseAccountUsageResponse({ ...okResponse(), unknownField: "ignored" }, 123, fixture.hardLimit)
    expect(snapshot.status).toBe("ok")
    expect(snapshot.fetchedAtMs).toBe(123)
    expect(snapshot.billingCycleEndMs).toBe(1764547200000)
    expect(snapshot.plan?.totalPercentUsed).toBe(12.5)
    expect(snapshot.plan?.autoPercentUsed).toBe(8.3333)
    expect(snapshot.plan?.apiPercentUsed).toBe(25)
  })

  it("keeps money units straight: SpendLimitUsage is cents, GetHardLimit is dollars", () => {
    const snapshot = parseAccountUsageResponse(okResponse(), 1, fixture.hardLimit)
    expect(snapshot.onDemand?.state).toBe("fixed")
    expect(snapshot.onDemand?.hardLimitDollars).toBe(10)
    expect(snapshot.onDemand?.remainingDollars).toBe(7.5)
    expect(snapshot.plan?.remainingDollars).toBe(17.5)
    expect(snapshot.plan?.limitDollars).toBe(20)
  })

  it("maps on-demand states conservatively", () => {
    const base = okResponse()
    const spend = { ...(base.spendLimitUsage as Record<string, unknown>) }
    expect(parseAccountUsageResponse(base, 1, { hardLimit: 2147483647 }).onDemand?.state).toBe("unlimited")
    expect(parseAccountUsageResponse(base, 1, { hardLimit: 0 }).onDemand?.state).toBe("disabled")
    expect(parseAccountUsageResponse(base, 1, { hardLimit: 10, noUsageBasedAllowed: true }).onDemand?.state).toBe("disabled")
    expect(parseAccountUsageResponse(base, 1, { hardLimit: 10, onDemandSpendDisabledByOrganization: true }).onDemand?.state).toBe("disabled")
    const team = { ...spend, limitType: "team", individualLimit: undefined }
    expect(parseAccountUsageResponse({ ...base, spendLimitUsage: team }, 1).onDemand?.state).toBe("unavailable")
    expect(parseAccountUsageResponse({ ...base, spendLimitUsage: { ...team, pooledLimit: 5000 } }, 1).onDemand?.state).toBe("unavailable")
    expect(parseAccountUsageResponse({ ...base, spendLimitUsage: team }, 1, fixture.hardLimit).onDemand?.state).toBe("fixed")
    const solo = { ...spend, limitType: "individual", individualRemaining: 500 }
    const soloSnapshot = parseAccountUsageResponse({ ...base, spendLimitUsage: solo }, 1)
    expect(soloSnapshot.onDemand?.state).toBe("fixed")
    expect(soloSnapshot.onDemand?.hardLimitDollars).toBe(10)
    expect(soloSnapshot.onDemand?.remainingDollars).toBe(5)
  })

  it("returns unavailable fields instead of inventing zeroes", () => {
    const snapshot = parseAccountUsageResponse({ enabled: true }, 123)
    expect(snapshot.status).toBe("ok")
    expect(snapshot.plan).toBeUndefined()
    expect(snapshot.onDemand?.state).toBe("unavailable")
  })

  it("accepts only valid numeric int64 camelCase millis for billing cycle dates", () => {
    const base = okResponse()
    expect(parseAccountUsageResponse({ ...base, billingCycleStart: 0 }, 1).billingCycleStartMs).toBeUndefined()
    expect(parseAccountUsageResponse({ ...base, billingCycleStart: -5 }, 1).billingCycleStartMs).toBeUndefined()
    expect(parseAccountUsageResponse({ ...base, billingCycleStart: 1.5 }, 1).billingCycleStartMs).toBeUndefined()
    expect(parseAccountUsageResponse({ ...base, billingCycleStart: "2026-01-01T00:00:00Z" }, 1).billingCycleStartMs).toBeUndefined()
    expect(parseAccountUsageResponse({ ...base, billingCycleStart: "1761868800000" }, 1).billingCycleStartMs).toBe(1761868800000)
    expect(parseAccountUsageResponse({ ...base, billingCycleStart: 1761868800000 }, 1).billingCycleStartMs).toBe(1761868800000)
    expect(parseAccountUsageResponse({ ...base, billingCycleEnd: 4102444800001 }, 1).billingCycleEndMs).toBeUndefined()
    // Beyond safe-integer/epoch range stays rejected even as canonical decimal strings.
    expect(parseAccountUsageResponse({ ...base, billingCycleStart: "9007199254740993" }, 1).billingCycleStartMs).toBeUndefined()
    expect(parseAccountUsageResponse({ ...base, billingCycleEnd: "9223372036854775807" }, 1).billingCycleEndMs).toBeUndefined()
    expect(parseAccountUsageResponse({ ...base, billingCycleEnd: " 1761868800000" }, 1).billingCycleEndMs).toBeUndefined()
    expect(parseAccountUsageResponse({ ...base, billingCycleEnd: "+1761868800000" }, 1).billingCycleEndMs).toBeUndefined()
  })

  it("omits raw upstream display text and unparsed blocks", () => {
    const snapshot = parseAccountUsageResponse({
      ...okResponse(),
      displayMessage: "upstream untrusted text",
      autoModelSelectedDisplayMessage: "upstream hint",
      namedModelSelectedDisplayMessage: "upstream hint 2",
      autoBucketModels: ["model-a"],
      freeBestOfNPromotion: { trialsUsed: 1, trialsRemaining: 2 },
      displayThreshold: 90,
    }, 1, fixture.hardLimit)
    const json = snapshotJson(snapshot)
    expect(json).not.toContain("upstream")
    expect(json).not.toContain("model-a")
    expect(json).not.toContain("trialsUsed")
    expect(json).not.toContain("displayThreshold")
  })
})

describe("account usage cache", () => {
  it("classifies a raw crsr_ bearer as auth without any request", async () => {
    const { fetchFn, calls } = okFetch(okResponse())
    const cache = createAccountUsageCache({ bearer: async () => "crsr_secret", fetchFn })
    const snapshot = await cache.snapshot()
    expect(snapshot.status).toBe("auth")
    expect(snapshot.error).toBe("unavailable (auth required)")
    expect(calls()).toBe(0)
  })

  it("classifies a missing or empty bearer as auth without any request", async () => {
    const { fetchFn, calls } = okFetch(okResponse())
    const cache = createAccountUsageCache({ bearer: async () => "  ", fetchFn })
    expect((await cache.snapshot()).status).toBe("auth")
    expect(calls()).toBe(0)
  })

  it("sends the resolved client version header via the injected seam", async () => {
    const { fetchFn, headers } = okFetch(okResponse())
    const cache = createAccountUsageCache({
      bearer: async () => "token-a",
      fetchFn,
      resolveClientVersion: async () => "cli-9.9.9-seam",
    })
    await cache.snapshot()
    expect(headers()[0]["x-cursor-client-version"]).toBe("cli-9.9.9-seam")
    expect(headers()[0]["authorization"]).toBe("Bearer token-a")
  })

  it("reuses the real resolveClientVersion default (env override, no network)", async () => {
    const previous = process.env.CURSOR_CLIENT_VERSION
    process.env.CURSOR_CLIENT_VERSION = "cli-8.8.8-default"
    resetClientVersionCache()
    try {
      const { fetchFn, headers } = okFetch(okResponse())
      const cache = createAccountUsageCache({ bearer: async () => "token-a", fetchFn })
      await cache.snapshot()
      expect(headers()[0]["x-cursor-client-version"]).toBe("cli-8.8.8-default")
    } finally {
      if (previous === undefined) delete process.env.CURSOR_CLIENT_VERSION
      else process.env.CURSOR_CLIENT_VERSION = previous
      resetClientVersionCache()
    }
  })

  it("isolates accounts: switching credentials never serves another account snapshot", async () => {
    let token = "token-a"
    const { fetchFn, calls } = okFetch(okResponse())
    const cache = createAccountUsageCache({ bearer: async () => token, fetchFn, now: () => 1000 })
    const first = await cache.snapshot()
    token = "token-b"
    const second = await cache.snapshot()
    expect(second).not.toBe(first)
    expect(calls()).toBe(4)
    token = "token-a"
    const again = await cache.snapshot()
    expect(again).toBe(first)
    expect(calls()).toBe(4)
  })

  it("bounds the cached-account map and evicts the oldest", async () => {
    const { fetchFn, calls } = okFetch(okResponse())
    const cache = createAccountUsageCache({ bearer: async () => `token-${calls()}`, fetchFn, now: () => 1000 })
    for (let i = 0; i < 9; i++) await cache.snapshot()
    const afterNine = calls()
    await cache.snapshot()
    expect(calls()).toBeGreaterThan(afterNine)
  })

  it("deduplicates concurrent requests and caches successful snapshots", async () => {
    const { fetchFn, calls } = okFetch(okResponse())
    let now = 1000
    const cache = createAccountUsageCache({ bearer: async () => "token", fetchFn, now: () => now })
    const [first, second] = await Promise.all([cache.snapshot(), cache.snapshot()])
    expect(first).toEqual(second)
    expect(calls()).toBe(2)
    await cache.snapshot()
    expect(calls()).toBe(2)
    now += 60_001
    await cache.snapshot()
    expect(calls()).toBe(4)
  })

  it("does not cache failed probes", async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls++
      return calls === 1
        ? new Response("temporary", { status: 503 })
        : new Response(JSON.stringify(okResponse()), { status: 200 })
    }) as unknown as typeof fetch
    const cache = createAccountUsageCache({ bearer: async () => "token", fetchFn })
    expect((await cache.snapshot()).status).toBe("transient")
    expect((await cache.snapshot()).status).toBe("ok")
    expect(calls).toBe(3)
  })

  it("classifies auth and transient failures without leaking response bodies", async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls++
      return new Response("secret-token-body", { status: 401 })
    }) as unknown as typeof fetch
    const cache = createAccountUsageCache({ bearer: async () => "secret-token", fetchFn })
    const snapshot = await cache.snapshot()
    expect(snapshot.status).toBe("auth")
    expect(snapshotJson(snapshot)).not.toContain("secret-token")
    expect(snapshotJson(snapshot)).not.toContain("secret-token-body")
    await cache.snapshot()
    expect(calls).toBe(2)
  })

  it("preserves the primary snapshot when the best-effort hard-limit call fails", async () => {
    const fetchFn = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("GetHardLimit")) return new Response("boom", { status: 500 })
      return new Response(JSON.stringify(okResponse()), { status: 200 })
    }) as unknown as typeof fetch
    const cache = createAccountUsageCache({ bearer: async () => "token", fetchFn })
    const snapshot = await cache.snapshot()
    expect(snapshot.status).toBe("ok")
    expect(snapshot.plan?.totalPercentUsed).toBe(12.5)
    // On-demand falls back to the individual SpendLimitUsage (CLI semantics for
    // a missing hard-limit response with limitType individual).
    expect(snapshot.onDemand?.state).toBe("fixed")
    expect(snapshot.onDemand?.hardLimitDollars).toBe(10)
  })

  it("bounds the hard-limit attempt separately so a hung hard limit never breaks the primary", async () => {
    const started = Date.now()
    const fetchFn = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("GetHardLimit")) return new Promise<Response>(() => {})
      return new Response(JSON.stringify(okResponse()), { status: 200 })
    }) as unknown as typeof fetch
    const cache = createAccountUsageCache({ bearer: async () => "token", fetchFn, timeoutMs: 200 })
    const snapshot = await cache.snapshot()
    expect(snapshot.status).toBe("ok")
    expect(snapshot.plan?.totalPercentUsed).toBe(12.5)
    expect(snapshot.onDemand?.state).toBe("fixed")
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it("applies a finite deadline to the response body read", async () => {
    const started = Date.now()
    const fetchFn = (async () =>
      new Response(
        new ReadableStream({ start() {} }),
        { status: 200 },
      )) as unknown as typeof fetch
    const cache = createAccountUsageCache({ bearer: async () => "token", fetchFn, timeoutMs: 200 })
    const snapshot = await cache.snapshot()
    expect(snapshot.status).toBe("transient")
    expect(snapshot.error).toBe("unavailable (temporary error)")
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it("rejects malformed successful primary responses as transient", async () => {
    let calls = 0
    const fetchFn = (async (input: any) => {
      calls++
      const url = String(input instanceof Request ? input.url : input)
      return url.includes("GetHardLimit")
        ? new Response("{}", { status: 200 })
        : new Response("null", { status: 200 })
    }) as unknown as typeof fetch
    const cache = createAccountUsageCache({ bearer: async () => "token", fetchFn })
    expect((await cache.snapshot()).status).toBe("transient")
    expect((await cache.snapshot()).status).toBe("transient")
    expect(calls).toBe(2)
  })

  it("does not let callers mutate cached snapshots", async () => {
    const { fetchFn } = okFetch(okResponse())
    const cache = createAccountUsageCache({ bearer: async () => "token", fetchFn })
    const first = await cache.snapshot()
    try {
      ;(first as { plan?: { totalPercentUsed?: number } }).plan!.totalPercentUsed = 99
    } catch {
      // Frozen snapshots may reject mutation in strict mode.
    }
    const second = await cache.snapshot()
    expect(second.plan?.totalPercentUsed).toBe(12.5)
  })
})
