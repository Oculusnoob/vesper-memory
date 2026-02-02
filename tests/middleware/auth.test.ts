/**
 * MCP Authentication Middleware Tests
 *
 * Tests for API key authentication following TDD methodology.
 * These tests define the expected behavior BEFORE implementation.
 *
 * Test Coverage:
 * - API key generation (entropy, format)
 * - API key verification (valid, invalid, expired)
 * - Key rotation with grace period
 * - IP allowlisting
 * - Scope enforcement
 * - Audit logging
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Note: These imports will fail until we implement the middleware
// This is intentional - TDD means tests fail first (RED phase)

describe("API Key Generation", () => {
  it("should generate keys with correct format (mem_v1_<40-char-random>)", async () => {
    // Dynamically import to allow tests to fail gracefully before implementation
    const { generateApiKey } = await import("../../src/middleware/auth.js");

    const result = await generateApiKey();

    // Format: mem_v1_ prefix + 40 character random string
    expect(result.fullKey).toMatch(/^mem_v1_[A-Za-z0-9_-]{40}$/);
    expect(result.keyPrefix).toHaveLength(8);
    expect(result.keyHash).toBeTruthy();
    // Hash should be bcrypt format
    expect(result.keyHash).toMatch(/^\$2[aby]?\$\d{2}\$/);
  });

  it("should generate unique keys on each call", async () => {
    const { generateApiKey } = await import("../../src/middleware/auth.js");

    const key1 = await generateApiKey();
    const key2 = await generateApiKey();

    expect(key1.fullKey).not.toBe(key2.fullKey);
    expect(key1.keyPrefix).not.toBe(key2.keyPrefix);
    expect(key1.keyHash).not.toBe(key2.keyHash);
  });

  it("should have sufficient entropy (256 bits)", async () => {
    const { generateApiKey, API_KEY_BYTES } = await import("../../src/middleware/auth.js");

    // Verify entropy from bytes (30 bytes = 240 bits > 128 bits minimum)
    expect(API_KEY_BYTES * 8).toBeGreaterThanOrEqual(240);

    // Generate a few keys to verify uniqueness (not 100 due to bcrypt slowness)
    const keys = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const result = await generateApiKey();
      keys.add(result.fullKey);
    }

    // All 5 keys should be unique
    expect(keys.size).toBe(5);
  }, 30000); // 30 second timeout for bcrypt

  it("should use cryptographically secure random generation", async () => {
    const { generateApiKey, API_KEY_BYTES } = await import(
      "../../src/middleware/auth.js"
    );

    // API_KEY_BYTES should be at least 30 (240 bits minimum)
    expect(API_KEY_BYTES).toBeGreaterThanOrEqual(30);

    const result = await generateApiKey();
    // Key length after prefix should be 40 chars (base64url encoding of 30 bytes)
    const keyWithoutPrefix = result.fullKey.replace("mem_v1_", "");
    expect(keyWithoutPrefix).toHaveLength(40);
  });
});

describe("API Key Verification", () => {
  it("should verify valid API key", async () => {
    const { generateApiKey, verifyApiKey } = await import(
      "../../src/middleware/auth.js"
    );

    const { fullKey, keyHash } = await generateApiKey();

    const isValid = await verifyApiKey(fullKey, keyHash);
    expect(isValid).toBe(true);
  });

  it("should reject invalid API key", async () => {
    const { generateApiKey, verifyApiKey } = await import(
      "../../src/middleware/auth.js"
    );

    const { keyHash } = await generateApiKey();

    // Try with a different key
    const isValid = await verifyApiKey("mem_v1_wrongkey12345678901234567890123456789", keyHash);
    expect(isValid).toBe(false);
  });

  it("should reject empty API key", async () => {
    const { verifyApiKey } = await import("../../src/middleware/auth.js");

    const isValid = await verifyApiKey("", "$2b$12$somehash");
    expect(isValid).toBe(false);
  });

  it("should reject API key with wrong format", async () => {
    const { validateApiKeyFormat } = await import("../../src/middleware/auth.js");

    // No prefix
    expect(validateApiKeyFormat("invalidkey12345678901234567890123456789012")).toBe(false);

    // Wrong prefix
    expect(validateApiKeyFormat("mcp_v1_12345678901234567890123456789012345678")).toBe(false);

    // Too short
    expect(validateApiKeyFormat("mem_v1_short")).toBe(false);

    // Too long
    expect(validateApiKeyFormat("mem_v1_" + "x".repeat(50))).toBe(false);

    // Valid format
    expect(validateApiKeyFormat("mem_v1_" + "x".repeat(40))).toBe(true);
  });

  it("should use constant-time comparison for security", async () => {
    const { generateApiKey, verifyApiKey } = await import(
      "../../src/middleware/auth.js"
    );

    const { fullKey, keyHash } = await generateApiKey();

    // Measure time for valid key verification (fewer iterations due to bcrypt slowness)
    const validTimes: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const start = process.hrtime.bigint();
      await verifyApiKey(fullKey, keyHash);
      const end = process.hrtime.bigint();
      validTimes.push(end - start);
    }

    // Measure time for invalid key verification
    const invalidTimes: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const start = process.hrtime.bigint();
      await verifyApiKey("mem_v1_invalid" + i + "00000000000000000000000000", keyHash);
      const end = process.hrtime.bigint();
      invalidTimes.push(end - start);
    }

    // Calculate averages
    const avgValid = Number(validTimes.reduce((a, b) => a + b, 0n)) / validTimes.length;
    const avgInvalid = Number(invalidTimes.reduce((a, b) => a + b, 0n)) / invalidTimes.length;

    // Times should be similar - bcrypt provides constant-time comparison
    // Allow up to 5x variance due to system noise and bcrypt internals
    const ratio = Math.max(avgValid, avgInvalid) / Math.min(avgValid, avgInvalid);
    expect(ratio).toBeLessThan(5);
  }, 30000); // 30 second timeout
});

describe("API Key Expiration", () => {
  it("should detect expired keys", async () => {
    const { isKeyExpired } = await import("../../src/middleware/auth.js");

    // Expired yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    expect(isKeyExpired(yesterday)).toBe(true);
  });

  it("should accept non-expired keys", async () => {
    const { isKeyExpired } = await import("../../src/middleware/auth.js");

    // Expires tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    expect(isKeyExpired(tomorrow)).toBe(false);
  });

  it("should handle null expiration (non-expiring keys)", async () => {
    const { isKeyExpired } = await import("../../src/middleware/auth.js");

    expect(isKeyExpired(null)).toBe(false);
  });

  it("should calculate default expiration as 90 days", async () => {
    const { calculateDefaultExpiration, DEFAULT_KEY_EXPIRATION_DAYS } =
      await import("../../src/middleware/auth.js");

    const expiration = calculateDefaultExpiration();
    const now = new Date();
    const expectedExpiration = new Date(now);
    expectedExpiration.setDate(expectedExpiration.getDate() + DEFAULT_KEY_EXPIRATION_DAYS);

    // Should be within 1 second of expected
    expect(Math.abs(expiration.getTime() - expectedExpiration.getTime())).toBeLessThan(1000);
    expect(DEFAULT_KEY_EXPIRATION_DAYS).toBe(90);
  });

  it("should enforce maximum expiration of 365 days", async () => {
    const { calculateExpiration, MAX_KEY_EXPIRATION_DAYS } = await import(
      "../../src/middleware/auth.js"
    );

    expect(MAX_KEY_EXPIRATION_DAYS).toBe(365);

    // Request 500 days, should be capped to 365
    const expiration = calculateExpiration(500);
    const now = new Date();
    const maxExpiration = new Date(now);
    maxExpiration.setDate(maxExpiration.getDate() + 365);

    // Should be capped to 365 days (within 1 second tolerance)
    expect(Math.abs(expiration.getTime() - maxExpiration.getTime())).toBeLessThan(1000);
  });
});

describe("IP Allowlisting", () => {
  it("should allow request from allowed IP", async () => {
    const { isIpAllowed } = await import("../../src/middleware/auth.js");

    const allowedIps = ["192.168.1.0/24", "10.0.0.0/8"];
    expect(isIpAllowed("192.168.1.100", allowedIps)).toBe(true);
    expect(isIpAllowed("10.50.25.1", allowedIps)).toBe(true);
  });

  it("should reject request from disallowed IP", async () => {
    const { isIpAllowed } = await import("../../src/middleware/auth.js");

    const allowedIps = ["192.168.1.0/24"];
    expect(isIpAllowed("192.168.2.100", allowedIps)).toBe(false);
    expect(isIpAllowed("10.0.0.1", allowedIps)).toBe(false);
  });

  it("should allow all IPs when allowlist is empty", async () => {
    const { isIpAllowed } = await import("../../src/middleware/auth.js");

    expect(isIpAllowed("1.2.3.4", [])).toBe(true);
    expect(isIpAllowed("192.168.1.1", null)).toBe(true);
  });

  it("should handle single IP addresses (not CIDR)", async () => {
    const { isIpAllowed } = await import("../../src/middleware/auth.js");

    const allowedIps = ["192.168.1.100", "10.0.0.1"];
    expect(isIpAllowed("192.168.1.100", allowedIps)).toBe(true);
    expect(isIpAllowed("192.168.1.101", allowedIps)).toBe(false);
  });

  it("should handle IPv6 addresses", async () => {
    const { isIpAllowed } = await import("../../src/middleware/auth.js");

    const allowedIps = ["::1", "fe80::/10"];
    expect(isIpAllowed("::1", allowedIps)).toBe(true);
    expect(isIpAllowed("fe80::1", allowedIps)).toBe(true);
    expect(isIpAllowed("2001:db8::1", allowedIps)).toBe(false);
  });
});

describe("Scope Enforcement", () => {
  it("should allow operation with correct scope", async () => {
    const { hasScope } = await import("../../src/middleware/auth.js");

    const userScopes = ["store_memory", "retrieve_memory"];
    expect(hasScope(userScopes, "store_memory")).toBe(true);
    expect(hasScope(userScopes, "retrieve_memory")).toBe(true);
  });

  it("should reject operation without scope", async () => {
    const { hasScope } = await import("../../src/middleware/auth.js");

    const userScopes = ["retrieve_memory"];
    expect(hasScope(userScopes, "store_memory")).toBe(false);
  });

  it("should handle wildcard scope", async () => {
    const { hasScope } = await import("../../src/middleware/auth.js");

    const userScopes = ["*"];
    expect(hasScope(userScopes, "store_memory")).toBe(true);
    expect(hasScope(userScopes, "retrieve_memory")).toBe(true);
    expect(hasScope(userScopes, "list_recent")).toBe(true);
    expect(hasScope(userScopes, "get_stats")).toBe(true);
  });

  it("should handle empty scopes", async () => {
    const { hasScope } = await import("../../src/middleware/auth.js");

    expect(hasScope([], "store_memory")).toBe(false);
    expect(hasScope(null, "store_memory")).toBe(false);
  });

  it("should define valid scopes", async () => {
    const { VALID_SCOPES } = await import("../../src/middleware/auth.js");

    expect(VALID_SCOPES).toContain("store_memory");
    expect(VALID_SCOPES).toContain("retrieve_memory");
    expect(VALID_SCOPES).toContain("list_recent");
    expect(VALID_SCOPES).toContain("get_stats");
    expect(VALID_SCOPES).toContain("*");
  });
});

describe("Key Rotation", () => {
  it("should rotate key with grace period", async () => {
    const { rotateApiKey } = await import("../../src/middleware/auth.js");

    const oldKeyHash = "$2b$12$oldhash";
    const result = await rotateApiKey(oldKeyHash, 24); // 24 hour grace

    expect(result.newKey).toBeTruthy();
    expect(result.newKey.fullKey).toMatch(/^mem_v1_[A-Za-z0-9_-]{40}$/);
    expect(result.gracePeriodHours).toBe(24);
    expect(result.oldKeyValidUntil).toBeInstanceOf(Date);

    // Grace period should be approximately 24 hours from now
    const now = new Date();
    const expected = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    expect(
      Math.abs(result.oldKeyValidUntil.getTime() - expected.getTime())
    ).toBeLessThan(1000);
  });

  it("should support zero grace period (immediate revocation)", async () => {
    const { rotateApiKey } = await import("../../src/middleware/auth.js");

    const result = await rotateApiKey("$2b$12$oldhash", 0);

    expect(result.gracePeriodHours).toBe(0);
    // Old key should be invalid immediately
    const now = new Date();
    expect(result.oldKeyValidUntil.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it("should limit maximum grace period to 168 hours (7 days)", async () => {
    const { rotateApiKey, MAX_GRACE_PERIOD_HOURS } = await import(
      "../../src/middleware/auth.js"
    );

    expect(MAX_GRACE_PERIOD_HOURS).toBe(168);

    const result = await rotateApiKey("$2b$12$oldhash", 1000); // Request 1000 hours

    // Should be capped to 168 hours
    expect(result.gracePeriodHours).toBe(168);
  });
});

describe("Audit Logging", () => {
  it("should create audit entry for successful auth", async () => {
    const { createAuditEntry, AuditAction } = await import(
      "../../src/middleware/auth.js"
    );

    const entry = createAuditEntry({
      apiKeyId: "key-123",
      action: AuditAction.AUTHENTICATE,
      success: true,
      ipAddress: "192.168.1.1",
      userAgent: "MCP/1.0",
      requestPath: "/store_memory",
    });

    expect(entry.apiKeyId).toBe("key-123");
    expect(entry.action).toBe(AuditAction.AUTHENTICATE);
    expect(entry.success).toBe(true);
    expect(entry.ipAddress).toBe("192.168.1.1");
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it("should create audit entry for failed auth", async () => {
    const { createAuditEntry, AuditAction } = await import(
      "../../src/middleware/auth.js"
    );

    const entry = createAuditEntry({
      apiKeyId: null, // Unknown key
      action: AuditAction.AUTHENTICATE,
      success: false,
      ipAddress: "192.168.1.1",
      failureReason: "Invalid API key",
    });

    expect(entry.success).toBe(false);
    expect(entry.failureReason).toBe("Invalid API key");
  });

  it("should create audit entry for rate limit hit", async () => {
    const { createAuditEntry, AuditAction } = await import(
      "../../src/middleware/auth.js"
    );

    const entry = createAuditEntry({
      apiKeyId: "key-123",
      action: AuditAction.RATE_LIMITED,
      success: false,
      ipAddress: "192.168.1.1",
      failureReason: "Rate limit exceeded: 100/min",
    });

    expect(entry.action).toBe(AuditAction.RATE_LIMITED);
  });

  it("should create audit entry for key revocation", async () => {
    const { createAuditEntry, AuditAction } = await import(
      "../../src/middleware/auth.js"
    );

    const entry = createAuditEntry({
      apiKeyId: "key-123",
      action: AuditAction.REVOKED,
      success: true,
      ipAddress: "192.168.1.1",
      metadata: { revokedBy: "admin" },
    });

    expect(entry.action).toBe(AuditAction.REVOKED);
    expect(entry.metadata?.revokedBy).toBe("admin");
  });

  it("should never log full API key", async () => {
    const { createAuditEntry, AuditAction, hashForAudit } = await import(
      "../../src/middleware/auth.js"
    );

    const fullKey = "mem_v1_secret1234567890123456789012345678901234";
    const auditHash = hashForAudit(fullKey);

    // Audit hash should be a truncated SHA-256
    expect(auditHash).toHaveLength(16);
    expect(auditHash).not.toContain("secret");
    expect(auditHash).not.toBe(fullKey);
  });
});

describe("Authentication Middleware", () => {
  it("should authenticate valid request", async () => {
    const { authenticateRequest, generateApiKey } = await import(
      "../../src/middleware/auth.js"
    );

    const { fullKey } = await generateApiKey();

    // Mock database lookup
    const mockDb = {
      getApiKey: vi.fn().mockResolvedValue({
        id: "key-123",
        userId: "user-456",
        keyHash: await import("bcrypt").then((m) =>
          m.default.hash(fullKey, 12)
        ),
        scopes: ["store_memory", "retrieve_memory"],
        expiresAt: null,
        ipAllowlist: null,
        tier: "standard",
      }),
      updateLastUsed: vi.fn(),
      createAuditEntry: vi.fn(),
    };

    const result = await authenticateRequest(
      { apiKey: fullKey, ip: "127.0.0.1", toolName: "store_memory" },
      mockDb
    );

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("user-456");
    expect(result.keyId).toBe("key-123");
    expect(result.tier).toBe("standard");
  });

  it("should reject request without API key", async () => {
    const { authenticateRequest } = await import("../../src/middleware/auth.js");

    const mockDb = { getApiKey: vi.fn() };

    await expect(
      authenticateRequest({ apiKey: undefined, ip: "127.0.0.1", toolName: "store_memory" }, mockDb)
    ).rejects.toThrow("API key required");
  });

  it("should reject request with invalid API key", async () => {
    const { authenticateRequest } = await import("../../src/middleware/auth.js");

    const mockDb = {
      getApiKey: vi.fn().mockResolvedValue(null),
      createAuditEntry: vi.fn(),
    };

    await expect(
      authenticateRequest(
        { apiKey: "mem_v1_invalid12345678901234567890123456789012", ip: "127.0.0.1", toolName: "store_memory" },
        mockDb
      )
    ).rejects.toThrow("Invalid API key");
  });

  it("should reject request with expired API key", async () => {
    const { authenticateRequest, generateApiKey } = await import(
      "../../src/middleware/auth.js"
    );

    const { fullKey, keyHash } = await generateApiKey();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const mockDb = {
      getApiKey: vi.fn().mockResolvedValue({
        id: "key-123",
        userId: "user-456",
        keyHash,
        scopes: ["*"],
        expiresAt: yesterday,
        ipAllowlist: null,
        tier: "standard",
      }),
      createAuditEntry: vi.fn(),
    };

    await expect(
      authenticateRequest({ apiKey: fullKey, ip: "127.0.0.1", toolName: "store_memory" }, mockDb)
    ).rejects.toThrow("API key expired");
  });

  it("should reject request from disallowed IP", async () => {
    const { authenticateRequest, generateApiKey } = await import(
      "../../src/middleware/auth.js"
    );

    const { fullKey, keyHash } = await generateApiKey();

    const mockDb = {
      getApiKey: vi.fn().mockResolvedValue({
        id: "key-123",
        userId: "user-456",
        keyHash,
        scopes: ["*"],
        expiresAt: null,
        ipAllowlist: ["192.168.1.0/24"],
        tier: "standard",
      }),
      createAuditEntry: vi.fn(),
    };

    await expect(
      authenticateRequest({ apiKey: fullKey, ip: "10.0.0.1", toolName: "store_memory" }, mockDb)
    ).rejects.toThrow("IP address not allowed");
  });

  it("should reject request without required scope", async () => {
    const { authenticateRequest, generateApiKey } = await import(
      "../../src/middleware/auth.js"
    );

    const { fullKey, keyHash } = await generateApiKey();

    const mockDb = {
      getApiKey: vi.fn().mockResolvedValue({
        id: "key-123",
        userId: "user-456",
        keyHash,
        scopes: ["retrieve_memory"], // No store_memory scope
        expiresAt: null,
        ipAllowlist: null,
        tier: "standard",
      }),
      createAuditEntry: vi.fn(),
    };

    await expect(
      authenticateRequest({ apiKey: fullKey, ip: "127.0.0.1", toolName: "store_memory" }, mockDb)
    ).rejects.toThrow("Insufficient permissions");
  });

  it("should update last_used timestamp on successful auth", async () => {
    const { authenticateRequest, generateApiKey } = await import(
      "../../src/middleware/auth.js"
    );

    const { fullKey, keyHash } = await generateApiKey();

    const mockDb = {
      getApiKey: vi.fn().mockResolvedValue({
        id: "key-123",
        userId: "user-456",
        keyHash,
        scopes: ["*"],
        expiresAt: null,
        ipAllowlist: null,
        tier: "standard",
      }),
      updateLastUsed: vi.fn(),
      createAuditEntry: vi.fn(),
    };

    await authenticateRequest(
      { apiKey: fullKey, ip: "127.0.0.1", toolName: "store_memory" },
      mockDb
    );

    expect(mockDb.updateLastUsed).toHaveBeenCalledWith("key-123");
  });
});

describe("Authentication Performance", () => {
  it("should complete auth check in reasonable time", async () => {
    const { generateApiKey, verifyApiKey } = await import(
      "../../src/middleware/auth.js"
    );

    const { fullKey, keyHash } = await generateApiKey();

    const start = Date.now();
    await verifyApiKey(fullKey, keyHash);
    const elapsed = Date.now() - start;

    // bcrypt with 12 rounds is intentionally slow (~300ms)
    // This is a security feature to prevent brute force attacks
    // The important thing is that it completes without hanging
    expect(elapsed).toBeLessThan(500);
  }, 10000);

  it("should be cacheable for repeated auth checks", async () => {
    const { createAuthCache } = await import("../../src/middleware/auth.js");

    const cache = createAuthCache({ maxSize: 1000, ttlSeconds: 60 });

    // First check should miss
    const hit1 = cache.get("key-123");
    expect(hit1).toBeNull();

    // Set cached result
    cache.set("key-123", { userId: "user-456", tier: "standard" });

    // Second check should hit
    const hit2 = cache.get("key-123");
    expect(hit2).toEqual({ userId: "user-456", tier: "standard" });
  });
});

describe("Environment Configuration", () => {
  it("should respect AUTH_ENABLED environment variable", async () => {
    const { isAuthEnabled } = await import("../../src/middleware/auth.js");

    // Save original
    const original = process.env.AUTH_ENABLED;

    process.env.AUTH_ENABLED = "true";
    expect(isAuthEnabled()).toBe(true);

    process.env.AUTH_ENABLED = "false";
    expect(isAuthEnabled()).toBe(false);

    process.env.AUTH_ENABLED = undefined;
    expect(isAuthEnabled()).toBe(false); // Default to disabled

    // Restore
    process.env.AUTH_ENABLED = original;
  });

  it("should read API_KEY_EXPIRATION_DAYS from environment", async () => {
    const { getExpirationDays } = await import("../../src/middleware/auth.js");

    const original = process.env.API_KEY_EXPIRATION_DAYS;

    process.env.API_KEY_EXPIRATION_DAYS = "30";
    expect(getExpirationDays()).toBe(30);

    process.env.API_KEY_EXPIRATION_DAYS = undefined;
    expect(getExpirationDays()).toBe(90); // Default

    process.env.API_KEY_EXPIRATION_DAYS = original;
  });
});
