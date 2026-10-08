import type {
  CursorAccountUsageSnapshot,
} from "./account-usage.js"

export const CURSOR_ACCOUNT_USAGE_RPC_ID = "cursor-opencode-provider.account-usage"

// Shape note: the installed OpenCode 2.0 runtime defines the RPC contract via
// `Rpc.define` (re-exported from `@opencode/schema/rpc` through
// `@opencode/plugin`). Runtime `Definition` = `{ id, methods, events }` where
// `events` is mandatory, each method takes `{ input, output, errors? }`, and
// `define()` rejects only method error names starting with `"rpc."`. Method
// input/output are `PortableValueSchema`: an Effect Schema, a
// StandardSchemaV1, or a plain JSON Schema object. This contract uses the same
// plain-JSON-Schema form as the reference integration (opencode-codex-usage
// `lib/opencode2-rpc.ts`) and is validated by the host with
// `additionalProperties: false` everywhere, so extra or untrusted fields are
// rejected at runtime. This repo duck-types the host — it does not import
// `@opencode/plugin`.

const numberSchema = { type: "number" } as const

const planSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    totalSpendDollars: numberSchema,
    includedSpendDollars: numberSchema,
    bonusSpendDollars: numberSchema,
    remainingDollars: numberSchema,
    limitDollars: numberSchema,
    autoSpendDollars: numberSchema,
    apiSpendDollars: numberSchema,
    autoLimitDollars: numberSchema,
    apiLimitDollars: numberSchema,
    autoPercentUsed: numberSchema,
    apiPercentUsed: numberSchema,
    totalPercentUsed: numberSchema,
  },
} as const

const onDemandSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: { type: "string", enum: ["fixed", "unlimited", "disabled", "unavailable"] },
    hardLimitDollars: numberSchema,
    remainingDollars: numberSchema,
  },
} as const

/**
 * Snapshot contract for the `usage` RPC method. Only the whitelisted display
 * snapshot properties appear; `error` is a classified fixed phrase (bounded
 * length), never upstream text. `fetchedAtMs` is always present alongside
 * `status`.
 */
export const accountUsageRpcContract = {
  id: CURSOR_ACCOUNT_USAGE_RPC_ID,
  methods: {
    usage: {
      input: { type: "object", properties: {}, additionalProperties: false, required: [] },
      output: {
        type: "object",
        required: ["status", "fetchedAtMs"],
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["ok", "auth", "transient"] },
          fetchedAtMs: numberSchema,
          error: { type: "string", maxLength: 200 },
          billingCycleStartMs: numberSchema,
          billingCycleEndMs: numberSchema,
          enabled: { type: "boolean" },
          plan: planSchema,
          onDemand: onDemandSchema,
        },
      },
    },
  },
  events: {},
} as const

export type AccountUsageRpcHandlers = {
  usage: (input: Record<string, never>) => Promise<CursorAccountUsageSnapshot>
}
