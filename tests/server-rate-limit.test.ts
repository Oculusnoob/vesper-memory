/**
 * Server Rate Limiting Integration Tests
 *
 * Tests for rate limiting integration in the MCP server.
 * Follows TDD approach - tests written BEFORE implementation.
 *
 * Coverage targets:
 * - Rate limiting for each tool
 * - Tier-based limits (standard, premium, unlimited)
 * - Fail-closed behavior when Redis unavailable
 * - Rate limit headers in responses
 * - 429 error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Redis from "ioredis";
import {
  RateLimiter,
  createRateLimiter,
  RateLimitConfig,
} from "../src/utils/rate-limiter.js";
import {
  RATE_LIMIT_TIERS,
  TierName,
  getTierLimits,
  getRateLimitConfigFromEnv,
  TIER_LIMITS,
} from "../src/config/rate-limits.js";
import {
  RateLimitMiddleware,
  RateLimitError,
  createRateLimitMiddleware,
  RateLimitHeaders,
} from "../src/security/rate-limit-middleware.js";

// Test Redis connection (use database 5 for rate limit integration tests)
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD,
  db: 5,
  lazyConnect: true,
});

describe("Rate Limit Configuration", () => {
  describe("Tier Definitions", () => {
    it("should define standard tier with correct limits", () => {
      const standardLimits = TIER_LIMITS.standard;

      expect(standardLimits.store_memory.maxRequests).toBe(100);
      expect(standardLimits.store_memory.windowSeconds).toBe(60);
      expect(standardLimits.retrieve_memory.maxRequests).toBe(300);
      expect(standardLimits.retrieve_memory.windowSeconds).toBe(60);
      expect(standardLimits.list_recent.maxRequests).toBe(60);
      expect(standardLimits.list_recent.windowSeconds).toBe(60);
      expect(standardLimits.get_stats.maxRequests).toBe(30);
      expect(standardLimits.get_stats.windowSeconds).toBe(60);
    });

    it("should define premium tier with higher limits", () => {
      const premiumLimits = TIER_LIMITS.premium;

      expect(premiumLimits.store_memory.maxRequests).toBe(500);
      expect(premiumLimits.retrieve_memory.maxRequests).toBe(1000);
      expect(premiumLimits.list_recent.maxRequests).toBe(200);
      expect(premiumLimits.get_stats.maxRequests).toBe(100);
    });

    it("should define unlimited tier with very high limits", () => {
      const unlimitedLimits = TIER_LIMITS.unlimited;

      // Unlimited tier uses very high values (effectively no limit)
      expect(unlimitedLimits.store_memory.maxRequests).toBeGreaterThanOrEqual(
        1000000
      );
      expect(
        unlimitedLimits.retrieve_memory.maxRequests
      ).toBeGreaterThanOrEqual(1000000);
    });
  });

  describe("getTierLimits", () => {
    it("should return standard tier limits by default", () => {
      const limits = getTierLimits("standard");

      expect(limits.store_memory.maxRequests).toBe(100);
    });

    it("should return premium tier limits", () => {
      const limits = getTierLimits("premium");

      expect(limits.store_memory.maxRequests).toBe(500);
    });

    it("should return unlimited tier limits", () => {
      const limits = getTierLimits("unlimited");

      expect(limits.store_memory.maxRequests).toBeGreaterThanOrEqual(1000000);
    });

    it("should default to standard for unknown tier", () => {
      const limits = getTierLimits("unknown" as TierName);

      expect(limits.store_memory.maxRequests).toBe(100);
    });
  });

  describe("Environment Variable Configuration", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should read tier from RATE_LIMIT_DEFAULT_TIER env var", () => {
      process.env.RATE_LIMIT_DEFAULT_TIER = "premium";
      const config = getRateLimitConfigFromEnv();

      expect(config.defaultTier).toBe("premium");
    });

    it("should read fail-open setting from RATE_LIMIT_FAIL_OPEN env var", () => {
      process.env.RATE_LIMIT_FAIL_OPEN = "false";
      const config = getRateLimitConfigFromEnv();

      expect(config.failOpen).toBe(false);
    });

    it("should default failOpen to false (fail closed)", () => {
      delete process.env.RATE_LIMIT_FAIL_OPEN;
      const config = getRateLimitConfigFromEnv();

      expect(config.failOpen).toBe(false);
    });

    it("should read custom limits from environment variables", () => {
      process.env.RATE_LIMIT_STORE_MEMORY = "50";
      process.env.RATE_LIMIT_RETRIEVE_MEMORY = "150";
      const config = getRateLimitConfigFromEnv();

      expect(config.customLimits?.store_memory).toBe(50);
      expect(config.customLimits?.retrieve_memory).toBe(150);
    });
  });
});

describe("Rate Limit Middleware", () => {
  let middleware: RateLimitMiddleware;
  let redisConnected = false;

  beforeEach(async () => {
    try {
      await redis.connect();
      redisConnected = true;

      // Clear all rate limit keys
      const keys = await redis.keys("ratelimit:*");
      if (keys.length > 0) {
        await redis.del(...keys);
      }

      middleware = createRateLimitMiddleware(redis, {
        failOpen: false, // Fail closed for security
        tier: "standard",
      });
    } catch {
      redisConnected = false;
    }
  });

  afterEach(async () => {
    if (redisConnected) {
      try {
        await redis.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  });

  describe("Request Processing", () => {
    it("should allow requests within rate limit", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      const result = await middleware.checkRateLimit("user1", "store_memory");

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
      expect(result.headers).toBeDefined();
    });

    it("should block requests exceeding rate limit", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      // Exhaust the rate limit (standard tier: 100 requests/min for store_memory)
      // Use a smaller limit for testing
      const testMiddleware = createRateLimitMiddleware(redis, {
        failOpen: false,
        tier: "standard",
        customLimits: {
          store_memory: { maxRequests: 5, windowSeconds: 60 },
        },
      });

      // Make 5 requests (at the limit)
      for (let i = 0; i < 5; i++) {
        await testMiddleware.checkRateLimit("user-block-test", "store_memory");
      }

      // 6th request should be blocked
      const result = await testMiddleware.checkRateLimit(
        "user-block-test",
        "store_memory"
      );

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("should return rate limit headers", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      const result = await middleware.checkRateLimit("user1", "store_memory");

      expect(result.headers["X-RateLimit-Limit"]).toBeDefined();
      expect(result.headers["X-RateLimit-Remaining"]).toBeDefined();
      expect(result.headers["X-RateLimit-Reset"]).toBeDefined();
    });

    it("should include Retry-After header when rate limited", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      const testMiddleware = createRateLimitMiddleware(redis, {
        failOpen: false,
        tier: "standard",
        customLimits: {
          store_memory: { maxRequests: 1, windowSeconds: 60 },
        },
      });

      // Make 1 request (at the limit)
      await testMiddleware.checkRateLimit("user-retry-test", "store_memory");

      // 2nd request should be blocked with Retry-After
      const result = await testMiddleware.checkRateLimit(
        "user-retry-test",
        "store_memory"
      );

      expect(result.allowed).toBe(false);
      expect(result.headers["Retry-After"]).toBeDefined();
      expect(parseInt(result.headers["Retry-After"])).toBeGreaterThan(0);
    });
  });

  describe("Tier-Based Limits", () => {
    it("should apply standard tier limits", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      const standardMiddleware = createRateLimitMiddleware(redis, {
        failOpen: false,
        tier: "standard",
      });

      const result = await standardMiddleware.checkRateLimit(
        "standard-user",
        "store_memory"
      );

      expect(result.headers["X-RateLimit-Limit"]).toBe("100");
    });

    it("should apply premium tier limits", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      const premiumMiddleware = createRateLimitMiddleware(redis, {
        failOpen: false,
        tier: "premium",
      });

      const result = await premiumMiddleware.checkRateLimit(
        "premium-user",
        "store_memory"
      );

      expect(result.headers["X-RateLimit-Limit"]).toBe("500");
    });

    it("should apply unlimited tier with very high limit", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      const unlimitedMiddleware = createRateLimitMiddleware(redis, {
        failOpen: false,
        tier: "unlimited",
      });

      const result = await unlimitedMiddleware.checkRateLimit(
        "unlimited-user",
        "store_memory"
      );

      expect(parseInt(result.headers["X-RateLimit-Limit"])).toBeGreaterThanOrEqual(
        1000000
      );
    });
  });

  describe("Per-Operation Limits", () => {
    it("should apply different limits for store_memory", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      const result = await middleware.checkRateLimit("user1", "store_memory");
      expect(result.headers["X-RateLimit-Limit"]).toBe("100");
    });

    it("should apply different limits for retrieve_memory", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      const result = await middleware.checkRateLimit("user1", "retrieve_memory");
      expect(result.headers["X-RateLimit-Limit"]).toBe("300");
    });

    it("should apply different limits for list_recent", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      const result = await middleware.checkRateLimit("user1", "list_recent");
      expect(result.headers["X-RateLimit-Limit"]).toBe("60");
    });

    it("should apply different limits for get_stats", async () => {
      if (!redisConnected) {
        console.warn("Skipping test: Redis not available");
        return;
      }

      const result = await middleware.checkRateLimit("user1", "get_stats");
      expect(result.headers["X-RateLimit-Limit"]).toBe("30");
    });
  });
});

describe("Fail-Closed Behavior", () => {
  it("should deny requests when Redis is unavailable (fail closed)", async () => {
    // Create a Redis client that will fail to connect
    const badRedis = new Redis({
      host: "nonexistent-host",
      port: 6379,
      connectTimeout: 100,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });

    const failClosedMiddleware = createRateLimitMiddleware(badRedis, {
      failOpen: false,
      tier: "standard",
    });

    // Should throw RateLimitError when Redis is unavailable
    await expect(
      failClosedMiddleware.checkRateLimit("user1", "store_memory")
    ).rejects.toThrow(RateLimitError);

    try {
      await badRedis.quit();
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should throw RateLimitError with correct properties", async () => {
    const badRedis = new Redis({
      host: "nonexistent-host",
      port: 6379,
      connectTimeout: 100,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });

    const failClosedMiddleware = createRateLimitMiddleware(badRedis, {
      failOpen: false,
      tier: "standard",
    });

    try {
      await failClosedMiddleware.checkRateLimit("user1", "store_memory");
      expect.fail("Should have thrown RateLimitError");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      if (error instanceof RateLimitError) {
        expect(error.statusCode).toBe(503);
        expect(error.message).toContain("temporarily unavailable");
        expect(error.retryAfter).toBeGreaterThan(0);
      }
    }

    try {
      await badRedis.quit();
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should allow requests when fail-open is enabled and Redis unavailable", async () => {
    const badRedis = new Redis({
      host: "nonexistent-host",
      port: 6379,
      connectTimeout: 100,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });

    const failOpenMiddleware = createRateLimitMiddleware(badRedis, {
      failOpen: true,
      tier: "standard",
    });

    const result = await failOpenMiddleware.checkRateLimit(
      "user1",
      "store_memory"
    );

    expect(result.allowed).toBe(true);
    expect(result.headers["X-RateLimit-Limit"]).toBe("-1"); // Indicates bypass
    expect(result.headers["X-RateLimit-Bypass"]).toBe("true");

    try {
      await badRedis.quit();
    } catch {
      // Ignore cleanup errors
    }
  });
});

describe("Rate Limit Error Handling", () => {
  describe("RateLimitError Class", () => {
    it("should create error with correct properties for rate exceeded", () => {
      const error = new RateLimitError("Rate limit exceeded", 429, 60);

      expect(error.statusCode).toBe(429);
      expect(error.retryAfter).toBe(60);
      expect(error.message).toBe("Rate limit exceeded");
      expect(error.name).toBe("RateLimitError");
    });

    it("should create error with correct properties for service unavailable", () => {
      const error = new RateLimitError("Service temporarily unavailable", 503, 30);

      expect(error.statusCode).toBe(503);
      expect(error.retryAfter).toBe(30);
    });

    it("should be instanceof Error", () => {
      const error = new RateLimitError("Test", 429, 60);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RateLimitError);
    });
  });
});

describe("Rate Limit Headers", () => {
  let middleware: RateLimitMiddleware;
  let redisConnected = false;

  beforeEach(async () => {
    try {
      await redis.connect();
      redisConnected = true;

      // Clear all rate limit keys
      const keys = await redis.keys("ratelimit:*");
      if (keys.length > 0) {
        await redis.del(...keys);
      }

      middleware = createRateLimitMiddleware(redis, {
        failOpen: false,
        tier: "standard",
      });
    } catch {
      redisConnected = false;
    }
  });

  afterEach(async () => {
    if (redisConnected) {
      try {
        await redis.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  });

  it("should include X-RateLimit-Limit header", async () => {
    if (!redisConnected) {
      console.warn("Skipping test: Redis not available");
      return;
    }

    const result = await middleware.checkRateLimit(
      "header-test-user",
      "store_memory"
    );

    expect(result.headers["X-RateLimit-Limit"]).toBe("100");
  });

  it("should include X-RateLimit-Remaining header", async () => {
    if (!redisConnected) {
      console.warn("Skipping test: Redis not available");
      return;
    }

    const result = await middleware.checkRateLimit(
      "header-test-user-2",
      "store_memory"
    );

    expect(result.headers["X-RateLimit-Remaining"]).toBeDefined();
    expect(parseInt(result.headers["X-RateLimit-Remaining"])).toBe(99);
  });

  it("should include X-RateLimit-Reset header with Unix timestamp", async () => {
    if (!redisConnected) {
      console.warn("Skipping test: Redis not available");
      return;
    }

    const result = await middleware.checkRateLimit(
      "header-test-user-3",
      "store_memory"
    );

    const resetTime = parseInt(result.headers["X-RateLimit-Reset"]);
    const now = Math.floor(Date.now() / 1000);

    expect(resetTime).toBeGreaterThan(now);
    expect(resetTime).toBeLessThanOrEqual(now + 60); // Within 1 minute
  });

  it("should decrement remaining count with each request", async () => {
    if (!redisConnected) {
      console.warn("Skipping test: Redis not available");
      return;
    }

    const testMiddleware = createRateLimitMiddleware(redis, {
      failOpen: false,
      tier: "standard",
      customLimits: {
        store_memory: { maxRequests: 10, windowSeconds: 60 },
      },
    });

    const result1 = await testMiddleware.checkRateLimit(
      "decrement-test-user",
      "store_memory"
    );
    const result2 = await testMiddleware.checkRateLimit(
      "decrement-test-user",
      "store_memory"
    );
    const result3 = await testMiddleware.checkRateLimit(
      "decrement-test-user",
      "store_memory"
    );

    expect(parseInt(result1.headers["X-RateLimit-Remaining"])).toBe(9);
    expect(parseInt(result2.headers["X-RateLimit-Remaining"])).toBe(8);
    expect(parseInt(result3.headers["X-RateLimit-Remaining"])).toBe(7);
  });
});

describe("Performance Requirements", () => {
  let middleware: RateLimitMiddleware;
  let redisConnected = false;

  beforeEach(async () => {
    try {
      await redis.connect();
      redisConnected = true;

      // Clear all rate limit keys
      const keys = await redis.keys("ratelimit:*");
      if (keys.length > 0) {
        await redis.del(...keys);
      }

      middleware = createRateLimitMiddleware(redis, {
        failOpen: false,
        tier: "standard",
      });
    } catch {
      redisConnected = false;
    }
  });

  afterEach(async () => {
    if (redisConnected) {
      try {
        await redis.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  });

  it("should add less than 5ms overhead", async () => {
    if (!redisConnected) {
      console.warn("Skipping test: Redis not available");
      return;
    }

    const iterations = 100;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await middleware.checkRateLimit(`perf-test-user-${i}`, "store_memory");
      const end = performance.now();
      times.push(end - start);
    }

    // Calculate P95 latency
    times.sort((a, b) => a - b);
    const p95Index = Math.floor(times.length * 0.95);
    const p95 = times[p95Index];

    console.log(`Rate limit P95 latency: ${p95.toFixed(2)}ms`);
    expect(p95).toBeLessThan(5);
  });
});

// Clean up Redis connection after all tests
afterEach(async () => {
  try {
    if (redis.status === "ready") {
      await redis.disconnect();
    }
  } catch {
    // Ignore cleanup errors
  }
});
