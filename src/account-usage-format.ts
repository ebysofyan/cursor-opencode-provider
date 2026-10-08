import type { CursorAccountUsageSnapshot } from "./account-usage.js"

export const CURSOR_USAGE_DASHBOARD_URL = "https://cursor.com/dashboard?tab=usage"

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}

function resetLabel(value: number | undefined): string {
  if (finiteNonNegative(value) === undefined) return "Reset date unavailable"
  const date = new Date(value!)
  if (!Number.isFinite(date.getTime())) return "Reset date unavailable"
  return `Resets ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`
}

export function percentUsed(value: number | undefined): string {
  const valid = finiteNonNegative(value)
  return valid === undefined ? "········   unavailable" : bar(valid)
}

export function bar(value: number): string {
  const filled = Math.max(0, Math.min(8, Math.round(value / 12.5)))
  return `${"█".repeat(filled)}${"░".repeat(8 - filled)}  ${Math.round(value)}% used`
}

function dollarUsage(spend: number | undefined, limit: number | undefined): string {
  const validSpend = finiteNonNegative(spend)
  const validLimit = finiteNonNegative(limit)
  if (validSpend !== undefined && validLimit !== undefined) return `$${validSpend.toFixed(2)} of $${validLimit.toFixed(2)} used`
  if (validSpend !== undefined) return `$${validSpend.toFixed(2)} used`
  if (validLimit !== undefined) return `$${validLimit.toFixed(2)} monthly limit`
  return "unavailable"
}

function remaining(value: number | undefined): string {
  const valid = finiteNonNegative(value)
  return valid === undefined ? "unavailable" : `$${valid.toFixed(2)} remaining`
}

function fixedOnDemand(snapshot: CursorAccountUsageSnapshot): { detail: string } {
  const value = snapshot.onDemand
  if (!value || value.state === "unavailable") return { detail: "unavailable" }
  if (value.state === "disabled") return { detail: "On-demand usage is off" }
  if (value.state === "unlimited") return { detail: "No monthly limit" }
  const limit = finiteNonNegative(value.hardLimitDollars)
  const remaining = finiteNonNegative(value.remainingDollars)
  const consistent = limit !== undefined && remaining !== undefined && remaining <= limit
  const used = consistent ? limit! - remaining! : undefined
  const detail = limit === undefined
    ? (remaining === undefined ? "unavailable" : `$${remaining.toFixed(2)} remaining`)
    : `${used === undefined ? `$${limit.toFixed(2)} monthly limit` : `$${used.toFixed(2)} of $${limit.toFixed(2)} used · $${remaining!.toFixed(2)} remaining`}`
  return { detail }
}

function row(label: string, value: number | undefined, detail?: string): string {
  return `${label.padEnd(10)} ${percentUsed(value)}${detail ? ` · ${detail}` : ""}`
}

function failure(snapshot: CursorAccountUsageSnapshot): string {
  return snapshot.status === "auth"
    ? "Usage unavailable (auth required)"
    : "Usage unavailable (temporary error)"
}

export function formatAccountUsageText(snapshot: CursorAccountUsageSnapshot): string {
  if (snapshot.status !== "ok") return failure(snapshot)
  const plan = snapshot.plan
  const demand = fixedOnDemand(snapshot)
  const includedUsage = dollarUsage(plan?.totalSpendDollars, plan?.limitDollars)
  const includedDetail = includedUsage === "unavailable" && finiteNonNegative(plan?.remainingDollars) === undefined
    ? undefined
    : [includedUsage === "unavailable" ? undefined : includedUsage, remaining(plan?.remainingDollars)]
      .filter((value): value is string => value !== undefined && value !== "unavailable")
      .join(" · ")
  const autoDetail = dollarUsage(plan?.autoSpendDollars, plan?.autoLimitDollars)
  const apiDetail = dollarUsage(plan?.apiSpendDollars, plan?.apiLimitDollars)
  return [
    `Usage · ${resetLabel(snapshot.billingCycleEndMs)}`,
    "Monthly plan and on-demand usage",
    "",
    row("Included", plan?.totalPercentUsed),
    includedDetail ? `  ${includedDetail}` : undefined,
    row("Auto", plan?.autoPercentUsed),
    autoDetail === "unavailable" ? undefined : `  ${autoDetail}`,
    row("API", plan?.apiPercentUsed),
    apiDetail === "unavailable" ? undefined : `  ${apiDetail}`,
    `${"On-Demand".padEnd(10)} ${demand.detail}`,
    "",
    CURSOR_USAGE_DASHBOARD_URL,
  ].filter((line): line is string => line !== undefined).join("\n")
}
