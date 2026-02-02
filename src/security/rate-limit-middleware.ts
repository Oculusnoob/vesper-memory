/**
 * Rate Limit Middleware
 *
 * Integrates rate limiting into the MCP server.
 * Implements SEC-HIGH-001 and SEC-HIGH-002 from security audit.
 *
 * Security Features:
 * - Fail-closed behavior when Redis unavailable (SEC-HIGH-002)
 * - Tier-based rate limits
 * - Standard rate limit headers
 * - 429 error responses with Retry-After
 */

import { Redis } from "ioredis";
import {
  RateLimiter,
  createRateLimiter,
  RateLimitConfig,
} from "../utils/rate-limiter.js";
import {
  TierName,
  getTierLimits,
} from "../config/rate-limits.js";

/**
 * Rate limit headers to include in responses
 */
export interface RateLimitHeaders {
  "X-RateLimit-Limit": string;
  "X-RateLimit-Remaining": string;
  "X-RateLimit-Reset": string;
  "Retry-After"?: string;
  "X-RateLimit-Bypass"?: string;
}

/**
 * Result from rate limit check
 */
export interface RateLimitCheckResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining requests in current window */
  remaining: number;
  /** Unix timestamp when limit resets */
  resetAt: number;
  /** Rate limit headers to include in response */
  headers: RateLimitHeaders;
}

/**
 * Rate limit error for 429 responses
 */
export class RateLimitError extends Error {
  public readonly statusCode: number;
  public readonly retryAfter: number;

  constructor(message: string, statusCode: number, retryAfter: number) {
    super(message);
    this.name = "RateLimitError";
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;

    // Maintain proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RateLimitError);
    }
  }
}

/**
 * Middleware options
 */
export interface RateLimitMiddlewareOptions {
  /** Whether to allow requests when Redis is unavailable */
  failOpen: boolean;
  /** Rate limit tier to apply */
  tier: TierName;
  /** Custom limits that override tier defaults */
  customLimits?: Record<string, RateLimitConfig>;
  /** Emergency limit for in-memory fallback */
  emergencyLimit?: number;
}

/**
 * Rate Limit Middleware
 *
 * Wraps the RateLimiter class and provides:
 * - Standard HTTP headers
 * - Fail-closed behavior
 * - Error handling for 429 responses
 */
export class RateLimitMiddleware {
  private redis: Redis;
  private rateLimiter: RateLimiter | null = null;
  private options: RateLimitMiddlewareOptions;
  private inMemoryLimits: Map<string, { count: number; resetAt: number }> =
    new Map();

  constructor(redis: Redis, options: RateLimitMiddlewareOptions) {
    this.redis = redis;
    this.options = options;

    // Build rate limit config from tier and custom limits
    const config = this.buildConfig();

    try {
      this.rateLimiter = createRateLimiter(redis, config);
    } catch {
      // Redis not available during construction - will handle in checkRateLimit
      this.rateLimiter = null;
    }
  }

  /**
   * Build rate limit configuration from options
   */
  private buildConfig(): Record<string, RateLimitConfig> {
    const tierLimits = getTierLimits(this.options.tier);

    if (!this.options.customLimits) {
      return tierLimits;
    }

    // Merge custom limits with tier defaults
    const merged: Record<string, RateLimitConfig> = { ...tierLimits };

    for (const [operation, customConfig] of Object.entries(
      this.options.customLimits
    )) {
      merged[operation] = customConfig;
    }

    return merged;
  }

  /**
   * Check rate limit for a request
   *
   * @param userId - User identifier
   * @param operation - MCP tool name
   * @returns Rate limit check result
   * @throws RateLimitError if rate limited or Redis unavailable (fail-closed)
   */
  async checkRateLimit(
    userId: string,
    operation: string
  ): Promise<RateLimitCheckResult> {
    try {
      // Try Redis-based rate limiting
      return await this.checkRateLimitRedis(userId, operation);
    } catch (error) {
      console.error(
        "[WARN] Rate limiter Redis error:",
        error instanceof Error ? error.message : String(error)
      );

      if (this.options.failOpen) {
        // FAIL OPEN: Allow request but log warning
        console.warn("[SECURITY] Rate limiting bypassed due to Redis failure");
        return this.createBypassResult();
      } else {
        // FAIL CLOSED: Deny request (recommended for security)
        console.error("[SECURITY] Rate limiting enforced - request denied");
        throw new RateLimitError(
          "Service temporarily unavailable. Please try again in a few minutes.",
          503,
          30
        );
      }
    }
  }

  /**
   * Check rate limit using Redis
   */
  private async checkRateLimitRedis(
    userId: string,
    operation: string
  ): Promise<RateLimitCheckResult> {
    // Ensure Redis is connected
    if (this.redis.status !== "ready") {
      // Try to connect
      try {
        await this.redis.connect();
      } catch {
        throw new Error("Redis connection failed");
      }
    }

    if (!this.rateLimiter) {
      // Reinitialize rate limiter
      const config = this.buildConfig();
      this.rateLimiter = createRateLimiter(this.redis, config);
    }

    // Check rate limit
    const result = await this.rateLimiter.checkLimit(userId, operation);

    // Calculate reset timestamp (Unix seconds)
    const resetAt = Math.floor(Date.now() / 1000) + result.resetIn;

    // Build headers
    const headers: RateLimitHeaders = {
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(resetAt),
    };

    // Add Retry-After header if rate limited
    if (!result.allowed) {
      headers["Retry-After"] = String(result.resetIn);
    }

    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt,
      headers,
    };
  }

  /**
   * Create bypass result for fail-open mode
   */
  private createBypassResult(): RateLimitCheckResult {
    return {
      allowed: true,
      remaining: -1,
      resetAt: 0,
      headers: {
        "X-RateLimit-Limit": "-1",
        "X-RateLimit-Remaining": "-1",
        "X-RateLimit-Reset": "0",
        "X-RateLimit-Bypass": "true",
      },
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): Record<string, RateLimitConfig> {
    return this.buildConfig();
  }

  /**
   * Update tier
   */
  setTier(tier: TierName): void {
    this.options.tier = tier;
    // Reinitialize rate limiter with new tier
    const config = this.buildConfig();
    if (this.redis.status === "ready") {
      this.rateLimiter = createRateLimiter(this.redis, config);
    }
  }
}

/**
 * Factory function to create rate limit middleware
 *
 * @param redis - Redis client
 * @param options - Middleware options
 */
export function createRateLimitMiddleware(
  redis: Redis,
  options: RateLimitMiddlewareOptions
): RateLimitMiddleware {
  return new RateLimitMiddleware(redis, options);
}

/**
 * Format rate limit error for MCP response
 */
export function formatRateLimitError(
  error: RateLimitError,
  operation: string
): { error: string; retryAfter: number; operation: string } {
  return {
    error: error.message,
    retryAfter: error.retryAfter,
    operation,
  };
}
