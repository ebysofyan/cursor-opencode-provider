import { describe, expect, it } from "bun:test"
import { formatAccountUsageText } from "../src/account-usage-format.js"
import type { CursorAccountUsageSnapshot } from "../src/account-usage.js"

describe("account usage text", () => {
  it("renders the Cursor rows and reset date", () => {
    const snapshot: CursorAccountUsageSnapshot = {
      status: "ok",
      fetchedAtMs: 1,
      billingCycleEndMs: Date.parse("2026-11-01T00:00:00Z"),
      plan: { totalPercentUsed: 12.5, autoPercentUsed: 8, apiPercentUsed: 25 },
      onDemand: { state: "fixed", hardLimitDollars: 10, remainingDollars: 7.5 },
    }
    const output = formatAccountUsageText(snapshot)
    expect(output).toContain("Usage")
    expect(output).toContain("Included")
    expect(output).toContain("Auto")
    expect(output).toContain("API")
    expect(output).toContain("On-Demand")
    expect(output).toContain("Resets Nov 1")
    expect(output).toContain("$7.50 remaining")
  })

  it("does not invent unavailable values", () => {
    const output = formatAccountUsageText({ status: "ok", fetchedAtMs: 1, onDemand: { state: "unavailable" } })
    expect(output).toContain("unavailable")
    expect(output).not.toContain("0%")
    expect(output).not.toContain("$0.00")
  })

  it("renders classified failures without raw details", () => {
    const output = formatAccountUsageText({ status: "auth", fetchedAtMs: 1, error: "unavailable (auth required)" })
    expect(output).toBe("Usage unavailable (auth required)")
  })

  it("renders shared eight-character used bars and the fixed dashboard", () => {
    const output = formatAccountUsageText({
      status: "ok", fetchedAtMs: 1,
      billingCycleEndMs: Date.parse("2026-11-06T00:30:00Z"),
      plan: { totalPercentUsed: 0, autoPercentUsed: 25, apiPercentUsed: 125 },
      onDemand: { state: "disabled" },
    })
    expect(output).toContain("Usage · Resets Nov 6")
    expect(output).toContain("Included   ░░░░░░░░  0% used")
    expect(output).toContain("Auto       ██░░░░░░  25% used")
    expect(output).toContain("API        ████████  125% used")
    expect(output).toContain("On-demand usage is off")
    expect(output).toContain("https://cursor.com/dashboard?tab=usage")
    expect(output).not.toContain("Pro")
    expect(output).not.toContain("% left")
  })

  it("shows fixed on-demand usage and preserves its dollar details", () => {
    const output = formatAccountUsageText({ status: "ok", fetchedAtMs: 1,
      onDemand: { state: "fixed", hardLimitDollars: 10, remainingDollars: 7.5 } })
    expect(output).toContain("$2.50 of $10.00 used")
    expect(output).toContain("$7.50 remaining")
  })

  it("renders fixed on-demand dollars without a derived percentage bar", () => {
    const output = formatAccountUsageText({ status: "ok", fetchedAtMs: 1,
      onDemand: { state: "fixed", hardLimitDollars: 10, remainingDollars: 7.5 } })
    const demandLine = output.split("\n").find(line => line.startsWith("On-Demand"))
    expect(demandLine).toContain("$2.50 of $10.00 used")
    expect(demandLine).not.toContain("█")
    expect(demandLine).not.toContain("░")
    expect(demandLine).not.toContain("% used")
    expect(demandLine).not.toContain("········")
  })

  it("keeps partial limits, unlimited usage, and zero distinct from missing", () => {
    const partial = formatAccountUsageText({ status: "ok", fetchedAtMs: 1,
      onDemand: { state: "fixed", hardLimitDollars: 10 } })
    expect(partial).toContain("On-Demand  $10.00 monthly limit")
    expect(partial).toContain("$10.00 monthly limit")
    expect(partial).not.toContain("0%")
    const unlimited = formatAccountUsageText({ status: "ok", fetchedAtMs: 1,
      onDemand: { state: "unlimited" } })
    expect(unlimited).toContain("No monthly limit")
    expect(unlimited).not.toContain("$0.00")
    const zero = formatAccountUsageText({ status: "ok", fetchedAtMs: 1,
      plan: { totalSpendDollars: 0, limitDollars: 0, remainingDollars: 0 },
      onDemand: { state: "fixed", hardLimitDollars: 0, remainingDollars: 0 } })
    expect(zero).toContain("$0.00 of $0.00 used")
    expect(zero).toContain("$0.00 remaining")
    expect(zero).not.toContain("NaN")
  })

  it("sanitizes invalid dates and numeric values rather than displaying them", () => {
    for (const invalid of [NaN, Infinity, -1]) {
      const output = formatAccountUsageText({ status: "ok", fetchedAtMs: 1,
        billingCycleEndMs: invalid,
        plan: { totalPercentUsed: invalid, autoPercentUsed: invalid, apiPercentUsed: invalid,
          totalSpendDollars: invalid, limitDollars: invalid },
        onDemand: { state: "fixed", hardLimitDollars: invalid, remainingDollars: invalid } })
      expect(output).toContain("Usage · Reset date unavailable")
      expect(output).toContain("Included   ········   unavailable")
      expect(output).not.toMatch(/NaN|Infinity|Invalid Date|\$-|-1%/)
    }
    expect(formatAccountUsageText({ status: "ok", fetchedAtMs: 1, billingCycleEndMs: 1e20 }))
      .toContain("Reset date unavailable")
  })

  it("renders reported plan spend without inferring server percentages", () => {
    const output = formatAccountUsageText({ status: "ok", fetchedAtMs: 1,
      plan: { totalSpendDollars: 3, limitDollars: 20, remainingDollars: 17,
        autoSpendDollars: 1, autoLimitDollars: 10, apiSpendDollars: 2, apiLimitDollars: 10 } })
    expect(output).toContain("Included   ········   unavailable")
    expect(output).toContain("$3.00 of $20.00 used")
    expect(output).toContain("$17.00 remaining")
    expect(output).toContain("$1.00 of $10.00 used")
    expect(output).toContain("$2.00 of $10.00 used")
  })

  it("ignores arbitrary error text and returns only status-based failures", () => {
    expect(formatAccountUsageText({ status: "auth", fetchedAtMs: 1, error: "secret\nhttps://evil.test" }))
      .toBe("Usage unavailable (auth required)")
    expect(formatAccountUsageText({ status: "transient", fetchedAtMs: 1, error: "secret" }))
      .toBe("Usage unavailable (temporary error)")
  })

  it("keeps rows short and does not report negative spend for inconsistent balances", () => {
    const output = formatAccountUsageText({ status: "ok", fetchedAtMs: 1,
      plan: { totalPercentUsed: 80, totalSpendDollars: 1234, limitDollars: 1500, remainingDollars: 266 },
      onDemand: { state: "fixed", hardLimitDollars: 10, remainingDollars: 20 } })
    expect(output.split("\n").every(line => line.length <= 72)).toBe(true)
    expect(output).not.toContain("$-10.00")
    expect(output).toContain("On-Demand  $10.00 monthly limit")
    expect(output).toContain("$10.00 monthly limit")
  })

  it("preserves available partial dollar values", () => {
    const output = formatAccountUsageText({ status: "ok", fetchedAtMs: 1,
      plan: { totalSpendDollars: 0, remainingDollars: 5, autoLimitDollars: 10 },
      onDemand: { state: "fixed", remainingDollars: 0 } })
    expect(output).toContain("$0.00 used")
    expect(output).toContain("$5.00 remaining")
    expect(output).toContain("$10.00 monthly limit")
    expect(output).toContain("$0.00 remaining")
  })
})
