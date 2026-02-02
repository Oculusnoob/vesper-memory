/**
 * Rate Limiting Configuration
 *
 * Defines tier-based rate limits for MCP tools.
 * Configurable via environment variables.
 *
 * Security: Implements SEC-HIGH-001 from security audit
 */

import { RateLimitConfig } from "../utils/rate-limiter.js";

/**
 * Available rate limit tiers
 *
 * Note: "unlimited" is the highest tier (not "enterprise")
 * This matches the tier naming in auth.ts and postgres-auth-schema.sql
 */
export type TierName = "standard" | "premium" | "unlimited";

/**
 * Tier-based rate limits for all MCP operations
 *
 * Limits are per-minute unless otherwise specified.
 *
 * | Tier | store_memory | retrieve_memory | list_recent | get_stats |
 * |------|-------------|-----------------|-------------|-----------|
 * | standard | 100/min | 300/min | 60/min | 30/min |
 * | premium | 500/min | 1000/min | 200/min | 100/min |
 * | unlimited | no limit | no limit | no limit | no limit |
 */
export const TIER_LIMITS: Record<TierName, Record<string, RateLimitConfig>> = {
  standard: {
    store_memory: {
      maxRequests: 100,
      windowSeconds: 60,
    },
    retrieve_memory: {
      maxRequests: 300,
      windowSeconds: 60,
    },
    list_recent: {
      maxRequests: 60,
      windowSeconds: 60,
    },
    get_stats: {
      maxRequests: 30,
      windowSeconds: 60,
    },
  },
  premium: {
    store_memory: {
      maxRequests: 500,
      windowSeconds: 60,
    },
    retrieve_memory: {
      maxRequests: 1000,
      windowSeconds: 60,
    },
    list_recent: {
      maxRequests: 200,
      windowSeconds: 60,
    },
    get_stats: {
      maxRequests: 100,
      windowSeconds: 60,
    },
  },
  unlimited: {
    // Use very high values (effectively no limit) for unlimited tier
    // We avoid actual infinity to prevent edge cases in Redis
    store_memory: {
      maxRequests: 1000000,
      windowSeconds: 60,
    },
    retrieve_memory: {
      maxRequests: 1000000,
      windowSeconds: 60,
    },
    list_recent: {
      maxRequests: 1000000,
      windowSeconds: 60,
    },
    get_stats: {
      maxRequests: 1000000,
      windowSeconds: 60,
    },
  },
};

/**
 * Legacy export for backwards compatibility
 */
export const RATE_LIMIT_TIERS = TIER_LIMITS;

/**
 * Get rate limits for a specific tier
 *
 * @param tier - The tier name
 * @returns Rate limit configuration for all operations
 */
export function getTierLimits(tier: TierName): Record<string, RateLimitConfig> {
  return TIER_LIMITS[tier] || TIER_LIMITS.standard;
}

/**
 * Configuration from environment variables
 */
export interface RateLimitEnvConfig {
  /** Default tier for users without explicit tier assignment */
  defaultTier: TierName;

  /** Whether to allow requests when Redis is unavailable (default: false - fail closed) */
  failOpen: boolean;

  /** Custom limits that override tier defaults */
  customLimits?: Record<string, number>;

  /** Emergency fallback limit when Redis is down (only used with failOpen: false) */
  emergencyLimit: number;
}

/**
 * Read rate limit configuration from environment variables
 *
 * Environment variables:
 * - RATE_LIMIT_DEFAULT_TIER: Default tier (standard|premium|unlimited)
 * - RATE_LIMIT_FAIL_OPEN: Whether to allow requests when Redis is down (true|false)
 * - RATE_LIMIT_STORE_MEMORY: Override store_memory limit
 * - RATE_LIMIT_RETRIEVE_MEMORY: Override retrieve_memory limit
 * - RATE_LIMIT_LIST_RECENT: Override list_recent limit
 * - RATE_LIMIT_GET_STATS: Override get_stats limit
 * - RATE_LIMIT_EMERGENCY: Emergency in-memory limit when Redis is down
 *
 * @returns Rate limit configuration
 */
export function getRateLimitConfigFromEnv(): RateLimitEnvConfig {
  const defaultTier = (process.env.RATE_LIMIT_DEFAULT_TIER || "standard") as TierName;

  // Security: Default to fail closed (deny requests when Redis is unavailable)
  const failOpenEnv = process.env.RATE_LIMIT_FAIL_OPEN;
  const failOpen = failOpenEnv === "true";

  // Parse custom limits from environment
  const customLimits: Record<string, number> = {};

  const storeMemoryLimit = process.env.RATE_LIMIT_STORE_MEMORY;
  if (storeMemoryLimit) {
    customLimits.store_memory = parseInt(storeMemoryLimit, 10);
  }

  const retrieveMemoryLimit = process.env.RATE_LIMIT_RETRIEVE_MEMORY;
  if (retrieveMemoryLimit) {
    customLimits.retrieve_memory = parseInt(retrieveMemoryLimit, 10);
  }

  const listRecentLimit = process.env.RATE_LIMIT_LIST_RECENT;
  if (listRecentLimit) {
    customLimits.list_recent = parseInt(listRecentLimit, 10);
  }

  const getStatsLimit = process.env.RATE_LIMIT_GET_STATS;
  if (getStatsLimit) {
    customLimits.get_stats = parseInt(getStatsLimit, 10);
  }

  // Emergency limit for in-memory fallback (very conservative)
  const emergencyLimit = parseInt(
    process.env.RATE_LIMIT_EMERGENCY || "10",
    10
  );

  return {
    defaultTier,
    failOpen,
    customLimits: Object.keys(customLimits).length > 0 ? customLimits : undefined,
    emergencyLimit,
  };
}

/**
 * Build rate limit configuration by merging tier defaults with custom limits
 *
 * @param tier - Base tier
 * @param customLimits - Custom limit overrides
 * @returns Merged rate limit configuration
 */
export function buildRateLimitConfig(
  tier: TierName,
  customLimits?: Record<string, number>
): Record<string, RateLimitConfig> {
  const tierLimits = getTierLimits(tier);

  if (!customLimits) {
    return tierLimits;
  }

  // Merge custom limits with tier defaults
  const merged: Record<string, RateLimitConfig> = { ...tierLimits };

  for (const [operation, maxRequests] of Object.entries(customLimits)) {
    if (merged[operation]) {
      merged[operation] = {
        ...merged[operation],
        maxRequests,
      };
    }
  }

  return merged;
}
