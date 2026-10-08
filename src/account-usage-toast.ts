import type { CursorAccountUsageSnapshot } from "./account-usage.js"

export type UsageToastVariant = "info" | "success" | "warning" | "error"
export type UsageToast = { title: string; message: string; variant: UsageToastVariant }

/**
 * Bar geometry.
 *
 * Codex uses 8 cells; a toast box auto-sizes to its longest line and 8 cells
 * left this one visibly narrower than the Codex quota toast. 12 cells both
 * widens the row and adds resolution, so 96% and 100% no longer render
 * identically.
 */
const BAR_WIDTH = 12
/** Wide enough that `100% left` and ` 96% left` share one column edge. */
const USAGE_WIDTH = 9

function valid(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Clamp a server-reported percentage into a displayable 0-100 range. */
function percentUsed(value: number | undefined): number | undefined {
  const used = valid(value)
  return used === undefined ? undefined : Math.min(100, used)
}

/**
 * Bars show the **remainder**, not the consumption.
 *
 * A used-oriented bar renders a healthy account as a full row of light cells,
 * which reads as a solid grey block and looks broken. Cursor reports
 * `*PercentUsed`; `100 - used` is the same server-reported figure read the way
 * a quota is normally read, and it is never a value Cursor did not report.
 */
function remainingBar(used: number): string {
  const remaining = 100 - used
  const filled = Math.round((remaining / 100) * BAR_WIDTH)
  return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`
}

function resetSuffix(endMs: number | undefined): string {
  if (endMs === undefined || !Number.isFinite(new Date(endMs).getTime())) return ""
  const day = new Date(endMs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
  return ` · Resets ${day}`
}

type Row = { label: string; value: string }

function onDemandText(snapshot: CursorAccountUsageSnapshot): string | undefined {
  const onDemand = snapshot.onDemand
  if (!onDemand || onDemand.state === "unavailable") return undefined
  if (onDemand.state === "disabled") return "Off"
  if (onDemand.state === "unlimited") return "No limit"
  const remaining = valid(onDemand.remainingDollars)
  const limit = valid(onDemand.hardLimitDollars)
  if (remaining !== undefined && limit !== undefined && remaining <= limit) {
    return `$${remaining.toFixed(2)} of $${limit.toFixed(2)} left`
  }
  if (remaining !== undefined) return `$${remaining.toFixed(2)} left`
  return "No limit"
}

function peak(snapshot: CursorAccountUsageSnapshot): number | undefined {
  const values = [snapshot.plan?.totalPercentUsed, snapshot.plan?.autoPercentUsed, snapshot.plan?.apiPercentUsed]
    .map(percentUsed)
    .filter((value): value is number => value !== undefined)
  return values.length === 0 ? undefined : Math.max(...values)
}

export function renderUsageToastMessage(snapshot: CursorAccountUsageSnapshot): string {
  const header = `Usage${resetSuffix(snapshot.billingCycleEndMs)}`
  const rows: Row[] = []

  const planRows: Array<[string, number | undefined, number | undefined, number | undefined]> = [
    ["Included", snapshot.plan?.totalPercentUsed, snapshot.plan?.totalSpendDollars, snapshot.plan?.limitDollars],
    ["Auto", snapshot.plan?.autoPercentUsed, snapshot.plan?.autoSpendDollars, snapshot.plan?.autoLimitDollars],
    ["API", snapshot.plan?.apiPercentUsed, snapshot.plan?.apiSpendDollars, snapshot.plan?.apiLimitDollars],
  ]
  for (const [label, reported, spend, limit] of planRows) {
    const used = percentUsed(reported)
    // Only what Cursor actually reported earns a row. A window nothing has
    // consumed reads 0, and a window it does not report reads absent; either
    // way the row is pure noise, so the toast stays as short as the account
    // state allows.
    if (used === undefined || used === 0) continue
    const usage = `${Math.round(100 - used)}% left`.padStart(USAGE_WIDTH)
    // Spend against the limit is a different kind of fact from the percentage
    // (plan-pool utilization, which can include bonus credit), and it is the
    // per-row equivalent of the Codex toast's `· resets <duration>` suffix.
    const spent = valid(spend)
    const cap = valid(limit)
    const money = spent !== undefined && cap !== undefined ? ` · $${spent.toFixed(2)} of $${cap.toFixed(2)}` : ""
    rows.push({ label, value: `${remainingBar(used)}  ${usage}${money}` })
  }

  const demand = onDemandText(snapshot)
  if (demand !== undefined) rows.push({ label: "On-Demand", value: demand })

  if (rows.length === 0) return "Usage unavailable"
  const labelWidth = Math.max(...rows.map((row) => row.label.length))
  return [header, ...rows.map((row) => `${row.label.padEnd(labelWidth)}  ${row.value}`)].join("\n")
}

export function toastBodyFromSnapshot(snapshot: CursorAccountUsageSnapshot): UsageToast {
  if (snapshot.status !== "ok") {
    return {
      title: snapshot.status === "auth" ? "Cursor usage unavailable" : "Cursor usage error",
      message: `Usage unavailable (${snapshot.status === "auth" ? "auth required" : "temporary error"})`,
      variant: snapshot.status === "auth" ? "warning" : "error",
    }
  }
  const value = peak(snapshot)
  return {
    title: "Cursor usage",
    variant: value === undefined ? "info" : value >= 90 ? "error" : value >= 75 ? "warning" : "info",
    message: renderUsageToastMessage(snapshot),
  }
}
