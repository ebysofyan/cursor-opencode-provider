import {
  createAccountUsageCache,
  type AccountUsageCache,
  type AccountUsageCacheOptions,
} from "../account-usage.js"
import { formatAccountUsageText } from "../account-usage-format.js"
import { hostHasTool, OPENCODE2_DIRECT_TOOL_OPTIONS } from "./todo-tools.js"
import { requireCursorAccessToken } from "./integration.js"
import type { IntegrationDomain, ToolDraft } from "./types.js"

export const CURSOR_ACCOUNT_USAGE_TOOL_NAME = "cursor_usage"

const ACCOUNT_USAGE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const

const ACCOUNT_USAGE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    output: { type: "string" },
    content: { type: "string" },
  },
} as const

/**
 * One account-usage cache per plugin setup, shared by the `cursor_usage` tool
 * and the TUI-facing RPC handler. The bearer always resolves through the host
 * integration domain — this adapter never reads an auth file.
 */
export function createAccountUsageCacheFor(
  integration: IntegrationDomain,
  options: Partial<AccountUsageCacheOptions> = {},
): AccountUsageCache {
  return createAccountUsageCache({
    bearer: () => requireCursorAccessToken(integration),
    ...options,
  })
}

/**
 * Register the read-only `cursor_usage` tool on the direct catalog
 * (`codemode: false`), like the todo/image-save plugin tools. No-op when the
 * host already owns the name. The tool renders the shared cache's snapshot
 * through the same formatter every other surface uses.
 */
export function registerCursorAccountUsageTool(
  draft: ToolDraft,
  deps: { cache: AccountUsageCache },
): void {
  if (hostHasTool(draft, CURSOR_ACCOUNT_USAGE_TOOL_NAME)) return
  draft.add({
    name: CURSOR_ACCOUNT_USAGE_TOOL_NAME,
    description: "Show current Cursor account usage for the billing period.",
    input: ACCOUNT_USAGE_INPUT_SCHEMA,
    output: ACCOUNT_USAGE_OUTPUT_SCHEMA,
    options: OPENCODE2_DIRECT_TOOL_OPTIONS,
    execute: async () => {
      const text = formatAccountUsageText(await deps.cache.snapshot())
      return { output: text, content: text, metadata: {} }
    },
  })
}
