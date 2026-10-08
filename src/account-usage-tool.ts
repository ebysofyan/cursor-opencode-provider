import { formatAccountUsageText } from "./account-usage-format.js"
import { renewSessionIfDue, resolveBearerToken } from "./auth-renewal.js"
import { CursorAuthError } from "./errors.js"
import { CURSOR_PROVIDER_ID } from "./shared.js"
import { readStoredAuth, type StoredAuth } from "./context/auth-store.js"
import type { AccountUsageCache, BearerSource } from "./account-usage.js"

/**
 * Classic-helper factory shape, mirroring `web-search-tool.ts`: the host's
 * `tool()` helper receives `{ description, args, execute }` and `args` carries
 * Zod helpers per argument. This tool takes no arguments, so `args` is the
 * empty object — exactly as the no-argument convention requires.
 */
export type AccountUsageToolFactory = {
  tool: (definition: Record<string, unknown>) => any
}

/** Build the classic OpenCode `cursor_usage` tool around a shared usage cache. */
export function createOpenCodeAccountUsageTool(
  factory: AccountUsageToolFactory,
  deps: { cache: AccountUsageCache },
): any {
  return factory.tool({
    description: "Show current Cursor account usage for the billing period.",
    args: {},
    execute: async () => formatAccountUsageText(await deps.cache.snapshot()),
  })
}

/** Identity `tool()` helper for hosts without the Zod plugin helper. */
export function identityAccountUsageToolFactory(): AccountUsageToolFactory {
  return { tool: (definition) => definition }
}

export type CursorUsageStoreBearerOptions = {
  /** Test seam; defaults to OpenCode's durable auth store for the Cursor provider. */
  read?: (providerId: string) => Promise<StoredAuth | undefined>
  /** Test seam; defaults to the shared Cursor API base the renewal layer uses. */
  baseUrl?: string
}

/**
 * Bearer source for 1.x surfaces that run outside the plugin's auth loader
 * (the `cursor_usage` tool fallback and the TUI slash command). It reads the
 * durable store — the same file the host's `getAuth()` reads — and reuses the
 * plugin's existing renewal-aware auth machinery, with no second probe or
 * credential parser here: an OAuth session token goes through
 * `renewSessionIfDue` (renews only when due, keeps a still-valid token
 * through a transient failure), a raw `crsr_` key is exchanged through the
 * shared API-key path, and a raw key stored as an access token is rejected by
 * `resolveBearerToken`, never sent as a Bearer.
 *
 * Renewal is deliberately **not** persisted here. The only durable writer is
 * the host's own `client.auth.set`, which the classic plugin has and this
 * surface does not; `src/context/auth-store.ts` exports a reader only. Writing
 * OpenCode's credential file directly would take ownership of host state the
 * provider does not own, so a renewal reached through this path lives in the
 * renewal layer's successor map for the life of the process and the next
 * process renews again. Nothing is ever overwritten unconditionally, which is
 * the property the compare-and-set rule in `plugin.ts` protects.
 */
export function cursorUsageStoreBearer(options: CursorUsageStoreBearerOptions = {}): BearerSource {
  const read = options.read ?? readStoredAuth
  return async () => {
    const stored = await read(CURSOR_PROVIDER_ID)
    if (!stored) {
      throw new CursorAuthError("No Cursor login found; sign in to Cursor", { code: "no_credential" })
    }
    if (stored.type === "oauth") {
      const renewal = await renewSessionIfDue(
        { accessToken: stored.access, refreshToken: stored.refresh },
        options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {},
      )
      // Still routed through the shared resolver: a raw crsr_ key stored as an
      // access token is rejected, never sent as a Bearer.
      return await resolveBearerToken({ accessToken: renewal.accessToken })
    }
    return await resolveBearerToken({ apiKey: stored.key, ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}) })
  }
}
