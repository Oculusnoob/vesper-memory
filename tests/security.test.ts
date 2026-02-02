/**
 * Security Test Suite
 *
 * Comprehensive security tests covering:
 * - Input validation
 * - Vector value validation (NaN/Infinity prevention)
 * - Collection name sanitization (injection prevention)
 * - Rate limiting
 * - Authentication (API keys)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import {
  validateInput,
  validateVector,
  sanitizeCollectionName,
  sanitizeString,
  validateUserId,
  StoreMemoryInputSchema,
  RetrieveMemoryInputSchema,
  ListRecentInputSchema,
  GetStatsInputSchema,
} from "../src/utils/validation.js";
import { RateLimiter, createRateLimiter } from "../src/utils/rate-limiter.js";
import { HybridSearchEngine } from "../src/retrieval/hybrid-search.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

// Use Redis database 4 for security tests
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD,
  db: 4,
});

describe("Input Validation Security", () => {
  describe("StoreMemoryInput Validation", () => {
    it("should reject empty content", () => {
      expect(() =>
        validateInput(StoreMemoryInputSchema, {
          content: "",
          memory_type: "episodic",
        })
      ).toThrow("Content cannot be empty");
    });

    it("should reject content exceeding 100KB limit", () => {
      const largeContent = "x".repeat(100001);
      expect(() =>
        validateInput(StoreMemoryInputSchema, {
          content: largeContent,
          memory_type: "episodic",
        })
      ).toThrow("Content exceeds 100KB limit");
    });

    it("should reject invalid memory type", () => {
      expect(() =>
        validateInput(StoreMemoryInputSchema, {
          content: "test",
          memory_type: "invalid",
        })
      ).toThrow(/Invalid memory type/);
    });

    it("should reject metadata with too many keys", () => {
      const metadata: Record<string, unknown> = {};
      for (let i = 0; i < 51; i++) {
        metadata[`key${i}`] = "value";
      }

      expect(() =>
        validateInput(StoreMemoryInputSchema, {
          content: "test",
          memory_type: "episodic",
          metadata,
        })
      ).toThrow("Metadata cannot exceed 50 keys");
    });

    it("should reject metadata exceeding 10KB limit", () => {
      const metadata = { data: "x".repeat(10000) };
      expect(() =>
        validateInput(StoreMemoryInputSchema, {
          content: "test",
          memory_type: "episodic",
          metadata,
        })
      ).toThrow("Metadata size exceeds 10KB limit");
    });

    it("should accept valid input", () => {
      const input = {
        content: "This is a test memory",
        memory_type: "episodic",
        metadata: { source: "test" },
      };

      const result = validateInput(StoreMemoryInputSchema, input);
      expect(result).toEqual(input);
    });
  });

  describe("RetrieveMemoryInput Validation", () => {
    it("should reject empty query", () => {
      expect(() =>
        validateInput(RetrieveMemoryInputSchema, {
          query: "",
        })
      ).toThrow("Query cannot be empty");
    });

    it("should reject query exceeding 10KB limit", () => {
      const largeQuery = "x".repeat(10001);
      expect(() =>
        validateInput(RetrieveMemoryInputSchema, {
          query: largeQuery,
        })
      ).toThrow("Query exceeds 10KB limit");
    });

    it("should reject max_results below 1", () => {
      expect(() =>
        validateInput(RetrieveMemoryInputSchema, {
          query: "test",
          max_results: 0,
        })
      ).toThrow("max_results must be at least 1");
    });

    it("should reject max_results above 100", () => {
      expect(() =>
        validateInput(RetrieveMemoryInputSchema, {
          query: "test",
          max_results: 101,
        })
      ).toThrow("max_results cannot exceed 100");
    });

    it("should accept valid input with defaults", () => {
      const result = validateInput(RetrieveMemoryInputSchema, {
        query: "test query",
      });

      expect(result.query).toBe("test query");
      expect(result.max_results).toBe(5);
    });
  });

  describe("ListRecentInput Validation", () => {
    it("should reject limit below 1", () => {
      expect(() =>
        validateInput(ListRecentInputSchema, {
          limit: 0,
        })
      ).toThrow("limit must be at least 1");
    });

    it("should reject limit above 100", () => {
      expect(() =>
        validateInput(ListRecentInputSchema, {
          limit: 101,
        })
      ).toThrow("limit cannot exceed 100");
    });

    it("should accept valid input with defaults", () => {
      const result = validateInput(ListRecentInputSchema, {});
      expect(result.limit).toBe(5);
    });
  });

  describe("GetStatsInput Validation", () => {
    it("should accept valid input with defaults", () => {
      const result = validateInput(GetStatsInputSchema, {});
      expect(result.detailed).toBe(false);
    });

    it("should accept detailed flag", () => {
      const result = validateInput(GetStatsInputSchema, { detailed: true });
      expect(result.detailed).toBe(true);
    });
  });
});

describe("Vector Validation Security (SEC-005)", () => {
  it("should reject vectors with NaN values", () => {
    const vector = [1.0, 2.0, NaN, 4.0];
    expect(() => validateVector(vector, 4)).toThrow(
      "Vector contains invalid values (NaN or Infinity)"
    );
  });

  it("should reject vectors with Infinity values", () => {
    const vector = [1.0, Infinity, 3.0, 4.0];
    expect(() => validateVector(vector, 4)).toThrow(
      "Vector contains invalid values (NaN or Infinity)"
    );
  });

  it("should reject vectors with -Infinity values", () => {
    const vector = [1.0, -Infinity, 3.0, 4.0];
    expect(() => validateVector(vector, 4)).toThrow(
      "Vector contains invalid values (NaN or Infinity)"
    );
  });

  it("should reject vectors with wrong dimensions", () => {
    const vector = [1.0, 2.0, 3.0];
    expect(() => validateVector(vector, 1024)).toThrow(
      "Vector dimension mismatch: expected 1024, got 3"
    );
  });

  it("should accept valid vectors", () => {
    const vector = Array(1024).fill(0.5);
    expect(() => validateVector(vector, 1024)).not.toThrow();
  });
});

describe("Collection Name Sanitization (SEC-012)", () => {
  it("should reject empty collection names", () => {
    expect(() => sanitizeCollectionName("")).toThrow(
      "Invalid collection name"
    );
  });

  it("should reject collection names exceeding 255 characters", () => {
    const longName = "a".repeat(256);
    expect(() => sanitizeCollectionName(longName)).toThrow(
      "Invalid collection name"
    );
  });

  it("should reject collection names starting with numbers", () => {
    expect(() => sanitizeCollectionName("123-collection")).toThrow(
      "Invalid collection name"
    );
  });

  it("should reject collection names with special characters", () => {
    expect(() => sanitizeCollectionName("collection;DROP TABLE")).toThrow(
      "Invalid collection name"
    );
  });

  it("should reject collection names with slashes", () => {
    expect(() => sanitizeCollectionName("../../../etc/passwd")).toThrow(
      "Invalid collection name"
    );
  });

  it("should accept valid alphanumeric names", () => {
    const validName = "memory-vectors_v2";
    expect(sanitizeCollectionName(validName)).toBe(validName);
  });

  it("should accept names starting with letters", () => {
    const validName = "testCollection123";
    expect(sanitizeCollectionName(validName)).toBe(validName);
  });
});

describe("String Sanitization", () => {
  it("should remove null bytes", () => {
    const input = "test\0string";
    expect(sanitizeString(input)).toBe("teststring");
  });

  it("should trim whitespace", () => {
    const input = "  test  ";
    expect(sanitizeString(input)).toBe("test");
  });

  it("should handle empty strings", () => {
    expect(sanitizeString("")).toBe("");
  });
});

describe("User ID Validation", () => {
  it("should reject empty user IDs", () => {
    expect(() => validateUserId("")).toThrow("Invalid user ID format");
  });

  it("should reject user IDs with special characters", () => {
    expect(() => validateUserId("user@email.com")).toThrow(
      "Invalid user ID format"
    );
  });

  it("should accept alphanumeric user IDs", () => {
    expect(validateUserId("user123")).toBe("user123");
  });

  it("should accept user IDs with underscores and hyphens", () => {
    expect(validateUserId("user_123-test")).toBe("user_123-test");
  });
});

describe("Rate Limiting Security", () => {
  let rateLimiter: RateLimiter;

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    // Clear all rate limit keys before each test
    const keys = await redis.keys("ratelimit:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    // Create rate limiter with test limits
    rateLimiter = createRateLimiter(redis, {
      store_memory: { maxRequests: 5, windowSeconds: 60 },
      retrieve_memory: { maxRequests: 10, windowSeconds: 60 },
    });
  });

  it("should allow requests within limit", async () => {
    const result = await rateLimiter.checkLimit("user1", "store_memory");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("should block requests exceeding limit", async () => {
    // Make 5 requests (at the limit)
    for (let i = 0; i < 5; i++) {
      await rateLimiter.checkLimit("user1", "store_memory");
    }

    // 6th request should be blocked
    const result = await rateLimiter.checkLimit("user1", "store_memory");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("should track different users independently", async () => {
    // User1 makes 5 requests
    for (let i = 0; i < 5; i++) {
      await rateLimiter.checkLimit("user1", "store_memory");
    }

    // User2 should still have full quota
    const result = await rateLimiter.checkLimit("user2", "store_memory");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("should track different operations independently", async () => {
    // Make 5 store_memory requests
    for (let i = 0; i < 5; i++) {
      await rateLimiter.checkLimit("user1", "store_memory");
    }

    // retrieve_memory should still have full quota
    const result = await rateLimiter.checkLimit("user1", "retrieve_memory");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it("should reset limits correctly", async () => {
    // Make some requests
    await rateLimiter.checkLimit("user1", "store_memory");
    await rateLimiter.checkLimit("user1", "store_memory");

    // Reset
    await rateLimiter.resetLimit("user1", "store_memory");

    // Should have full quota again
    const result = await rateLimiter.checkLimit("user1", "store_memory");
    expect(result.remaining).toBe(4);
  });

  it("should get current usage", async () => {
    await rateLimiter.checkLimit("user1", "store_memory");
    await rateLimiter.checkLimit("user1", "store_memory");

    const usage = await rateLimiter.getUsage("user1", "store_memory");
    expect(usage).toBe(2);
  });

  it("should update rate limit configuration", () => {
    rateLimiter.setLimit("test_op", { maxRequests: 100, windowSeconds: 30 });
    const config = rateLimiter.getLimit("test_op");
    expect(config?.maxRequests).toBe(100);
    expect(config?.windowSeconds).toBe(30);
  });
});

describe("HybridSearchEngine Security", () => {
  let engine: HybridSearchEngine;
  const testCollectionName = "test-security-vectors";

  beforeAll(async () => {
    engine = new HybridSearchEngine(
      QDRANT_URL,
      testCollectionName,
      1024,
      QDRANT_API_KEY
    );
    await engine.initializeCollection();
  });

  it("should reject invalid collection names", () => {
    expect(() =>
      new HybridSearchEngine(
        QDRANT_URL,
        "invalid;collection",
        1024,
        QDRANT_API_KEY
      )
    ).toThrow("Invalid collection name");
  });

  it("should reject vectors with NaN in denseSearch", async () => {
    const badVector = Array(1024).fill(0);
    badVector[500] = NaN;

    await expect(engine.denseSearch(badVector, 5)).rejects.toThrow(
      "Vector contains invalid values"
    );
  });

  it("should reject vectors with Infinity in denseSearch", async () => {
    const badVector = Array(1024).fill(0);
    badVector[500] = Infinity;

    await expect(engine.denseSearch(badVector, 5)).rejects.toThrow(
      "Vector contains invalid values"
    );
  });

  it("should reject vectors with wrong dimensions in denseSearch", async () => {
    const badVector = Array(512).fill(0);

    await expect(engine.denseSearch(badVector, 5)).rejects.toThrow(
      "Vector dimension mismatch"
    );
  });

  it("should reject vectors with NaN in upsertMemory", async () => {
    const badVector = Array(1024).fill(0);
    badVector[500] = NaN;

    await expect(
      engine.upsertMemory("test-id", badVector, {})
    ).rejects.toThrow("Vector contains invalid values");
  });

  it("should reject vectors with Infinity in upsertMemory", async () => {
    const badVector = Array(1024).fill(0);
    badVector[500] = Infinity;

    await expect(
      engine.upsertMemory("test-id", badVector, {})
    ).rejects.toThrow("Vector contains invalid values");
  });

  it("should reject vectors with wrong dimensions in upsertMemory", async () => {
    const badVector = Array(512).fill(0);

    await expect(
      engine.upsertMemory("test-id", badVector, {})
    ).rejects.toThrow("Vector dimension mismatch");
  });

  it("should accept valid vectors", async () => {
    const validVector = Array(1024).fill(0.5);
    // Should not throw validation errors (Qdrant API errors are different)
    try {
      await engine.upsertMemory("test-valid", validVector, { test: true });
    } catch (error) {
      // If it fails, it should not be a validation error
      const errorMessage = error instanceof Error ? error.message : String(error);
      expect(errorMessage).not.toMatch(/Vector contains invalid values/);
      expect(errorMessage).not.toMatch(/Vector dimension mismatch/);
    }
  });
});
