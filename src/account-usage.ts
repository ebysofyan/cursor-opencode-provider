import { createHash } from "node:crypto"
import { CURSOR_API_HOST, FALLBACK_CLIENT_VERSION } from "./shared.js"
import { withAbortDeadline } from "./deadline.js"
import { buildBaseHeaders } from "./transport/connect.js"
import { resolveClientVersion } from "./protocol/client-version.js"
import { isExchangeableApiKey } from "./auth.js"
import {
  CursorAuthError,
  CursorProtocolError,
  CursorServerError,
  CursorTransportError,
  cursorHttpError,
  errorCode,
} from "./errors.js"

export type AccountUsageStatus = "ok" | "auth" | "transient"

export type CursorAccountUsagePlan = {
  totalSpendDollars?: number
  includedSpendDollars?: number
  bonusSpendDollars?: number
  remainingDollars?: number
  limitDollars?: number
  autoSpendDollars?: number
  apiSpendDollars?: number
  autoLimitDollars?: number
  apiLimitDollars?: number
  autoPercentUsed?: number
  apiPercentUsed?: number
  totalPercentUsed?: number
}

export type CursorAccountUsageOnDemand = {
  state: "fixed" | "unlimited" | "disabled" | "unavailable"
  hardLimitDollars?: number
  remainingDollars?: number
}

export type CursorAccountUsageSnapshot = {
  status: AccountUsageStatus
  error?: string
  fetchedAtMs: number
  billingCycleStartMs?: number
  billingCycleEndMs?: number
  enabled?: boolean
  plan?: CursorAccountUsagePlan
  onDemand?: CursorAccountUsageOnDemand
}

export type BearerSource = () => Promise<string>
export type AccountUsageCacheOptions = {
  bearer: BearerSource
  baseUrl?: string
  timeoutMs?: number
  now?: () => number
  fetchFn?: typeof fetch
  /** Test seam; defaults to the real memoized resolver (env → local install → remote → fallback). */
  resolveClientVersion?: () => Promise<string>
}
export type AccountUsageCache = { snapshot: () => Promise<CursorAccountUsageSnapshot> }

const USAGE_PATH = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
const HARD_LIMIT_PATH = "/aiserver.v1.DashboardService/GetHardLimit"
const DEFAULT_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 60_000
/** Best-effort companion call: bounded separately so it can never sink the primary. */
const HARD_LIMIT_TIMEOUT_MS = 2_000
/** Cached accounts are bounded; the oldest insertion is evicted. */
const MAX_CACHE_ENTRIES = 8
/** GetHardLimitResponse.hard_limit sentinel: no usage-based on-demand ceiling. */
const UNLIMITED_HARD_LIMIT = 2_147_483_647
/** Billing-cycle millis must decode to a plausible date (1970..2100). */
const MAX_VALID_EPOCH_MS = 4_102_444_800_000

const AUTH_UNAVAILABLE = "unavailable (auth required)"
const TRANSIENT_UNAVAILABLE = "unavailable (temporary error)"

function cents(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value / 100 : undefined
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Billing-cycle bounds arrive as numeric int64 epoch millis (camelCase in the
 * Connect JSON response). Only positive, integral, plausibly dated values are
 * accepted; malformed strings, zero, negatives, fractions, and far-future
 * garbage are absent rather than coerced.
 */
function epochMs(value: unknown): number | undefined {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined
  return number !== undefined && Number.isSafeInteger(number) && number > 0 && number <= MAX_VALID_EPOCH_MS
    ? number
    : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Parse the GetCurrentPeriodUsage response (plus the optional best-effort
 * GetHardLimit response) into the display snapshot. Only verified fields are
 * read; upstream display text, promotion blocks, and model buckets are
 * dropped, and missing values stay absent — never zero.
 *
 * Units: every `*Spend`/`*Remaining`/`*Limit` money field in the period-usage
 * response is **cents**; GetHardLimitResponse.hard_limit is already **dollars**
 * (Cursor CLI renders it without a cents conversion).
 */
export function parseAccountUsageResponse(body: unknown, fetchedAtMs: number, hardLimitBody?: unknown): CursorAccountUsageSnapshot {
  const root = record(body) ?? {}
  const plan = record(root.planUsage)
  const limits = record(root.spendLimitUsage)
  const hard = record(hardLimitBody)
  const hardLimitDollars = finiteNumber(hard?.hardLimit)
  const hardLimitBlocked = hard?.noUsageBasedAllowed === true
    || hard?.onDemandSpendDisabledByOrganization === true

  let onDemand: CursorAccountUsageOnDemand | undefined
  if (hardLimitBlocked) {
    onDemand = { state: "disabled" }
  } else if (hardLimitDollars !== undefined) {
    onDemand = hardLimitDollars >= UNLIMITED_HARD_LIMIT
      ? { state: "unlimited" }
      : hardLimitDollars > 0
        ? { state: "fixed", hardLimitDollars, remainingDollars: cents(limits?.individualRemaining) }
        : { state: "disabled" }
  } else {
    // Without the best-effort hard-limit response, a team-scoped pooled budget
    // says nothing about this member's on-demand ceiling: stay conservative.
    const teamScoped = limits?.limitType === "team"
    const individualLimitDollars = cents(limits?.individualLimit)
    onDemand = !teamScoped && individualLimitDollars !== undefined && individualLimitDollars > 0
      ? { state: "fixed", hardLimitDollars: individualLimitDollars, remainingDollars: cents(limits?.individualRemaining) }
      : { state: "unavailable" }
  }

  return {
    status: "ok",
    fetchedAtMs,
    billingCycleStartMs: epochMs(root.billingCycleStart),
    billingCycleEndMs: epochMs(root.billingCycleEnd),
    enabled: typeof root.enabled === "boolean" ? root.enabled : undefined,
    plan: plan ? {
      totalSpendDollars: cents(plan.totalSpend),
      includedSpendDollars: cents(plan.includedSpend),
      bonusSpendDollars: cents(plan.bonusSpend),
      remainingDollars: cents(plan.remaining),
      limitDollars: cents(plan.limit),
      autoSpendDollars: cents(plan.autoSpend),
      apiSpendDollars: cents(plan.apiSpend),
      autoLimitDollars: cents(plan.autoLimit),
      apiLimitDollars: cents(plan.apiLimit),
      autoPercentUsed: percent(plan.autoPercentUsed),
      apiPercentUsed: percent(plan.apiPercentUsed),
      totalPercentUsed: percent(plan.totalPercentUsed),
    } : undefined,
    onDemand,
  }
}

function timeoutMs(value: number | undefined): number {
  const candidate = value ?? DEFAULT_TIMEOUT_MS
  return Math.max(1_000, Math.min(30_000, Number.isFinite(candidate) ? candidate : DEFAULT_TIMEOUT_MS))
}

function usageTimeoutError(ms: number): CursorServerError {
  return new CursorServerError(`Cursor usage request timed out after ${ms}ms`, {
    transient: true,
    replaySafe: true,
    code: "CURSOR_ACCOUNT_USAGE_TIMEOUT",
  })
}

function wrapNetworkError(cause: unknown): CursorServerError | CursorProtocolError | CursorTransportError {
  if (cause instanceof CursorAuthError || cause instanceof CursorServerError || cause instanceof CursorProtocolError) {
    return cause
  }
  return new CursorTransportError("Cursor usage network request failed", {
    transient: true,
    replaySafe: true,
    code: errorCode(cause),
    cause,
  })
}

type ProbeDeps = {
  token: string
  baseUrl: string
  timeoutMs: number
  now: () => number
  fetchFn: typeof fetch
  clientVersion: string
}

async function postJson(deps: ProbeDeps, path: string, signal: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await deps.fetchFn(`${deps.baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...buildBaseHeaders(deps.token, deps.clientVersion),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
      signal,
    })
  } catch (cause) {
    throw wrapNetworkError(cause)
  }
  if (!response.ok) throw cursorHttpError("Cursor usage request failed with", response.status)
  try {
    return await response.json()
  } catch (cause) {
    throw new CursorProtocolError("Cursor usage response was malformed", { cause })
  }
}

/**
 * Primary probe under one finite deadline that covers headers *and* body. The
 * GetHardLimit companion call runs afterwards under its own shorter deadline:
 * a hung, failing, or slow hard-limit call must never turn a good primary
 * snapshot into a failure.
 */
type FetchSnapshotDeps = Omit<ProbeDeps, "clientVersion"> & { clientVersion: () => Promise<string> }

async function fetchSnapshot(deps: FetchSnapshotDeps): Promise<CursorAccountUsageSnapshot> {
  const fetchedAtMs = deps.now()
  let clientVersion: string
  try {
    clientVersion = await deps.clientVersion()
  } catch {
    clientVersion = FALLBACK_CLIENT_VERSION
  }
  const probe: ProbeDeps = { ...deps, clientVersion }
  const current = await withAbortDeadline(
    deps.timeoutMs,
    () => usageTimeoutError(deps.timeoutMs),
    (signal) => postJson(probe, USAGE_PATH, signal),
  )
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new CursorProtocolError("Cursor usage response was malformed")
  }
  let hardLimit: Record<string, unknown> | undefined
  try {
    const hardTimeoutMs = Math.min(deps.timeoutMs, HARD_LIMIT_TIMEOUT_MS)
    const hardResult = await withAbortDeadline(
      hardTimeoutMs,
      () => usageTimeoutError(hardTimeoutMs),
      (signal) => postJson(probe, HARD_LIMIT_PATH, signal),
    )
    if (hardResult && typeof hardResult === "object" && !Array.isArray(hardResult)) {
      hardLimit = hardResult as Record<string, unknown>
    }
  } catch {
    // On-demand status is best-effort; the primary period usage stands alone.
  }
  return parseAccountUsageResponse(current, fetchedAtMs, hardLimit)
}

function failureSnapshot(error: unknown, now: () => number): CursorAccountUsageSnapshot {
  if (error instanceof CursorAuthError) return { status: "auth", fetchedAtMs: now(), error: AUTH_UNAVAILABLE }
  return { status: "transient", fetchedAtMs: now(), error: TRANSIENT_UNAVAILABLE }
}

/** A raw `crsr_` key is never a valid Bearer; it must be exchanged first. */
function requireExchangedToken(token: string): string {
  if (!token || token.trim() === "") {
    throw new CursorAuthError("Cursor usage requires a signed-in account; sign in to Cursor again")
  }
  if (isExchangeableApiKey(token)) {
    throw new CursorAuthError("Cursor usage received an unexchanged API key; pass the exchanged token instead")
  }
  return token
}

/**
 * Account-scoped cache: one in-flight probe and one TTL entry per credential
 * fingerprint, so switching accounts never serves another account's snapshot.
 * The map is bounded (oldest insertion evicted) and failures are never cached.
 */
export function createAccountUsageCache(options: AccountUsageCacheOptions): AccountUsageCache {
  const now = options.now ?? Date.now
  const fetchFn = options.fetchFn ?? fetch
  const clientVersion = options.resolveClientVersion ?? resolveClientVersion
  const baseUrl = (options.baseUrl ?? `https://${CURSOR_API_HOST}`).replace(/\/$/, "")
  const duration = timeoutMs(options.timeoutMs ?? Number(process.env.CURSOR_ACCOUNT_USAGE_TIMEOUT_MS))
  const cached = new Map<string, CursorAccountUsageSnapshot>()
  const inFlight = new Map<string, Promise<CursorAccountUsageSnapshot>>()

  const fingerprint = (token: string): string =>
    createHash("sha256").update(`bearer:${token}`).digest("hex").slice(0, 16)

  function freezeSnapshot(snapshot: CursorAccountUsageSnapshot): CursorAccountUsageSnapshot {
    if (snapshot.plan) Object.freeze(snapshot.plan)
    if (snapshot.onDemand) Object.freeze(snapshot.onDemand)
    return Object.freeze(snapshot)
  }

  const cachedOrFetch = async (token: string): Promise<CursorAccountUsageSnapshot> => {
    const key = fingerprint(token)
    const existing = cached.get(key)
    if (existing && now() - existing.fetchedAtMs < CACHE_TTL_MS) {
      // Refresh recency so eviction keeps the hottest accounts.
      cached.delete(key)
      cached.set(key, existing)
      return existing
    }
    const pending = inFlight.get(key)
    if (pending) return pending
    const request = fetchSnapshot({ token, baseUrl, now, fetchFn, timeoutMs: duration, clientVersion })
      .then((snapshot) => {
        cached.delete(key)
        cached.set(key, freezeSnapshot(snapshot))
        while (cached.size > MAX_CACHE_ENTRIES) {
          const oldest = cached.keys().next().value
          if (oldest === undefined) break
          cached.delete(oldest)
        }
        return cached.get(key)!
      })
      .catch((error) => failureSnapshot(error, now))
      .finally(() => { inFlight.delete(key) })
    inFlight.set(key, request)
    return request
  }

  return {
    snapshot: async () => {
      try {
        return await cachedOrFetch(requireExchangedToken(await options.bearer()))
      } catch (error) {
        return failureSnapshot(error, now)
      }
    },
  }
}

export function resetAccountUsageCacheForTests(): void {
  // Cache instances are intentionally process-local; retained for API symmetry.
}
