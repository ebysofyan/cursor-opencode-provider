import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { opencodeConfigFileNames, opencodeGlobalConfigDir, opencodeGlobalConfigDirs } from "../context/paths.js"
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
 * `providers.cursor` inside the host global config (`$OPENCODE_CONFIG_DIR`,
 * then the path-bridge global config dir, then native `~/.config/opencode`)
 * using `jsonc-parser` so comments and unrelated keys are preserved. Beta
 * hosts with `ctx.catalog` never need this path.
 *
 * Safety: parse failure → fail closed (no write). Never rewrite the whole
 * document via `JSON.stringify`. A `providers.cursor` block owned by another
 * package/integration is left untouched.
 */

export type ConfigCatalogSyncSkip = "parse_error" | "unchanged" | "unowned"

export type ConfigCatalogSyncResult = {
  path: string
  modelCount: number
  changed: boolean
  /** Why a write was skipped (when `changed` is false for a non-idempotent reason). */
  skipped?: ConfigCatalogSyncSkip
}

export type StableDomainReloads = {
  provider?: () => Promise<void> | void
  model?: () => Promise<void> | void
}

export type StableDomainReloadOptions = {
  forceReload?: boolean
}

function configDir(): string {
  const fromEnv = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (fromEnv) return fromEnv
  return opencodeGlobalConfigDirs()[0] ?? opencodeGlobalConfigDir()
}

function resolveConfigPath(dir: string): string {
  const names = opencodeConfigFileNames()
  for (const name of names) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return join(dir, names[0] ?? "opencode.jsonc")
}

function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  try {
    writeFileSync(tmp, contents, "utf8")
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // Best-effort cleanup of the temp file.
    }
    throw error
  }
}

function isOurAisdkPackage(pkg: string): boolean {
  if (pkg === CURSOR_AISDK_PACKAGE) return true
  if (pkg === "aisdk:cursor-opencode-provider") return true
  // Local `CURSOR_OPENCODE2_DEV_ENTRY` overrides, including a previous run's file:// spec.
  return pkg.startsWith("aisdk:file://")
}

/**
 * Whether `providers.cursor` is absent or already this plugin's identity.
 * Legacy `provider.cursor` (OpenCode 1.x) is not an owner of the native block.
 */
export function isManagedCursorProvider(current: unknown): boolean {
  if (current === undefined || current === null) return true
  if (typeof current !== "object" || Array.isArray(current)) return false
  const record = current as Record<string, unknown>
  const pkg = record.package
  if (typeof pkg === "string" && pkg.length > 0 && !isOurAisdkPackage(pkg)) return false
  const integrationID = record.integrationID
  if (typeof integrationID === "string" && integrationID.length > 0 && integrationID !== CURSOR_INTEGRATION_ID) {
    return false
  }
  return true
}

/** Parse errors must retry; unowned/unchanged skips are terminal for this process. */
export function stableModelsPublished(result: ConfigCatalogSyncResult): boolean {
  return result.skipped !== "parse_error"
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
    const doc = { providers: { [CURSOR_PROVIDER_ID]: nextProvider } }
    atomicWriteFile(path, `${JSON.stringify(doc, null, 2)}\n`)
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

  const hasPreferredProvider = Object.prototype.hasOwnProperty.call(providers, CURSOR_PROVIDER_ID)
  const currentPreferred = hasPreferredProvider ? providers[CURSOR_PROVIDER_ID] : undefined
  if (!isManagedCursorProvider(currentPreferred)) {
    return { path, modelCount, changed: false, skipped: "unowned" }
  }

  const currentManaged =
    currentPreferred && typeof currentPreferred === "object" && !Array.isArray(currentPreferred)
      ? (currentPreferred as Record<string, unknown>)
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

  atomicWriteFile(path, edited.endsWith("\n") ? edited : `${edited}\n`)
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
