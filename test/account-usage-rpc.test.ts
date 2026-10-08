import { describe, expect, it } from "bun:test"
import { accountUsageRpcContract, CURSOR_ACCOUNT_USAGE_RPC_ID } from "../src/account-usage-rpc.js"

// Minimal JSON-Schema-subset validator mirroring the host runtime validation
// surface: type, required, additionalProperties:false, enum, maxLength.
function validate(schema: any, value: unknown, path = "$", errors: string[] = []): string[] {
  if (schema.enum) {
    if (!schema.enum.includes(value)) errors.push(`${path}: value not in enum`)
    return errors
  }
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path}: expected object`)
        return errors
      }
      const record = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (!(key in record)) errors.push(`${path}: missing required ${key}`)
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in (schema.properties ?? {}))) errors.push(`${path}: extra property ${key}`)
        }
      }
      for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
        if (key in record) validate(propertySchema, record[key], `${path}.${key}`, errors)
      }
      return errors
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path}: expected number`)
      return errors
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`)
      return errors
    case "string": {
      if (typeof value !== "string") {
        errors.push(`${path}: expected string`)
        return errors
      }
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
        errors.push(`${path}: exceeds maxLength`)
      }
      return errors
    }
    default:
      return errors
  }
}

const sampleSnapshot = {
  status: "ok",
  fetchedAtMs: 1767225600000,
  billingCycleStartMs: 1761868800000,
  billingCycleEndMs: 1764547200000,
  enabled: true,
  plan: {
    totalSpendDollars: 2.5,
    includedSpendDollars: 2,
    remainingDollars: 17.5,
    limitDollars: 20,
    autoPercentUsed: 8.3333,
    apiPercentUsed: 25,
    totalPercentUsed: 12.5,
  },
  onDemand: { state: "fixed", hardLimitDollars: 10, remainingDollars: 7.5 },
}

describe("account usage RPC", () => {
  it("publishes a stable empty-input display snapshot contract", () => {
    expect(CURSOR_ACCOUNT_USAGE_RPC_ID).toBe("cursor-opencode-provider.account-usage")
    expect(accountUsageRpcContract.id).toBe(CURSOR_ACCOUNT_USAGE_RPC_ID)
    expect(accountUsageRpcContract.methods.usage.input).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
      required: [],
    })
    expect(accountUsageRpcContract.methods.usage.output.required).toContain("status")
    expect(accountUsageRpcContract.methods.usage.output.additionalProperties).toBe(false)
  })

  it("matches the runtime Rpc.Definition shape from the installed host package", () => {
    // Runtime Rpc.define (installed @opencode/schema/rpc via @opencode/plugin)
    // defines Definition as { id, methods, events } — events is mandatory and
    // define() only rejects method error names starting with "rpc.".
    expect(Object.keys(accountUsageRpcContract).sort()).toEqual(["events", "id", "methods"])
    expect(accountUsageRpcContract.events).toEqual({})
    expect(Object.keys(accountUsageRpcContract.methods)).toEqual(["usage"])
    for (const method of Object.values(accountUsageRpcContract.methods) as Array<{ input: unknown; output: unknown; errors?: Record<string, unknown> }>) {
      expect(typeof method.input).toBe("object")
      expect(typeof method.output).toBe("object")
      expect(Object.keys(method.errors ?? {})).toEqual([])
    }
  })

  it("describes every snapshot property, including nested objects", () => {
    const output = accountUsageRpcContract.methods.usage.output
    const outputProperties = output.properties as Record<string, any>
    expect(Object.keys(outputProperties).sort()).toEqual(
      [
        "status",
        "fetchedAtMs",
        "error",
        "billingCycleStartMs",
        "billingCycleEndMs",
        "enabled",
        "plan",
        "onDemand",
      ].sort(),
    )
    for (const nested of ["plan", "onDemand"]) {
      expect(outputProperties[nested].type).toBe("object")
      expect(outputProperties[nested].additionalProperties).toBe(false)
      expect(Object.keys(outputProperties[nested].properties ?? {}).length).toBeGreaterThan(0)
    }
    expect(outputProperties.plan.properties.totalPercentUsed).toEqual({ type: "number" })
    expect(outputProperties.onDemand.properties.state.enum).toEqual([
      "fixed",
      "unlimited",
      "disabled",
      "unavailable",
    ])
    expect(output.properties.error.maxLength).toBeGreaterThan(0)
  })

  it("validates a real snapshot against the output schema", () => {
    expect(validate(accountUsageRpcContract.methods.usage.output, sampleSnapshot)).toEqual([])
  })

  it("rejects extra top-level and nested properties", () => {
    const output = accountUsageRpcContract.methods.usage.output
    expect(validate(output, { ...sampleSnapshot, displayMessage: "untrusted" }).length).toBeGreaterThan(0)
    expect(
      validate(output, { ...sampleSnapshot, plan: { ...sampleSnapshot.plan, bonusTooltip: "untrusted" } }).length,
    ).toBeGreaterThan(0)
    expect(
      validate(output, { ...sampleSnapshot, onDemand: { ...sampleSnapshot.onDemand, scope: "team" } }).length,
    ).toBeGreaterThan(0)
  })

  it("rejects untrusted error text and wrong statuses", () => {
    const output = accountUsageRpcContract.methods.usage.output
    expect(validate(output, { ...sampleSnapshot, error: "x".repeat(201) }).length).toBeGreaterThan(0)
    expect(validate(output, { ...sampleSnapshot, status: "expired" }).length).toBeGreaterThan(0)
    expect(validate(output, { status: "auth", fetchedAtMs: 1, error: "unavailable (auth required)" })).toEqual([])
  })
})
