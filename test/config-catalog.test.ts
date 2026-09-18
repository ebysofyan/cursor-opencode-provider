import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  hasCatalogDomain,
  syncCursorProvidersConfig,
} from "../src/opencode2/config-catalog.js"
import {
  modelConfigEntryToInfo,
  modelsToCatalogModelMap,
} from "../src/opencode2/catalog.js"
import { modelsToConfig } from "../src/model-config.js"
import { CURSOR_WIRE_MODEL_ID_KEY, type ModelInfo } from "../src/models.js"

const sampleModels: ModelInfo[] = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    supportsAgent: true,
    supportsImages: false,
    variants: [
      {
        key: "default",
        displayName: "Default",
        parameterValues: [],
        isDefaultNonMax: true,
        isDefaultMax: false,
      },
      {
        key: "high",
        displayName: "High",
        parameterValues: [{ id: "effort", value: "high" }],
        isDefaultNonMax: false,
        isDefaultMax: false,
      },
    ],
  },
]

function withConfigDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cursor-oc2-cfg-"))
  const prev = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("hasCatalogDomain", () => {
  test("true when catalog.transform is a function", () => {
    expect(hasCatalogDomain({ catalog: { transform: async () => ({ dispose() {} }) } })).toBe(true)
  })

  test("false when catalog is missing or transform is not a function", () => {
    expect(hasCatalogDomain({})).toBe(false)
    expect(hasCatalogDomain({ catalog: {} })).toBe(false)
    expect(hasCatalogDomain({ catalog: { transform: "nope" as any } })).toBe(false)
  })
})

describe("modelConfigEntryToInfo / catalog parity", () => {
  test("includes variants, cost, limits, modalities, and settings/wire id", () => {
    const config = modelsToConfig(sampleModels)
    const entry = config["composer-2.5"] as Record<string, any>
    expect(entry).toBeTruthy()
    const info = modelConfigEntryToInfo("composer-2.5", entry)
    expect(info.name).toBeTruthy()
    expect(info.modelID).toBeTruthy()
    expect(info.status).toBe("active")
    expect(info.enabled).toBe(true)
    expect(info.time).toEqual({ released: 0 })
    expect(Array.isArray(info.variants)).toBe(true)
    expect(Array.isArray(info.cost)).toBe(true)
    expect(info.limit.context).toBeGreaterThan(0)
    expect(info.limit.output).toBeGreaterThan(0)
    expect(info.capabilities.input.length).toBeGreaterThan(0)
    expect(info.capabilities.output.length).toBeGreaterThan(0)
    if (entry.options) {
      expect(info.settings).toBeTruthy()
      expect(info.settings?.[CURSOR_WIRE_MODEL_ID_KEY] ?? info.modelID).toBeTruthy()
    }
  })

  test("modelsToCatalogModelMap matches per-entry translator for every id", () => {
    const config = modelsToConfig(sampleModels)
    const map = modelsToCatalogModelMap(sampleModels)
    for (const id of Object.keys(config)) {
      expect(map[id]).toEqual(modelConfigEntryToInfo(id, config[id] as Record<string, any>))
    }
  })
})

describe("syncCursorProvidersConfig", () => {
  test("writes providers.cursor for stable OC2 hosts and is idempotent", () => {
    withConfigDir((dir) => {
      writeFileSync(
        join(dir, "opencode.jsonc"),
        JSON.stringify({ model: "openai/gpt-5.6-luna", plugin: ["oh-my-opencode-slim"] }, null, 2),
      )
      const result = syncCursorProvidersConfig(sampleModels)
      expect(result.changed).toBe(true)
      expect(result.modelCount).toBeGreaterThan(0)
      const doc = JSON.parse(readFileSync(join(dir, "opencode.jsonc"), "utf8"))
      expect(doc.model).toBe("openai/gpt-5.6-luna")
      expect(doc.plugin).toEqual(["oh-my-opencode-slim"])
      expect(doc.providers.cursor.package).toContain("aisdk:")
      expect(doc.providers.cursor.integrationID).toBe("cursor")
      const model = doc.providers.cursor.models["composer-2.5"]
      expect(model).toBeTruthy()
      expect(Array.isArray(model.variants)).toBe(true)
      expect(Array.isArray(model.cost)).toBe(true)
      expect(model.time).toEqual({ released: 0 })
      expect(model.status).toBe("active")

      const again = syncCursorProvidersConfig(sampleModels)
      expect(again.changed).toBe(false)
      expect(again.skipped).toBe("unchanged")
    })
  })

  test("parse failure does not write or wipe the file", () => {
    withConfigDir((dir) => {
      const path = join(dir, "opencode.jsonc")
      const broken = "{\n  // broken on purpose\n  model: not-json\n"
      writeFileSync(path, broken)
      const before = readFileSync(path, "utf8")
      const result = syncCursorProvidersConfig(sampleModels)
      expect(result.changed).toBe(false)
      expect(result.skipped).toBe("parse_error")
      expect(readFileSync(path, "utf8")).toBe(before)
    })
  })

  test("preserves JSONC comments and unrelated keys when upserting", () => {
    withConfigDir((dir) => {
      const path = join(dir, "opencode.jsonc")
      writeFileSync(
        path,
        `{
  // keep me
  "model": "openai/gpt-5.6-luna",
  /* block comment */
  "plugin": ["oh-my-opencode-slim"],
  "mcp": {
    "context7": { "enabled": true }
  }
}
`,
      )
      const result = syncCursorProvidersConfig(sampleModels)
      expect(result.changed).toBe(true)
      const after = readFileSync(path, "utf8")
      expect(after).toContain("// keep me")
      expect(after).toContain("/* block comment */")
      expect(after).toContain('"context7"')
      expect(after).toContain('"providers"')
      expect(after).toContain('"cursor"')
    })
  })

  test("creates config when missing under OPENCODE_CONFIG_DIR", () => {
    withConfigDir((dir) => {
      const path = join(dir, "opencode.jsonc")
      expect(existsSync(path)).toBe(false)
      const result = syncCursorProvidersConfig(sampleModels)
      expect(result.changed).toBe(true)
      expect(existsSync(path)).toBe(true)
      const doc = JSON.parse(readFileSync(path, "utf8"))
      expect(doc.providers.cursor.models["composer-2.5"]).toBeTruthy()
    })
  })
})
