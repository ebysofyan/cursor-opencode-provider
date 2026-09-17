import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { syncCursorProvidersConfig } from "../src/opencode2/config-catalog.js"
import type { ModelInfo } from "../src/models.js"

describe("syncCursorProvidersConfig", () => {
  test("writes providers.cursor for stable OC2 hosts", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-oc2-cfg-"))
    const prev = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = dir
    try {
      writeFileSync(
        join(dir, "opencode.jsonc"),
        JSON.stringify({ model: "openai/gpt-5.6-luna", plugin: ["oh-my-opencode-slim"] }, null, 2),
      )
      const models: ModelInfo[] = [
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          supportsAgent: true,
          supportsImages: false,
          variants: [],
        },
      ]
      const result = syncCursorProvidersConfig(models)
      expect(result.changed).toBe(true)
      expect(result.modelCount).toBeGreaterThan(0)
      const doc = JSON.parse(readFileSync(join(dir, "opencode.jsonc"), "utf8"))
      expect(doc.providers.cursor.package).toContain("aisdk:")
      expect(doc.providers.cursor.models["composer-2.5"]).toBeTruthy()
      expect(doc.providers.cursor.integrationID).toBe("cursor")

      const again = syncCursorProvidersConfig(models)
      expect(again.changed).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
