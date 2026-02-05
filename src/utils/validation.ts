/**
 * Input Validation Module
 *
 * Provides Zod schemas and validation functions for all MCP tool inputs
 * and internal data types. Prevents injection attacks, DoS via oversized
 * payloads, and data corruption.
 *
 * Security Features:
 * - Length limits on all string inputs
 * - Enum validation for controlled vocabularies
 * - Vector value validation (NaN/Infinity prevention)
 * - Collection name sanitization (injection prevention)
 */

import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ============================================================================
// MCP Tool Input Schemas
// ============================================================================

/**
 * Schema for store_memory tool input
 *
 * Enforces:
 * - Content between 1 and 100,000 characters (100KB limit)
 * - Memory type must be one of: episodic, semantic, procedural
 * - Metadata object optional, max 50 keys
 */
export const StoreMemoryInputSchema = z.object({
  content: z.string()
    .min(1, "Content cannot be empty")
    .max(100000, "Content exceeds 100KB limit"),

  memory_type: z.enum(["episodic", "semantic", "procedural"], {
    message: "Invalid memory type. Must be episodic, semantic, or procedural"
  }),

  metadata: z.record(z.string(), z.unknown())
    .optional()
    .refine((val) => !val || Object.keys(val).length <= 50, "Metadata cannot exceed 50 keys")
    .refine((val) => !val || JSON.stringify(val).length <= 10000, "Metadata size exceeds 10KB limit"),
});

export type StoreMemoryInput = z.infer<typeof StoreMemoryInputSchema>;

/**
 * Schema for retrieve_memory tool input
 *
 * Enforces:
 * - Query between 1 and 10,000 characters (10KB limit)
 * - Memory types array max 10 items
 * - Max results between 1 and 100
 */
export const RetrieveMemoryInputSchema = z.object({
  query: z.string()
    .min(1, "Query cannot be empty")
    .max(10000, "Query exceeds 10KB limit"),

  memory_types: z.array(z.enum(["episodic", "semantic", "procedural"]))
    .max(10, "Cannot filter by more than 10 memory types")
    .optional(),

  max_results: z.number()
    .int("max_results must be an integer")
    .min(1, "max_results must be at least 1")
    .max(100, "max_results cannot exceed 100")
    .optional()
    .default(5),

  routing_strategy: z.enum(["fast_path", "semantic", "full_text", "graph"])
    .optional(),
});

export type RetrieveMemoryInput = z.infer<typeof RetrieveMemoryInputSchema>;

/**
 * Schema for list_recent tool input
 */
export const ListRecentInputSchema = z.object({
  limit: z.number()
    .int("limit must be an integer")
    .min(1, "limit must be at least 1")
    .max(100, "limit cannot exceed 100")
    .optional()
    .default(5),

  memory_type: z.enum(["episodic", "semantic", "procedural"])
    .optional(),
});

export type ListRecentInput = z.infer<typeof ListRecentInputSchema>;

/**
 * Schema for get_stats tool input
 */
export const GetStatsInputSchema = z.object({
  detailed: z.boolean()
    .optional()
    .default(false),
});

export type GetStatsInput = z.infer<typeof GetStatsInputSchema>;

/**
 * Schema for record_skill_outcome tool input
 *
 * Records success or failure feedback for a skill execution.
 * Used to improve skill ranking over time.
 *
 * Enforces:
 * - skill_id is required
 * - outcome must be 'success' or 'failure'
 * - satisfaction is required for success (0-1 range)
 */
export const RecordSkillOutcomeInputSchema = z.object({
  skill_id: z.string()
    .min(1, "skill_id cannot be empty"),

  outcome: z.enum(["success", "failure"], {
    message: "outcome must be 'success' or 'failure'"
  }),

  satisfaction: z.number()
    .min(0, "satisfaction must be at least 0")
    .max(1, "satisfaction cannot exceed 1")
    .optional(),
}).refine(
  (data) => {
    // satisfaction is required for success outcome
    if (data.outcome === 'success' && data.satisfaction === undefined) {
      return false;
    }
    return true;
  },
  {
    message: "satisfaction is required when outcome is 'success'",
    path: ["satisfaction"]
  }
);

export type RecordSkillOutcomeInput = z.infer<typeof RecordSkillOutcomeInputSchema>;

/**
 * Schema for load_skill tool input
 *
 * Loads full skill implementation on-demand for execution.
 * Part of lazy loading system to reduce token usage.
 *
 * Enforces:
 * - skill_id is required and non-empty
 * - skill_id must match expected format (skill_*)
 */
export const LoadSkillInputSchema = z.object({
  skill_id: z.string()
    .min(1, "skill_id cannot be empty")
    .max(255, "skill_id cannot exceed 255 characters")
    .regex(/^skill_[a-z0-9_]+$/i, "Invalid skill_id format (must be skill_*)"),
});

export type LoadSkillInput = z.infer<typeof LoadSkillInputSchema>;

// ============================================================================
// Internal Data Type Schemas
// ============================================================================

/**
 * Vector validation schema
 *
 * Validates that all vector elements are finite numbers.
 * Prevents NaN poisoning attacks that corrupt vector indexes.
 *
 * Security: SEC-005 fix
 */
export const VectorSchema = z.array(z.number())
  .refine(
    (arr) => arr.every(v => Number.isFinite(v)),
    { message: "Vector contains NaN or Infinity values" }
  );

/**
 * Collection name validation schema
 *
 * Enforces alphanumeric names with underscores/hyphens only.
 * Prevents injection attacks via malicious collection names.
 *
 * Security: SEC-012 fix
 */
export const CollectionNameSchema = z.string()
  .min(1, "Collection name cannot be empty")
  .max(255, "Collection name cannot exceed 255 characters")
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    "Collection name must start with a letter and contain only alphanumeric characters, underscores, or hyphens"
  );

/**
 * User ID schema (for rate limiting)
 */
export const UserIdSchema = z.string()
  .min(1, "User ID cannot be empty")
  .max(255, "User ID cannot exceed 255 characters")
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "User ID must be alphanumeric with underscores or hyphens only"
  );

// ============================================================================
// Validation Helper Functions
// ============================================================================

/**
 * Validates input against a Zod schema and returns typed result
 *
 * @param schema - Zod schema to validate against
 * @param input - Raw input to validate
 * @returns Validated and typed data
 * @throws McpError if validation fails
 */
export function validateInput<T>(schema: z.ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    const errors = result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new McpError(
      ErrorCode.InvalidParams,
      `Validation failed: ${errors}`
    );
  }

  return result.data;
}

/**
 * Validates a vector has correct dimensions and finite values
 *
 * @param vector - Vector to validate
 * @param expectedSize - Expected vector dimension
 * @returns true if valid
 * @throws Error if invalid
 */
export function validateVector(vector: number[], expectedSize: number): void {
  // Dimension check
  if (vector.length !== expectedSize) {
    throw new Error(
      `Vector dimension mismatch: expected ${expectedSize}, got ${vector.length}`
    );
  }

  // Value validation (NaN/Infinity check)
  if (!vector.every(v => Number.isFinite(v))) {
    throw new Error(
      "Vector contains invalid values (NaN or Infinity)"
    );
  }
}

/**
 * Sanitizes a collection name to prevent injection attacks
 *
 * @param name - Collection name to sanitize
 * @returns Sanitized collection name
 * @throws Error if name is invalid
 */
export function sanitizeCollectionName(name: string): string {
  const result = CollectionNameSchema.safeParse(name);

  if (!result.success) {
    const error = result.error.issues[0];
    throw new Error(`Invalid collection name: ${error.message}`);
  }

  return result.data;
}

/**
 * Sanitizes a string by removing potentially dangerous characters
 *
 * @param input - String to sanitize
 * @returns Sanitized string
 */
export function sanitizeString(input: string): string {
  // Remove null bytes
  let sanitized = input.replace(/\0/g, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  return sanitized;
}

/**
 * Validates a user ID for rate limiting
 *
 * @param userId - User ID to validate
 * @returns Validated user ID
 * @throws Error if invalid
 */
export function validateUserId(userId: string): string {
  const result = UserIdSchema.safeParse(userId);

  if (!result.success) {
    throw new Error("Invalid user ID format");
  }

  return result.data;
}
