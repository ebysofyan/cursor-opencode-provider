import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CURSOR_PROVIDER_ID } from "../shared.js"
import { CURSOR_WIRE_MODEL_ID_KEY, type ModelInfo } from "../models.js"
import { modelsToConfig } from "../model-config.js"
import { CURSOR_AISDK_PACKAGE, CURSOR_INTEGRATION_ID } from "./catalog.js"

/**
 * OpenCode 2.0.5 (stable) ships `ctx.provider` / `ctx.model` but **no**
 * `ctx.catalog`. Plugin transforms on those split domains do not flush into the
 * live model picker (draft mutations stay invisible to `list()`).
 *
 * Fallback: write discovered Cursor models into the user config document under
 * `providers.cursor` (OC2) or `provider.cursor` (legacy key), which 2.0.5 does
 * honor. Beta hosts with `ctx.catalog` never need this path.
 */

export type ConfigCatalogSyncResult = {
  path: string
  modelCount: number
  changed: boolean
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

function stripJsonc(raw: string): string {
  // ponytail: cheap JSONC strip — enough for our generated/hand-edited configs.
  // Upgrade: real JSONC parser if users embed exotic comments inside strings.
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

function modelsToProvidersEntry(models: ModelInfo[]): Record<string, unknown> {
  const config = modelsToConfig(models)
  const out: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(config)) {
    const options = (entry as any).options as Record<string, unknown> | undefined
    const wireId =
      typeof options?.[CURSOR_WIRE_MODEL_ID_KEY] === "string"
        ? (options[CURSOR_WIRE_MODEL_ID_KEY] as string)
        : id
    const input = Array.isArray((entry as any).modalities?.input)
      ? (entry as any).modalities.input.filter((m: unknown): m is string => typeof m === "string")
      : ["text"]
    const output = Array.isArray((entry as any).modalities?.output)
      ? (entry as any).modalities.output.filter((m: unknown): m is string => typeof m === "string")
      : ["text"]
    out[id] = {
      name: (entry as any).name ?? id,
      modelID: wireId,
      capabilities: {
        tools: (entry as any).tool_call !== false,
        input,
        output,
      },
      limit: {
        context: (entry as any).limit?.context ?? 200_000,
        output: (entry as any).limit?.output ?? 8192,
      },
      status: "active",
      enabled: true,
      ...(options ? { settings: { ...options } } : {}),
    }
  }
  return out
}

/**
 * Upsert `providers.cursor` (preferred) with the AI SDK package + model map.
 * Returns whether the on-disk document changed.
 */
export function syncCursorProvidersConfig(models: ModelInfo[]): ConfigCatalogSyncResult {
  const dir = configDir()
  const path = resolveConfigPath(dir)
  let doc: Record<string, any> = {}
  if (existsSync(path)) {
    try {
      doc = JSON.parse(stripJsonc(readFileSync(path, "utf8")))
    } catch {
      doc = {}
    }
  }

  const modelMap = modelsToProvidersEntry(models)
  const nextProvider = {
    name: "Cursor",
    package: CURSOR_AISDK_PACKAGE,
    integrationID: CURSOR_INTEGRATION_ID,
    models: modelMap,
  }

  // Prefer OC2 `providers`; keep legacy `provider` in sync when already present.
  const prevProviders = doc.providers && typeof doc.providers === "object" ? doc.providers : {}
  const prevProvider = doc.provider && typeof doc.provider === "object" ? doc.provider : {}
  const prev = JSON.stringify(prevProviders[CURSOR_PROVIDER_ID] ?? prevProvider[CURSOR_PROVIDER_ID] ?? null)
  const next = JSON.stringify(nextProvider)
  if (prev === next) {
    return { path, modelCount: Object.keys(modelMap).length, changed: false }
  }

  doc.providers = { ...prevProviders, [CURSOR_PROVIDER_ID]: nextProvider }
  if (doc.provider && typeof doc.provider === "object") {
    // Drop legacy npm-shaped block if we now own providers.cursor, to avoid
    // duplicate/conflicting Cursor entries.
    const { [CURSOR_PROVIDER_ID]: _drop, ...rest } = doc.provider as Record<string, unknown>
    doc.provider = rest
    if (Object.keys(doc.provider).length === 0) delete doc.provider
  }

  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8")
  return { path, modelCount: Object.keys(modelMap).length, changed: true }
}

export function hasCatalogDomain(ctx: { catalog?: { transform?: unknown; reload?: unknown } }): boolean {
  return typeof ctx.catalog?.transform === "function"
}
