import { describe, expect, it } from "bun:test"
import { toastBodyFromSnapshot } from "../src/account-usage-toast.js"
import type { CursorAccountUsageSnapshot } from "../src/account-usage.js"

const plan = {
  totalPercentUsed: 0.36,
  autoPercentUsed: 0,
  apiPercentUsed: 3.93,
} as const

describe("account usage toast", () => {
  // Live shape: a barely-used account must read as nearly-full bars, one line
  // per row, with no wrapped detail and no dashboard URL.
  it("renders compact remaining bars, one line per row", () => {
    const toast = toastBodyFromSnapshot({
      status: "ok",
      fetchedAtMs: 1,
      billingCycleEndMs: Date.parse("2026-11-04T00:00:00Z"),
      plan,
      onDemand: { state: "disabled" },
    })
    expect(toast.message).toBe([
      "Usage · Resets Nov 4",
      "Included   ████████████  100% left",
      "API" + " ".repeat(8) + "████████████   96% left",
      "On-Demand  Off",
    ].join("\n"))
  })

  it("drops plan rows that are unused and carry no information", () => {
    const toast = toastBodyFromSnapshot({ status: "ok", fetchedAtMs: 1, plan, onDemand: { state: "disabled" } })
    expect(toast.message).not.toContain("Auto")
  })

  it("omits rows Cursor does not report rather than showing placeholder bars", () => {
    const toast = toastBodyFromSnapshot({
      status: "ok",
      fetchedAtMs: 1,
      plan: { totalPercentUsed: 78, apiPercentUsed: undefined },
    })
    expect(toast.message).toContain("Included  ███░░░░░░░░░   22% left")
    expect(toast.message).not.toContain("API")
    expect(toast.message).not.toContain("0%")
    expect(toast.message).not.toContain("unavailable")
  })

  it("never wraps a row onto a second line", () => {
    const toast = toastBodyFromSnapshot({
      status: "ok",
      fetchedAtMs: 1,
      billingCycleEndMs: Date.parse("2026-11-04T00:00:00Z"),
      plan: { totalPercentUsed: 42 },
      onDemand: { state: "fixed", hardLimitDollars: 10, remainingDollars: 7.5 },
    })
    for (const line of toast.message.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(58)
    }
    expect(toast.message).toBe([
      "Usage · Resets Nov 4",
      "Included   ███████░░░░░   58% left",
      "On-Demand  $7.50 of $10.00 left",
    ].join("\n"))
  })

  it("omits the reset suffix when the billing cycle end is unknown", () => {
    expect(toastBodyFromSnapshot({ status: "ok", fetchedAtMs: 1, plan: { totalPercentUsed: 5 } }).message)
      .toContain("Usage\n")
  })

  it("renders each on-demand state compactly", () => {
    const cases: Array<[CursorAccountUsageSnapshot["onDemand"], string]> = [
      [{ state: "disabled" }, "On-Demand  Off"],
      [{ state: "unlimited" }, "On-Demand  No limit"],
      [{ state: "fixed", hardLimitDollars: 10, remainingDollars: 0 }, "On-Demand  $0.00 of $10.00 left"],
      [{ state: "fixed", remainingDollars: 4 }, "On-Demand  $4.00 left"],
    ]
    for (const [onDemand, expected] of cases) {
      const toast = toastBodyFromSnapshot({ status: "ok", fetchedAtMs: 1, plan: { totalPercentUsed: 5 }, onDemand })
      expect(toast.message).toContain(expected)
    }
  })

  it("omits an on-demand row that Cursor does not report", () => {
    const toast = toastBodyFromSnapshot({ status: "ok", fetchedAtMs: 1, plan: { totalPercentUsed: 5 } })
    expect(toast.message).not.toContain("On-Demand")
  })

  it("reports a header even when nothing is reportable", () => {
    const toast = toastBodyFromSnapshot({ status: "ok", fetchedAtMs: 1 })
    expect(toast.message).toBe("Usage unavailable")
  })

  it("maps errors to safe variants without leaking upstream text", () => {
    expect(toastBodyFromSnapshot({ status: "auth", fetchedAtMs: 1, error: "unavailable (auth required)" }))
      .toEqual({ title: "Cursor usage unavailable", message: "Usage unavailable (auth required)", variant: "warning" })
    expect(toastBodyFromSnapshot({ status: "transient", fetchedAtMs: 1, error: "unavailable (temporary error)" }))
      .toEqual({ title: "Cursor usage error", message: "Usage unavailable (temporary error)", variant: "error" })
    for (const status of ["auth", "transient"] as const) {
      const toast = toastBodyFromSnapshot({ status, fetchedAtMs: 1, error: "SECRET\nmalicious details" })
      expect(toast.message).not.toContain("SECRET")
      expect(toast.message.split("\n").length).toBe(1)
    }
  })

  it("escalates on the maximum reported usage, not the first one", () => {
    expect(toastBodyFromSnapshot({ status: "ok", fetchedAtMs: 1,
      plan: { totalPercentUsed: 1, autoPercentUsed: 75, apiPercentUsed: 12 } }).variant).toBe("warning")
    expect(toastBodyFromSnapshot({ status: "ok", fetchedAtMs: 1,
      plan: { totalPercentUsed: 1, autoPercentUsed: 12, apiPercentUsed: 90 } }).variant).toBe("error")
    expect(toastBodyFromSnapshot({ status: "ok", fetchedAtMs: 1,
      plan: { totalPercentUsed: NaN, autoPercentUsed: -1, apiPercentUsed: Infinity } }).variant).toBe("info")
    // Fully-used on-demand never escalates when plan percentages are low.
    expect(toastBodyFromSnapshot({ status: "ok", fetchedAtMs: 1, plan: { totalPercentUsed: 10 },
      onDemand: { state: "fixed", hardLimitDollars: 10, remainingDollars: 0 } }).variant).toBe("info")
  })
})

describe("account usage toast width", () => {
  // The toast box auto-sizes to its longest line: OpenCode's `ToastOptions` has
  // no width field. Codex reaches ~48 columns because every row carries a
  // `· resets <duration>` suffix. Cursor has one shared billing period, so the
  // equivalent width comes from a longer bar plus the dollar figures, which are
  // a different kind of fact from the percentage (plan-pool utilization).
  it("appends the reported dollar figures on the same line", () => {
    const toast = toastBodyFromSnapshot({
      status: "ok",
      fetchedAtMs: 1,
      plan: { totalPercentUsed: 8.85, totalSpendDollars: 1.77, limitDollars: 20 },
    })
    expect(toast.message).toContain("Included  ███████████░   91% left · $1.77 of $20.00")
    expect(toast.message.split("\n").length).toBe(2)
  })

  it("omits the dollar suffix when the row reports no limit", () => {
    const toast = toastBodyFromSnapshot({
      status: "ok",
      fetchedAtMs: 1,
      plan: { apiPercentUsed: 3.93 },
    })
    expect(toast.message).toBe("Usage\nAPI  ████████████   96% left")
  })

  it("reaches Codex-like width on a fully detailed account", () => {
    const toast = toastBodyFromSnapshot({
      status: "ok",
      fetchedAtMs: 1,
      billingCycleEndMs: Date.parse("2026-11-04T00:00:00Z"),
      plan: { totalPercentUsed: 8.85, totalSpendDollars: 1.77, limitDollars: 20 },
      onDemand: { state: "fixed", hardLimitDollars: 10, remainingDollars: 7.5 },
    })
    const longest = Math.max(...toast.message.split("\n").map((line) => line.length))
    expect(longest).toBeGreaterThanOrEqual(44)
    expect(longest).toBeLessThanOrEqual(58)
  })
})
