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
 * OpenCode 2.0 stable (e.g. 2.0.5 / 2.0.6) ships `ctx.provider` / `ctx.model`
 * but **no** `ctx.catalog`. Plugin transforms on those split domains do not
 * flush into the live model picker (draft mutations stay invisible to `list()`).
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

  const prev = JSON.stringify(providers[CURSOR_PROVIDER_ID] ?? legacyProvider[CURSOR_PROVIDER_ID] ?? null)
  const next = JSON.stringify(nextProvider)
  const needsLegacyDrop =
    Object.prototype.hasOwnProperty.call(legacyProvider, CURSOR_PROVIDER_ID)

  if (prev === next && !needsLegacyDrop) {
    return { path, modelCount, changed: false, skipped: "unchanged" }
  }

  let edited = raw
  // Surgical upsert — preserves comments and unrelated keys.
  edited = applyEdits(
    edited,
    modify(edited, ["providers", CURSOR_PROVIDER_ID], nextProvider, {
      formattingOptions: formatting,
      isArrayInsertion: false,
    }),
  )

  if (needsLegacyDrop) {
    edited = applyEdits(
      edited,
      modify(edited, ["provider", CURSOR_PROVIDER_ID], undefined, {
        formattingOptions: formatting,
      }),
    )
    // Drop empty legacy `provider` object if we emptied it.
    const afterErrors: { error: number; offset: number; length: number }[] = []
    const afterDoc = parse(edited, afterErrors, { allowTrailingComma: true }) as
      | Record<string, unknown>
      | undefined
    if (
      afterErrors.length === 0 &&
      afterDoc &&
      afterDoc.provider &&
      typeof afterDoc.provider === "object" &&
      !Array.isArray(afterDoc.provider) &&
      Object.keys(afterDoc.provider as object).length === 0
    ) {
      edited = applyEdits(
        edited,
        modify(edited, ["provider"], undefined, { formattingOptions: formatting }),
      )
    }
  }

  if (edited === raw) {
    return { path, modelCount, changed: false, skipped: "unchanged" }
  }

  writeFileSync(path, edited.endsWith("\n") ? edited : `${edited}\n`, "utf8")
  return { path, modelCount, changed: true }
}

export function hasCatalogDomain(ctx: { catalog?: { transform?: unknown; reload?: unknown } }): boolean {
  return typeof ctx.catalog?.transform === "function"
}
