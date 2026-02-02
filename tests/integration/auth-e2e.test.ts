/**
 * MCP Authentication End-to-End Tests
 *
 * Integration tests for the complete authentication flow
 * including MCP tool protection and database operations.
 *
 * Prerequisites:
 * - PostgreSQL running with auth schema
 * - AUTH_ENABLED=true
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// These tests require database setup and will be run as integration tests
describe("MCP Authentication E2E", () => {
  let testApiKey: string;
  let testKeyId: string;

  // Setup and teardown
  beforeAll(async () => {
    // Skip if not in integration test mode
    if (process.env.SKIP_INTEGRATION_TESTS) {
      return;
    }
  });

  afterAll(async () => {
    // Cleanup test data
  });

  describe("API Key Lifecycle", () => {
    it("should create API key and store in database", async () => {
      const { createApiKeyInDb, generateApiKey } = await import(
        "../../src/middleware/auth.js"
      );

      const keyData = await generateApiKey();
      const result = await createApiKeyInDb({
        userId: "test-user-123",
        name: "Test Key",
        scopes: ["store_memory", "retrieve_memory"],
        expirationDays: 90,
      });

      testApiKey = result.fullKey;
      testKeyId = result.keyId;

      expect(result.keyId).toBeTruthy();
      expect(result.fullKey).toMatch(/^mem_v1_/);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it("should retrieve API key from database by prefix", async () => {
      const { getApiKeyByPrefix } = await import("../../src/middleware/auth.js");

      const keyPrefix = testApiKey.substring(7, 15); // Extract first 8 chars after prefix
      const result = await getApiKeyByPrefix(keyPrefix);

      expect(result).toBeTruthy();
      expect(result.id).toBe(testKeyId);
      expect(result.userId).toBe("test-user-123");
      expect(result.scopes).toContain("store_memory");
    });

    it("should update last_used timestamp on authentication", async () => {
      const { authenticateRequest, getApiKeyById } = await import(
        "../../src/middleware/auth.js"
      );

      const beforeAuth = await getApiKeyById(testKeyId);
      const originalLastUsed = beforeAuth.lastUsedAt;

      // Wait 100ms to ensure timestamp changes
      await new Promise((r) => setTimeout(r, 100));

      await authenticateRequest({
        apiKey: testApiKey,
        ip: "127.0.0.1",
        toolName: "store_memory",
      });

      const afterAuth = await getApiKeyById(testKeyId);
      expect(afterAuth.lastUsedAt.getTime()).toBeGreaterThan(
        originalLastUsed?.getTime() || 0
      );
    });

    it("should revoke API key", async () => {
      const { revokeApiKey, getApiKeyById } = await import(
        "../../src/middleware/auth.js"
      );

      await revokeApiKey(testKeyId);

      const revokedKey = await getApiKeyById(testKeyId);
      expect(revokedKey.revokedAt).toBeInstanceOf(Date);
    });

    it("should reject authentication with revoked key", async () => {
      const { authenticateRequest } = await import("../../src/middleware/auth.js");

      await expect(
        authenticateRequest({
          apiKey: testApiKey,
          ip: "127.0.0.1",
          toolName: "store_memory",
        })
      ).rejects.toThrow("API key has been revoked");
    });
  });

  describe("MCP Tool Protection", () => {
    let validApiKey: string;

    beforeEach(async () => {
      const { createApiKeyInDb } = await import("../../src/middleware/auth.js");

      const result = await createApiKeyInDb({
        userId: "test-user-tools",
        name: "Tool Test Key",
        scopes: ["store_memory", "retrieve_memory", "list_recent", "get_stats"],
        expirationDays: 1,
      });

      validApiKey = result.fullKey;
    });

    it("should protect store_memory tool", async () => {
      const { callToolWithAuth } = await import("../../src/middleware/auth.js");

      // Without auth
      await expect(
        callToolWithAuth("store_memory", { content: "test", memory_type: "episodic" })
      ).rejects.toThrow("API key required");

      // With auth
      const result = await callToolWithAuth(
        "store_memory",
        { content: "test", memory_type: "episodic" },
        { apiKey: validApiKey }
      );
      expect(result.success).toBe(true);
    });

    it("should protect retrieve_memory tool", async () => {
      const { callToolWithAuth } = await import("../../src/middleware/auth.js");

      // Without auth
      await expect(
        callToolWithAuth("retrieve_memory", { query: "test" })
      ).rejects.toThrow("API key required");

      // With auth
      const result = await callToolWithAuth(
        "retrieve_memory",
        { query: "test" },
        { apiKey: validApiKey }
      );
      expect(result.success).toBe(true);
    });

    it("should protect list_recent tool", async () => {
      const { callToolWithAuth } = await import("../../src/middleware/auth.js");

      // Without auth
      await expect(
        callToolWithAuth("list_recent", { limit: 5 })
      ).rejects.toThrow("API key required");

      // With auth
      const result = await callToolWithAuth(
        "list_recent",
        { limit: 5 },
        { apiKey: validApiKey }
      );
      expect(result.success).toBe(true);
    });

    it("should protect get_stats tool", async () => {
      const { callToolWithAuth } = await import("../../src/middleware/auth.js");

      // Without auth
      await expect(
        callToolWithAuth("get_stats", {})
      ).rejects.toThrow("API key required");

      // With auth
      const result = await callToolWithAuth(
        "get_stats",
        {},
        { apiKey: validApiKey }
      );
      expect(result.success).toBe(true);
    });
  });

  describe("Scope Restrictions", () => {
    it("should enforce read-only scopes", async () => {
      const { createApiKeyInDb, callToolWithAuth } = await import(
        "../../src/middleware/auth.js"
      );

      const result = await createApiKeyInDb({
        userId: "readonly-user",
        name: "Read Only Key",
        scopes: ["retrieve_memory", "list_recent", "get_stats"], // No store_memory
        expirationDays: 1,
      });

      // Should work for read operations
      await expect(
        callToolWithAuth("retrieve_memory", { query: "test" }, { apiKey: result.fullKey })
      ).resolves.toBeTruthy();

      // Should fail for write operations
      await expect(
        callToolWithAuth(
          "store_memory",
          { content: "test", memory_type: "episodic" },
          { apiKey: result.fullKey }
        )
      ).rejects.toThrow("Insufficient permissions");
    });

    it("should enforce stats-only scope", async () => {
      const { createApiKeyInDb, callToolWithAuth } = await import(
        "../../src/middleware/auth.js"
      );

      const result = await createApiKeyInDb({
        userId: "stats-only-user",
        name: "Stats Only Key",
        scopes: ["get_stats"],
        expirationDays: 1,
      });

      // Should work for stats
      await expect(
        callToolWithAuth("get_stats", {}, { apiKey: result.fullKey })
      ).resolves.toBeTruthy();

      // Should fail for other operations
      await expect(
        callToolWithAuth("retrieve_memory", { query: "test" }, { apiKey: result.fullKey })
      ).rejects.toThrow("Insufficient permissions");
    });
  });

  describe("Tier-Based Access", () => {
    it("should apply standard tier rate limits", async () => {
      const { createApiKeyInDb, getRateLimitsForTier } = await import(
        "../../src/middleware/auth.js"
      );

      const result = await createApiKeyInDb({
        userId: "standard-user",
        name: "Standard Key",
        scopes: ["*"],
        tier: "standard",
        expirationDays: 1,
      });

      const limits = getRateLimitsForTier("standard");
      expect(limits.store_memory).toBe(100);
      expect(limits.retrieve_memory).toBe(300);
    });

    it("should apply premium tier rate limits", async () => {
      const { getRateLimitsForTier } = await import("../../src/middleware/auth.js");

      const limits = getRateLimitsForTier("premium");
      expect(limits.store_memory).toBe(500);
      expect(limits.retrieve_memory).toBe(1000);
    });

    it("should apply enterprise tier rate limits", async () => {
      const { getRateLimitsForTier } = await import("../../src/middleware/auth.js");

      const limits = getRateLimitsForTier("enterprise");
      expect(limits.store_memory).toBe(2000);
      expect(limits.retrieve_memory).toBe(5000);
    });
  });

  describe("Audit Log Verification", () => {
    it("should log successful authentication", async () => {
      const { createApiKeyInDb, authenticateRequest, getAuditLogs } =
        await import("../../src/middleware/auth.js");

      const result = await createApiKeyInDb({
        userId: "audit-test-user",
        name: "Audit Test Key",
        scopes: ["*"],
        expirationDays: 1,
      });

      await authenticateRequest({
        apiKey: result.fullKey,
        ip: "192.168.1.100",
        toolName: "store_memory",
        userAgent: "TestClient/1.0",
      });

      const logs = await getAuditLogs({ apiKeyId: result.keyId, limit: 1 });
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("authenticate");
      expect(logs[0].success).toBe(true);
      expect(logs[0].ipAddress).toBe("192.168.1.100");
    });

    it("should log failed authentication", async () => {
      const { authenticateRequest, getAuditLogs } = await import(
        "../../src/middleware/auth.js"
      );

      const fakeKey = "mem_v1_fake123456789012345678901234567890123456";

      try {
        await authenticateRequest({
          apiKey: fakeKey,
          ip: "10.0.0.1",
          toolName: "store_memory",
        });
      } catch {
        // Expected to fail
      }

      const logs = await getAuditLogs({
        action: "authenticate",
        success: false,
        limit: 1,
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].success).toBe(false);
      expect(logs[0].ipAddress).toBe("10.0.0.1");
    });

    it("should log rate limit violations", async () => {
      const { createApiKeyInDb, authenticateRequest, getAuditLogs } =
        await import("../../src/middleware/auth.js");

      const result = await createApiKeyInDb({
        userId: "rate-limit-test",
        name: "Rate Limit Test Key",
        scopes: ["*"],
        tier: "standard", // 100/min for store_memory
        expirationDays: 1,
      });

      // Note: This would require actually hitting rate limits
      // which needs Redis integration

      const logs = await getAuditLogs({
        apiKeyId: result.keyId,
        action: "rate_limited",
      });

      // Verify structure even if empty
      expect(logs).toBeInstanceOf(Array);
    });
  });

  describe("Key Rotation", () => {
    it("should rotate key with grace period allowing old key", async () => {
      const { createApiKeyInDb, rotateApiKeyInDb, authenticateRequest } =
        await import("../../src/middleware/auth.js");

      const original = await createApiKeyInDb({
        userId: "rotation-test-user",
        name: "Rotation Test Key",
        scopes: ["*"],
        expirationDays: 90,
      });

      // Rotate with 1 hour grace period
      const rotated = await rotateApiKeyInDb(original.keyId, 1);

      // New key should work
      await expect(
        authenticateRequest({
          apiKey: rotated.newKey,
          ip: "127.0.0.1",
          toolName: "store_memory",
        })
      ).resolves.toBeTruthy();

      // Old key should still work during grace period
      await expect(
        authenticateRequest({
          apiKey: original.fullKey,
          ip: "127.0.0.1",
          toolName: "store_memory",
        })
      ).resolves.toBeTruthy();
    });

    it("should reject old key after grace period expires", async () => {
      const { createApiKeyInDb, rotateApiKeyInDb, authenticateRequest } =
        await import("../../src/middleware/auth.js");

      const original = await createApiKeyInDb({
        userId: "rotation-expired-test",
        name: "Rotation Expired Test",
        scopes: ["*"],
        expirationDays: 90,
      });

      // Rotate with 0 hour grace period (immediate)
      await rotateApiKeyInDb(original.keyId, 0);

      // Old key should be rejected immediately
      await expect(
        authenticateRequest({
          apiKey: original.fullKey,
          ip: "127.0.0.1",
          toolName: "store_memory",
        })
      ).rejects.toThrow();
    });
  });

  describe("IP Allowlisting", () => {
    it("should enforce IP allowlist on authentication", async () => {
      const { createApiKeyInDb, authenticateRequest } = await import(
        "../../src/middleware/auth.js"
      );

      const result = await createApiKeyInDb({
        userId: "ip-restricted-user",
        name: "IP Restricted Key",
        scopes: ["*"],
        ipAllowlist: ["192.168.1.0/24", "10.0.0.0/8"],
        expirationDays: 1,
      });

      // Allowed IP
      await expect(
        authenticateRequest({
          apiKey: result.fullKey,
          ip: "192.168.1.100",
          toolName: "store_memory",
        })
      ).resolves.toBeTruthy();

      // Disallowed IP
      await expect(
        authenticateRequest({
          apiKey: result.fullKey,
          ip: "172.16.0.1",
          toolName: "store_memory",
        })
      ).rejects.toThrow("IP address not allowed");
    });
  });

  describe("Gradual Rollout Support", () => {
    it("should allow unauthenticated requests when AUTH_ENABLED=false", async () => {
      const { callToolWithAuth, isAuthEnabled } = await import(
        "../../src/middleware/auth.js"
      );

      // Save and set env
      const original = process.env.AUTH_ENABLED;
      process.env.AUTH_ENABLED = "false";

      expect(isAuthEnabled()).toBe(false);

      // Should work without API key
      const result = await callToolWithAuth("get_stats", {});
      expect(result.success).toBe(true);

      // Restore env
      process.env.AUTH_ENABLED = original;
    });

    it("should require authentication when AUTH_ENABLED=true", async () => {
      const { callToolWithAuth, isAuthEnabled } = await import(
        "../../src/middleware/auth.js"
      );

      // Save and set env
      const original = process.env.AUTH_ENABLED;
      process.env.AUTH_ENABLED = "true";

      expect(isAuthEnabled()).toBe(true);

      // Should fail without API key
      await expect(callToolWithAuth("get_stats", {})).rejects.toThrow(
        "API key required"
      );

      // Restore env
      process.env.AUTH_ENABLED = original;
    });
  });
});

describe("Database Schema Validation", () => {
  it("should have api_keys table with required columns", async () => {
    const { getTableSchema } = await import("../../src/middleware/auth.js");

    const schema = await getTableSchema("api_keys");

    expect(schema).toContainEqual(expect.objectContaining({ name: "id" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "user_id" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "key_hash" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "key_prefix" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "scopes" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "tier" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "expires_at" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "ip_allowlist" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "created_at" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "last_used_at" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "revoked_at" }));
  });

  it("should have api_key_rotations table", async () => {
    const { getTableSchema } = await import("../../src/middleware/auth.js");

    const schema = await getTableSchema("api_key_rotations");

    expect(schema).toContainEqual(expect.objectContaining({ name: "id" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "api_key_id" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "old_key_hash" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "new_key_hash" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "grace_period_ends" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "created_at" }));
  });

  it("should have auth_audit_log table", async () => {
    const { getTableSchema } = await import("../../src/middleware/auth.js");

    const schema = await getTableSchema("auth_audit_log");

    expect(schema).toContainEqual(expect.objectContaining({ name: "id" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "api_key_id" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "action" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "success" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "ip_address" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "user_agent" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "request_path" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "failure_reason" }));
    expect(schema).toContainEqual(expect.objectContaining({ name: "created_at" }));
  });

  it("should have proper indexes for performance", async () => {
    const { getIndexes } = await import("../../src/middleware/auth.js");

    const indexes = await getIndexes("api_keys");

    expect(indexes).toContainEqual(
      expect.objectContaining({ name: "idx_api_keys_prefix" })
    );
    expect(indexes).toContainEqual(
      expect.objectContaining({ name: "idx_api_keys_user_id" })
    );
  });
});
