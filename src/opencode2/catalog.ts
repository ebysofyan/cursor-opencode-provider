import { pathToFileURL } from "node:url"
import { CURSOR_PROVIDER_ID } from "../shared.js"
import { CURSOR_WIRE_MODEL_ID_KEY, type ModelInfo } from "../models.js"
import { modelsToConfig } from "../model-config.js"
import { toOpenCode2Costs, type OpenCode2ModelCost, type OpenCodeModelCost } from "../pricing.js"
import type { CatalogDraft, ModelVariantInfo } from "./types.js"

/**
 * Catalog registration for the OpenCode 2.0 plugin — the replacement for the
 * classic plugin's `config` hook.
 *
 * Model naming, thinking suffixes, and long-context tiering are NOT reimplemented
 * here: we run the shared `modelsToConfig` and translate its output into the 2.0
 * `Model.Info` shape, so every surface exposes an identical model list.
 */

/** Integration id owning Cursor credentials. Matches the provider id. */
export const CURSOR_INTEGRATION_ID = CURSOR_PROVIDER_ID

/**
 * `aisdk:` selects OpenCode 2.0's AI SDK path, which is what surfaces the
 * `aisdk.hook("sdk")` / `("language")` extension points we supply the provider
 * through. The suffix is this package's npm name so the host's built-in
 * `DynamicProviderPlugin` can still resolve it if our own hook is ever
 * bypassed — that fallback runs `npm.add(pkg)` against the *published*
 * registry into `<host-cache>/packages/<pkg>/node_modules/<pkg>`, ignoring
 * any local `file://` plugin path this process was loaded from.
 *
 * `CURSOR_OPENCODE2_DEV_ENTRY` overrides the suffix with an `aisdk:file://…`
 * spec instead, pointed at a local built entry file (e.g. `dist/index.js`,
 * which exports `createCursor`). The host's fallback recognizes `file://`
 * specs and imports them directly, skipping `npm.add` — the only way to
 * exercise a local build through that fallback path short of publishing.
 * Unset in production; only meant for local `opencode2 run` testing.
 */
export const CURSOR_AISDK_PACKAGE = process.env.CURSOR_OPENCODE2_DEV_ENTRY
  ? `aisdk:${pathToFileURL(process.env.CURSOR_OPENCODE2_DEV_ENTRY).href}`
  : "aisdk:cursor-opencode-provider"

/**
 * Plain-object `Model.Info` equivalent used by both `ctx.catalog` (beta) and
 * `providers.cursor.models` config sync (stable). Keep one translator so the
 * surfaces cannot drift.
 */
export type CatalogModelInfo = {
  name: string
  modelID: string
  capabilities: {
    tools: boolean
    input: string[]
    output: string[]
  }
  limit: {
    context: number
    output: number
  }
  variants: ModelVariantInfo[]
  status: "active"
  enabled: true
  time: { released: number }
  cost: OpenCode2ModelCost[]
  settings?: Record<string, unknown>
}

/** Translate one `modelsToConfig` entry into the 2.0 `Model.Info` shape. */
export function modelConfigEntryToInfo(id: string, entry: Record<string, any>): CatalogModelInfo {
  const options = entry.options as Record<string, unknown> | undefined
  // Long-context and Fast entries get synthetic OpenCode ids (`<id>-1m`,
  // `<id>-fast`, `<id>-1m-fast`) while still addressing the same Cursor model
  // on the wire. V1 smuggled that through provider options; 2.0 has a
  // first-class `modelID` for exactly this.
  const wireId =
    typeof options?.[CURSOR_WIRE_MODEL_ID_KEY] === "string"
      ? (options[CURSOR_WIRE_MODEL_ID_KEY] as string)
      : id

  const variants: ModelVariantInfo[] = Object.entries(
    (entry.variants ?? {}) as Record<string, Record<string, unknown>>,
  ).map(([variantId, settings]) => ({ id: variantId, settings: { ...settings } }))

  const inputModalities = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.filter((modality: unknown): modality is string => typeof modality === "string")
    : ["text"]
  const outputModalities = Array.isArray(entry.modalities?.output)
    ? entry.modalities.output.filter((modality: unknown): modality is string => typeof modality === "string")
    : ["text"]

  const info: CatalogModelInfo = {
    name: entry.name ?? id,
    modelID: wireId,
    capabilities: {
      tools: entry.tool_call !== false,
      input: inputModalities,
      output: outputModalities,
    },
    limit: {
      context: entry.limit?.context ?? 200_000,
      output: entry.limit?.output ?? 8192,
    },
    variants,
    status: "active",
    enabled: true,
    time: { released: 0 },
    cost: toOpenCode2Costs(entry.cost as OpenCodeModelCost | undefined),
  }
  if (options) info.settings = { ...options }
  return info
}

/** Full model map for catalog draft *or* `providers.cursor.models` config. */
export function modelsToCatalogModelMap(models: ModelInfo[]): Record<string, CatalogModelInfo> {
  const config = modelsToConfig(models)
  const out: Record<string, CatalogModelInfo> = {}
  for (const [id, entry] of Object.entries(config)) {
    out[id] = modelConfigEntryToInfo(id, entry as Record<string, any>)
  }
  return out
}

/** Register (or update) the Cursor provider entry. `update` is an upsert. */
export function applyCursorProvider(draft: CatalogDraft): void {
  draft.provider.update(CURSOR_PROVIDER_ID, (provider) => {
    provider.id = CURSOR_PROVIDER_ID
    provider.name = "Cursor"
    provider.package = CURSOR_AISDK_PACKAGE
    // Links the provider to the integration that stores its credentials, so
    // `connection.active(...)` resolves the token the user set up via /connect.
    provider.integrationID = CURSOR_INTEGRATION_ID
  })
}

function applyModelEntry(draft: CatalogDraft, id: string, entry: Record<string, any>): void {
  const info = modelConfigEntryToInfo(id, entry)
  draft.model.update(CURSOR_PROVIDER_ID, id, (model) => {
    model.id = id
    model.modelID = info.modelID
    model.providerID = CURSOR_PROVIDER_ID
    model.name = info.name
    model.capabilities = info.capabilities
    model.limit = info.limit
    model.variants = info.variants
    model.status = info.status
    model.enabled = info.enabled
    model.time = info.time
    model.cost = info.cost
    if (info.settings) model.settings = { ...info.settings }
  })
}

/** Register every discovered Cursor model. Safe to re-run; `update` upserts. */
export function applyCursorModels(draft: CatalogDraft, models: ModelInfo[]): void {
  const config = modelsToConfig(models)
  for (const [id, entry] of Object.entries(config)) {
    applyModelEntry(draft, id, entry as Record<string, any>)
  }
}
