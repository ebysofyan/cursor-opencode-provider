import { accountUsageRpcContract, CURSOR_ACCOUNT_USAGE_RPC_ID } from "./account-usage-rpc-contract.js"
import type { AccountUsageCache } from "../account-usage.js"
import type { Registration, RpcDomain } from "./types.js"

/**
 * Drop keys whose value is `undefined`, recursively.
 *
 * The snapshot models absent values as `undefined` so the pure formatters can
 * tell "not reported" from a real zero. The RPC wire format does not: an
 * explicitly-undefined member is serialized as `null`, and the host rejects
 * that against the declared schema (`rpc.invalid_output: Expected number at
 * ["plan"]["bonusSpendDollars"]`). So the payload must omit absent keys
 * entirely rather than carry them.
 */
function omitUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(omitUndefined) as unknown as T
  if (value === null || typeof value !== "object") return value
  const result: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (member === undefined) continue
    result[key] = omitUndefined(member)
  }
  return result as T
}

/**
 * Server-side RPC bridge for the OpenCode 2.0 TUI slash command. The TUI
 * process calls `client.rpc(<this contract>).usage({})`; this handler answers
 * from the same shared account-usage cache the `cursor_usage` tool uses — the
 * TUI never resolves credentials, runs the probe, or holds a cache.
 */
export async function registerCursorAccountUsageRpc(
  rpc: Pick<RpcDomain, "register">,
  deps: { cache: AccountUsageCache },
): Promise<Registration> {
  return await rpc.register(accountUsageRpcContract, {
    usage: async () => omitUndefined(await deps.cache.snapshot()),
  })
}

export { CURSOR_ACCOUNT_USAGE_RPC_ID }
