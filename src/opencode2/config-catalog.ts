import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { CURSOR_PROVIDER_ID } from "../shared.js"
import type { ModelInfo } from "../models.js"
import {
  CURSOR_AISDK_PACKAGE,
  CURSOR_INTEGRATION_ID,
  modelsToCatalogModelMap,
} from "./catalog.js"

/**
 * OpenCode 2.0 stable (2.0.5+, e.g. 2.0.6 / 2.0.8) ships `ctx.provider` /
 * `ctx.model` but **no** `ctx.catalog`. Plugin transforms on those split domains
 * do not flush into the live model picker (draft mutations stay invisible to `list()`).
 *
 * Fallback: surgically upsert discovered Cursor models into
 * `providers.cursor` inside `$OPENCODE_CONFIG_DIR/opencode.json(c)` using
 * `jsonc-parser` so comments and unrelated keys are preserved. Beta hosts with
 * `ctx.catalog` never need this path.
 *
 * Safety: parse failure → fail closed (no write). Never rewrite the whole
 * document via `JSON.stringify`.
 */

export type ConfigCatalogSyncResult = {
  path: string
  modelCount: number
  changed: boolean
  /** Why a write was skipped (when `changed` is false for a non-idempotent reason). */
  skipped?: "parse_error" | "unchanged"
}

export type StableDomainReloads = {
  provider?: () => Promise<void> | void
  model?: () => Promise<void> | void
}

export type StableDomainReloadOptions = {
  forceReload?: boolean
}

function configDir(): string {
  return process.env.OPENCODE_CONFIG_DIR?.trim() || join(homedir(), ".config", "opencode")
}

function resolveConfigPath(dir: string): string {
  const jsonc = join(dir, "opencode.jsonc")
  const json = join(dir, "opencode.json")
  if (existsSync(jsonc)) return jsonc
  if (existsSync(json)) return json
  return jsonc
}

function buildCursorProvider(models: ModelInfo[]) {
  return {
    name: "Cursor",
    package: CURSOR_AISDK_PACKAGE,
    integrationID: CURSOR_INTEGRATION_ID,
    models: modelsToCatalogModelMap(models),
  }
}

/**
 * Upsert `providers.cursor` (preferred) with the AI SDK package + full catalog
 * model map. Returns whether the on-disk document changed.
 */
export function syncCursorProvidersConfig(models: ModelInfo[]): ConfigCatalogSyncResult {
  const dir = configDir()
  const path = resolveConfigPath(dir)
  const modelMap = modelsToCatalogModelMap(models)
  const modelCount = Object.keys(modelMap).length
  const nextProvider = buildCursorProvider(models)

  const formatting = { insertSpaces: true, tabSize: 2, keepLines: true as const }

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    // New file: nothing to preserve. Prefer `.jsonc` when that is the resolved path.
    const doc = { providers: { [CURSOR_PROVIDER_ID]: nextProvider } }
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8")
    return { path, modelCount, changed: true }
  }

  const raw = readFileSync(path, "utf8")
  const parseErrors: { error: number; offset: number; length: number }[] = []
  const doc = parse(raw, parseErrors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
  }) as Record<string, unknown> | undefined

  if (parseErrors.length > 0 || doc === undefined || typeof doc !== "object" || Array.isArray(doc)) {
    // Fail closed: never wipe a hand-edited config by rewriting from `{}`.
    return { path, modelCount, changed: false, skipped: "parse_error" }
  }

  const providers =
    doc.providers && typeof doc.providers === "object" && !Array.isArray(doc.providers)
      ? (doc.providers as Record<string, unknown>)
      : {}
  const legacyProvider =
    doc.provider && typeof doc.provider === "object" && !Array.isArray(doc.provider)
      ? (doc.provider as Record<string, unknown>)
      : {}

  const currentProvider = providers[CURSOR_PROVIDER_ID] ?? legacyProvider[CURSOR_PROVIDER_ID]
  const currentManaged =
    currentProvider && typeof currentProvider === "object" && !Array.isArray(currentProvider)
      ? (currentProvider as Record<string, unknown>)
      : undefined
  const prev = JSON.stringify({
    name: currentManaged?.name,
    package: currentManaged?.package,
    integrationID: currentManaged?.integrationID,
    models: currentManaged?.models,
  })
  const next = JSON.stringify({
    name: nextProvider.name,
    package: nextProvider.package,
    integrationID: nextProvider.integrationID,
    models: nextProvider.models,
  })
  const hasPreferredProvider = Object.prototype.hasOwnProperty.call(providers, CURSOR_PROVIDER_ID)

  if (hasPreferredProvider && prev === next) {
    return { path, modelCount, changed: false, skipped: "unchanged" }
  }

  let edited = raw
  // Surgical managed-field updates preserve provider-level keys and comments.
  for (const [field, value] of Object.entries(nextProvider)) {
    edited = applyEdits(
      edited,
      modify(edited, ["providers", CURSOR_PROVIDER_ID, field], value, {
        formattingOptions: formatting,
        isArrayInsertion: false,
      }),
    )
  }

  if (edited === raw) {
    return { path, modelCount, changed: false, skipped: "unchanged" }
  }

  writeFileSync(path, edited.endsWith("\n") ? edited : `${edited}\n`, "utf8")
  return { path, modelCount, changed: true }
}

export async function syncCursorProvidersConfigAndReload(
  models: ModelInfo[],
  reloads: StableDomainReloads,
  options: StableDomainReloadOptions = {},
): Promise<ConfigCatalogSyncResult> {
  const result = syncCursorProvidersConfig(models)
  if (!result.changed && !options.forceReload) return result

  if (reloads.provider) await reloads.provider()
  if (reloads.model) await reloads.model()
  return result
}

export function hasCatalogDomain(ctx: { catalog?: { transform?: unknown; reload?: unknown } }): boolean {
  return typeof ctx.catalog?.transform === "function"
}
