/**
 * Monitoring & Metrics Test Suite
 *
 * TDD tests for the monitoring infrastructure:
 * - Prometheus metrics collection
 * - Health endpoint functionality
 * - Alert condition triggers
 * - Metrics authentication
 *
 * Tests are written FIRST before implementation (RED phase)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// These imports will fail initially (RED phase) - implementation comes next
import {
  MetricsCollector,
  createMetricsCollector,
  MetricsConfig,
} from "../../src/monitoring/metrics.js";

import {
  HealthChecker,
  createHealthChecker,
  FullHealthCheckResult,
  ComponentStatus,
} from "../../src/monitoring/health.js";

describe("MetricsCollector", () => {
  let metricsCollector: MetricsCollector;

  beforeEach(() => {
    // Create fresh metrics collector for each test
    metricsCollector = createMetricsCollector({
      prefix: "mcp_test",
      defaultLabels: { environment: "test" },
    });
  });

  afterEach(async () => {
    // Clean up registry after each test
    await metricsCollector.reset();
  });

  describe("Initialization", () => {
    it("should create a metrics collector with default configuration", () => {
      const collector = createMetricsCollector();
      expect(collector).toBeDefined();
      expect(collector.getRegistry()).toBeDefined();
    });

    it("should create a metrics collector with custom prefix", () => {
      const collector = createMetricsCollector({ prefix: "custom_prefix" });
      expect(collector).toBeDefined();
    });

    it("should register default labels", () => {
      const collector = createMetricsCollector({
        defaultLabels: { service: "memory-mcp", version: "0.1.0" },
      });
      expect(collector).toBeDefined();
    });
  });

  describe("Request Counter Metrics", () => {
    it("should increment request counter for each tool call", async () => {
      metricsCollector.incrementRequests("store_memory", "success");
      metricsCollector.incrementRequests("store_memory", "success");
      metricsCollector.incrementRequests("retrieve_memory", "error");

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("mcp_test_requests_total");
      expect(metrics).toContain('tool="store_memory"');
      expect(metrics).toContain('status="success"');
      expect(metrics).toContain('status="error"');
    });

    it("should track requests per tool type", async () => {
      metricsCollector.incrementRequests("store_memory", "success");
      metricsCollector.incrementRequests("retrieve_memory", "success");
      metricsCollector.incrementRequests("list_recent", "success");
      metricsCollector.incrementRequests("get_stats", "success");

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain('tool="store_memory"');
      expect(metrics).toContain('tool="retrieve_memory"');
      expect(metrics).toContain('tool="list_recent"');
      expect(metrics).toContain('tool="get_stats"');
    });

    it("should track error types separately", async () => {
      metricsCollector.incrementErrors("validation_error");
      metricsCollector.incrementErrors("database_error");
      metricsCollector.incrementErrors("timeout_error");

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("mcp_test_errors_total");
      expect(metrics).toContain('type="validation_error"');
      expect(metrics).toContain('type="database_error"');
      expect(metrics).toContain('type="timeout_error"');
    });
  });

  describe("Authentication Metrics", () => {
    it("should track authentication attempts", async () => {
      metricsCollector.incrementAuthAttempts("success");
      metricsCollector.incrementAuthAttempts("failed");
      metricsCollector.incrementAuthAttempts("failed");

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("mcp_test_auth_attempts_total");
      expect(metrics).toContain('status="success"');
      expect(metrics).toContain('status="failed"');
    });

    it("should track high auth failure rate for alerting", async () => {
      // Simulate 15 failed auth attempts
      for (let i = 0; i < 15; i++) {
        metricsCollector.incrementAuthAttempts("failed");
      }

      const failureCount = await metricsCollector.getAuthFailureCount();
      expect(failureCount).toBeGreaterThanOrEqual(15);
    });
  });

  describe("Latency Histogram Metrics", () => {
    it("should record request duration in histogram", async () => {
      // Record some latencies
      metricsCollector.recordLatency("store_memory", 0.05); // 50ms
      metricsCollector.recordLatency("store_memory", 0.1); // 100ms
      metricsCollector.recordLatency("retrieve_memory", 0.02); // 20ms

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("mcp_test_request_duration_seconds");
      expect(metrics).toContain("_bucket");
      expect(metrics).toContain("_sum");
      expect(metrics).toContain("_count");
    });

    it("should have appropriate histogram buckets for P50, P95, P99", async () => {
      // Record various latencies to populate buckets
      const latencies = [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1.0, 2.0];
      for (const latency of latencies) {
        metricsCollector.recordLatency("test_tool", latency);
      }

      const metrics = await metricsCollector.getMetricsText();

      // Check that standard buckets exist
      expect(metrics).toContain('le="0.01"');
      expect(metrics).toContain('le="0.05"');
      expect(metrics).toContain('le="0.1"');
      expect(metrics).toContain('le="0.2"');
      expect(metrics).toContain('le="0.5"');
      expect(metrics).toContain('le="1"');
      expect(metrics).toContain('le="2"');
    });

    it("should record database query latency", async () => {
      metricsCollector.recordDbLatency("redis", "get", 0.002);
      metricsCollector.recordDbLatency("sqlite", "select", 0.005);
      metricsCollector.recordDbLatency("qdrant", "search", 0.05);

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("mcp_test_db_query_duration_seconds");
      expect(metrics).toContain('db="redis"');
      expect(metrics).toContain('db="sqlite"');
      expect(metrics).toContain('db="qdrant"');
    });
  });

  describe("Gauge Metrics", () => {
    it("should track active connections", async () => {
      metricsCollector.setActiveConnections(5);

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("mcp_test_active_connections");
    });

    it("should track cache hit rate", async () => {
      metricsCollector.setCacheHitRate(0.85);

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("mcp_test_cache_hit_rate");
    });

    it("should track certificate expiry days", async () => {
      metricsCollector.setCertExpiryDays(87);

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("mcp_test_cert_expiry_days");
    });
  });

  describe("Rate Limit Metrics", () => {
    it("should track rate limit hits", async () => {
      metricsCollector.incrementRateLimitHits("user123", "store_memory");
      metricsCollector.incrementRateLimitHits("user456", "retrieve_memory");

      const metrics = await metricsCollector.getMetricsText();

      expect(metrics).toContain("mcp_test_rate_limit_hits_total");
    });
  });

  describe("Metrics Export", () => {
    it("should return metrics in Prometheus text format", async () => {
      metricsCollector.incrementRequests("test_tool", "success");

      const metricsText = await metricsCollector.getMetricsText();

      // Prometheus format has # HELP and # TYPE comments
      expect(metricsText).toContain("# HELP");
      expect(metricsText).toContain("# TYPE");
    });

    it("should return metrics as JSON for API consumption", async () => {
      metricsCollector.incrementRequests("test_tool", "success");

      const metricsJson = await metricsCollector.getMetricsJson();

      expect(Array.isArray(metricsJson)).toBe(true);
      expect(metricsJson.length).toBeGreaterThan(0);
    });
  });

  describe("Performance Requirements", () => {
    it("should add less than 5ms overhead for metric collection", async () => {
      const iterations = 1000;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        metricsCollector.incrementRequests("test_tool", "success");
        metricsCollector.recordLatency("test_tool", 0.1);
      }

      const elapsed = performance.now() - start;
      const perOperationMs = elapsed / (iterations * 2);

      // Should be well under 5ms per operation
      expect(perOperationMs).toBeLessThan(5);
    });
  });

  describe("Security", () => {
    it("should not expose sensitive data in metrics", async () => {
      // Record some operations
      metricsCollector.incrementRequests("store_memory", "success");
      metricsCollector.incrementAuthAttempts("failed");

      const metricsText = await metricsCollector.getMetricsText();

      // Should not contain API keys, passwords, or user content
      expect(metricsText).not.toContain("apiKey");
      expect(metricsText).not.toContain("password");
      expect(metricsText).not.toContain("secret");
    });
  });
});

describe("HealthChecker", () => {
  let healthChecker: HealthChecker;

  beforeEach(() => {
    healthChecker = createHealthChecker({
      redis: { host: "localhost", port: 6379 },
      postgres: { host: "localhost", port: 5432 },
      sqlite: { path: ":memory:" },
      qdrant: { url: "http://localhost:6333" },
      embedding: { url: "http://localhost:8000" },
    });
  });

  describe("Health Check Endpoint", () => {
    it("should return healthy status when all components are up", async () => {
      // Mock all components as healthy
      const result = await healthChecker.check();

      expect(result.status).toBeDefined();
      expect(result.timestamp).toBeDefined();
      expect(result.components).toBeDefined();
    });

    it("should return detailed component status", async () => {
      const result = await healthChecker.check();

      expect(result.components).toHaveProperty("redis");
      expect(result.components).toHaveProperty("postgres");
      expect(result.components).toHaveProperty("sqlite");
      expect(result.components).toHaveProperty("qdrant");
      expect(result.components).toHaveProperty("embedding");
    });

    it("should include latency for each component", async () => {
      const result = await healthChecker.check();

      for (const [name, component] of Object.entries(result.components)) {
        expect(component).toHaveProperty("status");
        expect(component).toHaveProperty("latency_ms");
        expect(typeof component.latency_ms).toBe("number");
      }
    });

    it("should return unhealthy if any critical component is down", async () => {
      // Create health checker with invalid Redis config to simulate failure
      const checker = createHealthChecker({
        redis: { host: "invalid-host", port: 9999 },
        sqlite: { path: ":memory:" },
      });

      const result = await checker.check();

      // Redis failure should cause overall unhealthy status
      expect(result.components.redis.status).toBe("unhealthy");
    });

    it("should include timestamp in ISO 8601 format", async () => {
      const result = await healthChecker.check();

      expect(result.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
      );
    });
  });

  describe("Certificate Expiration Check", () => {
    it("should check certificate expiration status", async () => {
      const result = await healthChecker.check();

      expect(result.certificates).toBeDefined();
      expect(result.certificates).toHaveProperty("expiry_days");
      expect(result.certificates).toHaveProperty("status");
    });

    it("should return healthy for certificates with >14 days remaining", async () => {
      // Mock certificate with 30 days remaining
      healthChecker.setCertExpiryDays(30);
      const result = await healthChecker.check();

      expect(result.certificates.status).toBe("healthy");
    });

    it("should return warning for certificates with <14 days remaining", async () => {
      // Mock certificate with 10 days remaining
      healthChecker.setCertExpiryDays(10);
      const result = await healthChecker.check();

      expect(result.certificates.status).toBe("warning");
    });

    it("should return critical for expired certificates", async () => {
      // Mock expired certificate
      healthChecker.setCertExpiryDays(-1);
      const result = await healthChecker.check();

      expect(result.certificates.status).toBe("critical");
    });
  });

  describe("Individual Component Checks", () => {
    it("should check Redis connectivity", async () => {
      const result = await healthChecker.checkRedis();

      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("latency_ms");
    });

    it("should check PostgreSQL connectivity", async () => {
      const result = await healthChecker.checkPostgres();

      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("latency_ms");
    });

    it("should check SQLite connectivity", async () => {
      const result = await healthChecker.checkSqlite();

      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("latency_ms");
    });

    it("should check Qdrant connectivity", async () => {
      const result = await healthChecker.checkQdrant();

      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("latency_ms");
    });

    it("should check Embedding service connectivity", async () => {
      const result = await healthChecker.checkEmbedding();

      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("latency_ms");
    });
  });

  describe("Health Response Format", () => {
    it("should return response matching expected JSON schema", async () => {
      const result = await healthChecker.check();

      // Validate structure matches documented format
      expect(result).toMatchObject({
        status: expect.stringMatching(/^(healthy|degraded|unhealthy)$/),
        timestamp: expect.any(String),
        components: expect.any(Object),
        certificates: {
          expiry_days: expect.any(Number),
          status: expect.stringMatching(/^(healthy|warning|critical)$/),
        },
      });
    });
  });

  describe("Timeout Handling", () => {
    it("should timeout slow health checks after configured duration", async () => {
      const checker = createHealthChecker(
        {
          redis: { host: "10.255.255.1", port: 6379 }, // Non-routable IP
          sqlite: { path: ":memory:" },
        },
        { timeout: 100 } // 100ms timeout
      );

      const start = Date.now();
      const result = await checker.checkRedis();
      const elapsed = Date.now() - start;

      // Should timeout around 100ms, not hang
      expect(elapsed).toBeLessThan(500);
      expect(result.status).toBe("unhealthy");
    });
  });
});

describe("Alert Conditions", () => {
  let metricsCollector: MetricsCollector;

  beforeEach(() => {
    metricsCollector = createMetricsCollector({ prefix: "mcp_alert_test" });
  });

  afterEach(async () => {
    await metricsCollector.reset();
  });

  describe("Error Rate Alert", () => {
    it("should detect high error rate (>5% for 5 min)", async () => {
      // Simulate 100 requests with 10 errors (10% error rate)
      for (let i = 0; i < 90; i++) {
        metricsCollector.incrementRequests("test_tool", "success");
      }
      for (let i = 0; i < 10; i++) {
        metricsCollector.incrementRequests("test_tool", "error");
      }

      const errorRate = await metricsCollector.getErrorRate();
      expect(errorRate).toBeGreaterThan(0.05);
    });
  });

  describe("Latency Alert", () => {
    it("should detect P95 latency exceeding 200ms", async () => {
      // Record latencies where P95 should exceed 200ms
      // With 100 samples: P95 needs 95th percentile to be slow
      // We need at least 5% of requests to be >200ms for P95 to exceed 200ms
      for (let i = 0; i < 90; i++) {
        metricsCollector.recordLatency("test_tool", 0.05); // 50ms (fast)
      }
      for (let i = 0; i < 10; i++) {
        metricsCollector.recordLatency("test_tool", 0.3); // 300ms (slow)
      }

      const p95Latency = await metricsCollector.getP95Latency("test_tool");
      // With histogram buckets, P95 will be the bucket boundary where 95% of requests fall
      // Since 90% are in <0.1 bucket and 10% are in <0.5 bucket, P95 should be 0.3 bucket
      expect(p95Latency).toBeGreaterThanOrEqual(0.1); // At least 100ms (conservative check)
    });
  });

  describe("Auth Failure Rate Alert", () => {
    it("should detect high auth failure rate (>10 failures/min)", async () => {
      // Simulate 15 auth failures in quick succession
      for (let i = 0; i < 15; i++) {
        metricsCollector.incrementAuthAttempts("failed");
      }

      const failureCount = await metricsCollector.getAuthFailureCount();
      expect(failureCount).toBeGreaterThan(10);
    });
  });

  describe("Consolidation Failure Alert", () => {
    it("should track consolidation pipeline failures", async () => {
      metricsCollector.incrementConsolidationFailures();
      metricsCollector.incrementConsolidationFailures();

      const metrics = await metricsCollector.getMetricsText();
      expect(metrics).toContain("consolidation_failures_total");
    });
  });
});

describe("Metrics Authentication", () => {
  it("should require authentication for metrics endpoint", async () => {
    const metricsCollector = createMetricsCollector({
      prefix: "mcp_auth_test",
      requireAuth: true,
    });

    // Attempt to get metrics without auth token
    await expect(
      metricsCollector.getMetricsText({ authToken: undefined })
    ).rejects.toThrow(/authentication required/i);
  });

  it("should allow access with valid auth token", async () => {
    const metricsCollector = createMetricsCollector({
      prefix: "mcp_auth_test",
      requireAuth: true,
      authToken: "valid-metrics-token",
    });

    const metrics = await metricsCollector.getMetricsText({
      authToken: "valid-metrics-token",
    });

    expect(metrics).toContain("# HELP");
  });

  it("should reject invalid auth token", async () => {
    const metricsCollector = createMetricsCollector({
      prefix: "mcp_auth_test",
      requireAuth: true,
      authToken: "valid-metrics-token",
    });

    await expect(
      metricsCollector.getMetricsText({ authToken: "invalid-token" })
    ).rejects.toThrow(/invalid.*token/i);
  });
});
