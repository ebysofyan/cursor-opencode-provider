import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import {
  hasCatalogDomain,
  syncCursorProvidersConfig,
} from "../src/opencode2/config-catalog.js"
import {
  applyCursorModels,
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

async function withConfigDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "cursor-oc2-cfg-"))
  const prev = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = dir
  try {
    return await fn(dir)
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

  test("stable config preserves beta-visible model metadata", () => {
    withConfigDir((dir) => {
      const models: ModelInfo[] = [
        {
          id: "claude-sonnet-4-5",
          displayName: "Sonnet 4.5",
          supportsAgent: true,
          supportsImages: true,
          maxContextForMaxMode: 1_000_000,
          variants: [
            {
              key: "base",
              displayName: "Sonnet 4.5",
              parameterValues: [],
              isDefaultNonMax: true,
              isDefaultMax: false,
            },
            {
              key: "max",
              displayName: "Sonnet 4.5 1M",
              parameterValues: [{ id: "context", value: "1000000" }],
              isDefaultNonMax: false,
              isDefaultMax: true,
            },
          ],
        },
      ]
      const betaModels = new Map<string, any>()
      const draft = {
        model: {
          update: (_providerID: string, id: string, update: (model: any) => void) => {
            const model = betaModels.get(id) ?? {}
            betaModels.set(id, model)
            update(model)
          },
        },
      } as any
      applyCursorModels(draft, models)

      syncCursorProvidersConfig(models)
      const stable = parseJsonc(readFileSync(join(dir, "opencode.jsonc"), "utf8")) as any
      const stableModel = stable.providers.cursor.models["claude-sonnet-4-5-1m"]
      const betaModel = betaModels.get("claude-sonnet-4-5-1m")

      expect(stableModel.modelID).toBe(betaModel.modelID)
      expect(stableModel.capabilities).toEqual(betaModel.capabilities)
      expect(stableModel.limit).toEqual(betaModel.limit)
      expect(stableModel.variants).toEqual(betaModel.variants)
      expect(stableModel.cost).toEqual(betaModel.cost)
      expect(stableModel.settings).toEqual(betaModel.settings)
    })
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

  test("preserves existing Cursor provider fields and nested comments", () => {
    withConfigDir((dir) => {
      const path = join(dir, "opencode.jsonc")
      writeFileSync(
        path,
        `{
  "providers": {
    // preserve provider comment
    "cursor": {
      /* preserve custom provider fields */
      "customHeaders": { "X-Workspace": "keep-me" },
      "options": { "userSetting": true }
    }
  }
}
`,
      )

      const result = syncCursorProvidersConfig(sampleModels)
      expect(result.changed).toBe(true)
      const after = readFileSync(path, "utf8")
      expect(after).toContain("preserve provider comment")
      expect(after).toContain("preserve custom provider fields")
      const doc = parseJsonc(after) as Record<string, any>
      expect(doc.providers.cursor.customHeaders).toEqual({ "X-Workspace": "keep-me" })
      expect(doc.providers.cursor.options).toEqual({ userSetting: true })
      expect(doc.providers.cursor.models["composer-2.5"]).toBeTruthy()
      expect(doc.providers.cursor.integrationID).toBe("cursor")
    })
  })

  test("preserves legacy provider Cursor data while adding the stable provider", () => {
    withConfigDir((dir) => {
      const path = join(dir, "opencode.jsonc")
      writeFileSync(
        path,
        `{
  "provider": {
    // keep classic OpenCode data
    "cursor": {
      /* keep custom legacy options */
      "customHeaders": { "X-Workspace": "keep-me" },
      "options": { "classic": true }
    }
  }
}
`,
      )

      syncCursorProvidersConfig(sampleModels)
      const after = readFileSync(path, "utf8")
      expect(after).toContain("keep classic OpenCode data")
      expect(after).toContain("keep custom legacy options")
      const doc = parseJsonc(after) as Record<string, any>
      expect(doc.provider.cursor.customHeaders).toEqual({ "X-Workspace": "keep-me" })
      expect(doc.provider.cursor.options).toEqual({ classic: true })
      expect(doc.providers.cursor.models["composer-2.5"]).toBeTruthy()
    })
  })

  test("reloads stable provider and model domains after a changed sync", async () => {
    await withConfigDirAsync(async () => {
      const reloaded: string[] = []
      const { syncCursorProvidersConfigAndReload } = await import("../src/opencode2/config-catalog.js")
      expect(typeof syncCursorProvidersConfigAndReload).toBe("function")
      const result = await syncCursorProvidersConfigAndReload(sampleModels, {
        provider: async () => reloaded.push("provider"),
        model: async () => reloaded.push("model"),
      })

      expect(result.changed).toBe(true)
      expect(reloaded).toEqual(["provider", "model"])
    })
  })

  test("reloads the provider completely before reloading models", async () => {
    await withConfigDirAsync(async () => {
      const { syncCursorProvidersConfigAndReload } = await import("../src/opencode2/config-catalog.js")
      const events: string[] = []
      let releaseProvider!: () => void
      const providerReady = new Promise<void>((resolve) => {
        releaseProvider = resolve
      })
      const pending = syncCursorProvidersConfigAndReload(sampleModels, {
        provider: async () => {
          events.push("provider-start")
          await providerReady
          events.push("provider-done")
        },
        model: async () => {
          events.push("model")
        },
      })

      await Promise.resolve()
      expect(events).toEqual(["provider-start"])
      releaseProvider()
      await pending
      expect(events).toEqual(["provider-start", "provider-done", "model"])
    })
  })

  test("does not reload stable domains after an unchanged sync", async () => {
    await withConfigDirAsync(async (dir) => {
      writeFileSync(join(dir, "opencode.jsonc"), "{}\n")
      syncCursorProvidersConfig(sampleModels)
      const reloaded: string[] = []
      const { syncCursorProvidersConfigAndReload } = await import("../src/opencode2/config-catalog.js")
      expect(typeof syncCursorProvidersConfigAndReload).toBe("function")
      const result = await syncCursorProvidersConfigAndReload(sampleModels, {
        provider: async () => reloaded.push("provider"),
        model: async () => reloaded.push("model"),
      })

      expect(result.changed).toBe(false)
      expect(result.skipped).toBe("unchanged")
      expect(reloaded).toEqual([])
    })
  })

  test("can retry reload after a changed sync was written", async () => {
    await withConfigDirAsync(async () => {
      const { syncCursorProvidersConfigAndReload } = await import("../src/opencode2/config-catalog.js")
      let attempts = 0
      await expect(
        syncCursorProvidersConfigAndReload(sampleModels, {
          provider: async () => {
            attempts++
            throw new Error("reload failed")
          },
        }),
      ).rejects.toThrow("reload failed")

      const result = await syncCursorProvidersConfigAndReload(
        sampleModels,
        { provider: async () => attempts++ },
        { forceReload: true },
      )
      expect(result.changed).toBe(false)
      expect(result.skipped).toBe("unchanged")
      expect(attempts).toBe(2)
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
