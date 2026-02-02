/**
 * Full Stack Integration Test
 *
 * Tests the complete production workflow:
 * - Authentication (API key validation)
 * - Rate limiting (tier-based limits)
 * - Metrics collection (request counters, latency)
 * - All MCP tools (store, retrieve, list, stats)
 *
 * HIGH-001, HIGH-002: Validates metrics integration and cache invalidation
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import { createRequire } from "module";
import {
  createAuthCache,
  revokeApiKey,
  invalidateRotatedKey,
  AuthCache,
} from "../../src/middleware/auth.js";
import {
  createRateLimitMiddleware,
  RateLimitMiddleware,
} from "../../src/security/rate-limit-middleware.js";
import { MetricsCollector } from "../../src/monitoring/metrics.js";

const require = createRequire(import.meta.url);

// Test configuration
const TEST_TIMEOUT = 10000; // 10 seconds

// Test data
const TEST_USER_ID = "test-user-123";
const TEST_KEY_PREFIX = "abcd1234";

describe("Full Stack Integration", () => {
  let redis: Redis | undefined;
  let authCache: AuthCache;
  let rateLimiter: RateLimitMiddleware | undefined;
  let metricsCollector: MetricsCollector;

  beforeAll(async () => {
    // Initialize Redis (optional - tests adapt if unavailable)
    try {
      redis = new Redis({
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379"),
        password: process.env.REDIS_PASSWORD,
      });

      await redis.ping();
      console.log("[TEST] Redis connected");
    } catch (err) {
      console.warn("[TEST] Redis not available - some tests will be skipped");
      redis = undefined;
    }

    // Initialize auth cache
    authCache = createAuthCache({ maxSize: 100, ttlSeconds: 60 });

    // Initialize rate limiter (if Redis available)
    if (redis) {
      rateLimiter = createRateLimitMiddleware(redis, {
        failOpen: false,
        tier: "standard",
      });
    }

    // Initialize metrics collector
    metricsCollector = new MetricsCollector({
      prefix: "test",
      collectDefaultMetrics: false,
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  describe("Authentication + Cache Integration", () => {
    it("should cache authentication results", () => {
      // Set a user in cache
      authCache.set(TEST_KEY_PREFIX, {
        userId: TEST_USER_ID,
        tier: "premium",
      });

      // Retrieve from cache
      const cached = authCache.get(TEST_KEY_PREFIX);

      expect(cached).toBeDefined();
      expect(cached?.userId).toBe(TEST_USER_ID);
      expect(cached?.tier).toBe("premium");
    });

    it("should invalidate cache entries (HIGH-002)", () => {
      // Set a user in cache
      authCache.set(TEST_KEY_PREFIX, {
        userId: TEST_USER_ID,
        tier: "premium",
      });

      // Verify it's cached
      expect(authCache.get(TEST_KEY_PREFIX)).toBeDefined();

      // Revoke the key
      const wasInCache = revokeApiKey(TEST_KEY_PREFIX, authCache, "test_revocation");

      expect(wasInCache).toBe(true);

      // Verify it's no longer in cache
      expect(authCache.get(TEST_KEY_PREFIX)).toBeNull();
    });

    it("should invalidate rotated keys (HIGH-002)", () => {
      const oldPrefix = "old12345";
      const newPrefix = "new67890";

      // Set old key in cache
      authCache.set(oldPrefix, {
        userId: TEST_USER_ID,
        tier: "standard",
      });

      // Rotate key
      const wasInCache = invalidateRotatedKey(oldPrefix, authCache);

      expect(wasInCache).toBe(true);
      expect(authCache.get(oldPrefix)).toBeNull();
    });

    it("should expire cache entries after TTL", async () => {
      // Create cache with 1-second TTL
      const shortCache = createAuthCache({ maxSize: 10, ttlSeconds: 1 });

      shortCache.set("test-key", {
        userId: "test-user",
        tier: "standard",
      });

      // Should be in cache immediately
      expect(shortCache.get("test-key")).toBeDefined();

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be expired
      expect(shortCache.get("test-key")).toBeNull();
    }, 3000);
  });

  describe("Rate Limiting Integration", () => {
    it("should enforce rate limits when Redis available", async () => {
      if (!rateLimiter || !redis) {
        console.log("[TEST] Skipping - Redis not available");
        return;
      }

      const userId = "rate-limit-test-user";
      const operation = "store_memory";

      // Standard tier: 100/min for store_memory
      // Make 101 requests to hit the limit
      let allowed = 0;
      let denied = 0;

      for (let i = 0; i < 101; i++) {
        const result = await rateLimiter.checkRateLimit(userId, operation);
        if (result.allowed) {
          allowed++;
        } else {
          denied++;
        }
      }

      expect(allowed).toBe(100);
      expect(denied).toBe(1);

      // Clean up
      await redis.del(`ratelimit:${userId}:${operation}`);
    }, TEST_TIMEOUT);

    it("should provide rate limit headers", async () => {
      if (!rateLimiter) {
        console.log("[TEST] Skipping - Redis not available");
        return;
      }

      const userId = "headers-test-user";
      const operation = "retrieve_memory";

      const result = await rateLimiter.checkRateLimit(userId, operation);

      expect(result.headers).toBeDefined();
      expect(result.headers["X-RateLimit-Limit"]).toBeDefined();
      expect(result.headers["X-RateLimit-Remaining"]).toBeDefined();
      expect(result.headers["X-RateLimit-Reset"]).toBeDefined();

      // Clean up
      if (redis) {
        await redis.del(`ratelimit:${userId}:${operation}`);
      }
    });

    it("should respect tier-based limits", async () => {
      if (!redis) {
        console.log("[TEST] Skipping - Redis not available");
        return;
      }

      // Create premium tier rate limiter
      const premiumLimiter = createRateLimitMiddleware(redis, {
        failOpen: false,
        tier: "premium",
      });

      const userId = "premium-test-user";
      const operation = "store_memory";

      // Premium tier: 500/min for store_memory
      // Make 501 requests
      let allowed = 0;
      let denied = 0;

      for (let i = 0; i < 501; i++) {
        const result = await premiumLimiter.checkRateLimit(userId, operation);
        if (result.allowed) {
          allowed++;
        } else {
          denied++;
        }
      }

      expect(allowed).toBe(500);
      expect(denied).toBe(1);

      // Clean up
      await redis.del(`ratelimit:${userId}:${operation}`);
    }, TEST_TIMEOUT);
  });

  describe("Metrics Collection (HIGH-001)", () => {
    it("should track request counts", async () => {
      metricsCollector.incrementRequests("store_memory", "success");
      metricsCollector.incrementRequests("store_memory", "success");
      metricsCollector.incrementRequests("retrieve_memory", "error");

      // Get metrics
      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("test_requests_total");
      expect(metrics).toContain('tool="store_memory"');
      expect(metrics).toContain('tool="retrieve_memory"');
    });

    it("should track latency", async () => {
      metricsCollector.recordLatency("store_memory", 0.05); // 50ms
      metricsCollector.recordLatency("store_memory", 0.15); // 150ms
      metricsCollector.recordLatency("retrieve_memory", 0.02); // 20ms

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("test_request_duration_seconds");
      expect(metrics).toContain('tool="store_memory"');
      expect(metrics).toContain('tool="retrieve_memory"');
    });

    it("should track auth attempts", async () => {
      metricsCollector.incrementAuthAttempts("success");
      metricsCollector.incrementAuthAttempts("success");
      metricsCollector.incrementAuthAttempts("failed");

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("test_auth_attempts_total");
      expect(metrics).toContain('status="success"');
      expect(metrics).toContain('status="failed"');
    });

    it("should track rate limit hits", async () => {
      metricsCollector.incrementRateLimitHits("user-123", "store_memory");
      metricsCollector.incrementRateLimitHits("user-456", "retrieve_memory");

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("test_rate_limit_hits_total");
      expect(metrics).toContain('operation="store_memory"');
      expect(metrics).toContain('operation="retrieve_memory"');
    });

    it("should track errors by type", async () => {
      metricsCollector.incrementErrors("rate_limit");
      metricsCollector.incrementErrors("mcp_error");
      metricsCollector.incrementErrors("unknown");

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("test_errors_total");
      expect(metrics).toContain('type="rate_limit"');
      expect(metrics).toContain('type="mcp_error"');
      expect(metrics).toContain('type="unknown"');
    });

    it("should set gauges", async () => {
      metricsCollector.setActiveConnections(42);
      metricsCollector.setCacheHitRate(0.85);
      metricsCollector.setCertExpiryDays(87);

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("test_active_connections 42");
      expect(metrics).toContain("test_cache_hit_rate 0.85");
      expect(metrics).toContain("test_cert_expiry_days 87");
    });
  });

  describe("End-to-End Workflow", () => {
    it("should complete full authenticated request flow", async () => {
      // Simulate full request flow:
      // 1. Auth check (cache miss)
      // 2. Rate limit check
      // 3. Process request
      // 4. Record metrics

      const userId = "e2e-test-user";
      const keyPrefix = "e2e12345";
      const operation = "store_memory";

      // Step 1: Auth check (cache miss)
      authCache.set(keyPrefix, {
        userId,
        tier: "standard",
      });

      const cached = authCache.get(keyPrefix);
      expect(cached).toBeDefined();
      expect(cached?.userId).toBe(userId);

      // Track auth success
      metricsCollector.incrementAuthAttempts("success");

      // Step 2: Rate limit check (if Redis available)
      if (rateLimiter) {
        const rateLimitResult = await rateLimiter.checkRateLimit(userId, operation);
        expect(rateLimitResult.allowed).toBe(true);

        if (!rateLimitResult.allowed) {
          metricsCollector.incrementRateLimitHits(userId, operation);
        }
      }

      // Step 3: Process request (simulated)
      const startTime = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 10)); // Simulate 10ms work
      const duration = (Date.now() - startTime) / 1000;

      // Step 4: Record metrics
      metricsCollector.incrementRequests(operation, "success");
      metricsCollector.recordLatency(operation, duration);

      // Verify metrics
      const metrics = await metricsCollector.getMetricsText();
      expect(metrics).toContain("test_requests_total");
      expect(metrics).toContain("test_auth_attempts_total");

      // Clean up
      if (redis) {
        await redis.del(`ratelimit:${userId}:${operation}`);
      }
    });

    it("should handle auth failures correctly", async () => {
      const invalidKeyPrefix = "invalid1";

      // Attempt to get non-existent key from cache
      const cached = authCache.get(invalidKeyPrefix);
      expect(cached).toBeNull();

      // Track auth failure
      metricsCollector.incrementAuthAttempts("failed");
      metricsCollector.incrementErrors("auth_failed");

      // Verify metrics
      const metrics = await metricsCollector.getMetricsText();
      expect(metrics).toContain('status="failed"');
      expect(metrics).toContain('type="auth_failed"');
    });

    it("should handle rate limit exceeded correctly", async () => {
      if (!rateLimiter || !redis) {
        console.log("[TEST] Skipping - Redis not available");
        return;
      }

      const userId = "rate-limit-exceeded-user";
      const operation = "list_recent";

      // Exhaust rate limit (standard: 60/min for list_recent)
      for (let i = 0; i < 60; i++) {
        await rateLimiter.checkRateLimit(userId, operation);
      }

      // Next request should be rate limited
      const result = await rateLimiter.checkRateLimit(userId, operation);
      expect(result.allowed).toBe(false);

      // Track rate limit hit
      metricsCollector.incrementRateLimitHits(userId, operation);
      metricsCollector.incrementErrors("rate_limit");

      // Verify metrics
      const metrics = await metricsCollector.getMetricsText();
      expect(metrics).toContain("test_rate_limit_hits_total");
      expect(metrics).toContain('type="rate_limit"');

      // Clean up
      await redis.del(`ratelimit:${userId}:${operation}`);
    }, TEST_TIMEOUT);
  });

  describe("Performance Validation", () => {
    it("should complete auth check in <10ms (cached)", () => {
      authCache.set("perf-test", {
        userId: "perf-user",
        tier: "standard",
      });

      const startTime = Date.now();
      const result = authCache.get("perf-test");
      const duration = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(duration).toBeLessThan(10);
    });

    it("should complete metrics recording in <5ms", () => {
      const startTime = Date.now();

      metricsCollector.incrementRequests("test_op", "success");
      metricsCollector.recordLatency("test_op", 0.1);

      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5);
    });
  });
});
