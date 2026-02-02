/**
 * MCP Authentication Middleware
 *
 * Implements API key authentication for MCP tools with:
 * - Bearer token authentication
 * - bcrypt password hashing
 * - Key expiration
 * - IP allowlisting
 * - Scope-based authorization
 * - Audit logging
 *
 * Security Features:
 * - Constant-time comparison via bcrypt
 * - No plaintext key storage
 * - Gradual rollout support (AUTH_ENABLED env var)
 * - Rate limit tier enforcement
 */

import { randomBytes, createHash } from "crypto";
import bcrypt from "bcrypt";

// =============================================================================
// Constants
// =============================================================================

/** API key format prefix */
export const API_KEY_PREFIX = "mem_v1_";

/** Number of random bytes for key generation (30 bytes = 40 chars base64url) */
export const API_KEY_BYTES = 30;

/** bcrypt work factor (12 = ~250ms on modern hardware) */
export const BCRYPT_ROUNDS = 12;

/** Default key expiration in days */
export const DEFAULT_KEY_EXPIRATION_DAYS = 90;

/** Maximum allowed key expiration in days */
export const MAX_KEY_EXPIRATION_DAYS = 365;

/** Maximum grace period for key rotation in hours */
export const MAX_GRACE_PERIOD_HOURS = 168; // 7 days

/** Valid scopes for API keys */
export const VALID_SCOPES = [
  "store_memory",
  "retrieve_memory",
  "list_recent",
  "get_stats",
  "*", // Wildcard for all permissions
] as const;

export type ValidScope = (typeof VALID_SCOPES)[number];

// =============================================================================
// Types
// =============================================================================

/** Result of API key generation */
export interface GeneratedApiKey {
  fullKey: string; // Return once to user, never store
  keyPrefix: string; // First 8 chars for identification
  keyHash: string; // bcrypt hash for storage
}

/** API key record from database */
export interface ApiKeyRecord {
  id: string;
  userId: string;
  keyHash: string;
  scopes: string[];
  tier: string;
  expiresAt: Date | null;
  ipAllowlist: string[] | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

/** Authentication result */
export interface AuthResult {
  authenticated: boolean;
  userId: string;
  keyId: string;
  tier: string;
  scopes: string[];
}

/** Audit log actions */
export enum AuditAction {
  AUTHENTICATE = "authenticate",
  RATE_LIMITED = "rate_limited",
  REVOKED = "revoked",
  ROTATED = "rotated",
  CREATED = "created",
  SCOPE_DENIED = "scope_denied",
  IP_DENIED = "ip_denied",
  EXPIRED = "expired",
}

/** Audit log entry */
export interface AuditEntry {
  apiKeyId: string | null;
  action: AuditAction;
  success: boolean;
  ipAddress: string | null;
  userAgent?: string;
  requestPath?: string;
  failureReason?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

/** Key rotation result */
export interface RotationResult {
  newKey: GeneratedApiKey;
  gracePeriodHours: number;
  oldKeyValidUntil: Date;
}

/** Request context for authentication */
export interface AuthRequest {
  apiKey: string | undefined;
  ip: string;
  toolName: string;
  userAgent?: string;
}

/** Database interface for auth operations */
export interface AuthDatabase {
  getApiKey(prefix: string): Promise<ApiKeyRecord | null>;
  updateLastUsed(keyId: string): Promise<void>;
  createAuditEntry(entry: AuditEntry): Promise<void>;
}

/** Rate limits per tier */
export interface TierRateLimits {
  store_memory: number;
  retrieve_memory: number;
  list_recent: number;
  get_stats: number;
}

/** Auth cache entry */
interface CacheEntry {
  userId: string;
  tier: string;
  expiresAt: number;
}

// =============================================================================
// API Key Generation
// =============================================================================

/**
 * Generate a new API key with cryptographically secure random bytes
 *
 * @returns Generated key with full key, prefix, and hash
 */
export async function generateApiKey(): Promise<GeneratedApiKey> {
  // Generate cryptographically secure random bytes
  const randomPart = randomBytes(API_KEY_BYTES).toString("base64url").slice(0, 40);
  const fullKey = `${API_KEY_PREFIX}${randomPart}`;

  // Extract prefix for database lookup (first 8 chars after prefix)
  const keyPrefix = randomPart.slice(0, 8);

  // Hash with bcrypt for secure storage
  const keyHash = await bcrypt.hash(fullKey, BCRYPT_ROUNDS);

  return {
    fullKey,
    keyPrefix,
    keyHash,
  };
}

// =============================================================================
// API Key Verification
// =============================================================================

/**
 * Verify an API key against its stored hash
 *
 * Uses bcrypt.compare for constant-time comparison
 *
 * @param providedKey - The API key provided by the client
 * @param storedHash - The bcrypt hash stored in the database
 * @returns true if key is valid
 */
export async function verifyApiKey(
  providedKey: string,
  storedHash: string
): Promise<boolean> {
  if (!providedKey || !storedHash) {
    return false;
  }

  // bcrypt.compare provides constant-time comparison
  return bcrypt.compare(providedKey, storedHash);
}

/**
 * Validate API key format without database lookup
 *
 * @param key - API key to validate
 * @returns true if format is valid
 */
export function validateApiKeyFormat(key: string): boolean {
  if (!key || typeof key !== "string") {
    return false;
  }

  // Must start with correct prefix
  if (!key.startsWith(API_KEY_PREFIX)) {
    return false;
  }

  // Must have exactly 40 characters after prefix
  const keyPart = key.slice(API_KEY_PREFIX.length);
  if (keyPart.length !== 40) {
    return false;
  }

  // Must be valid base64url characters
  return /^[A-Za-z0-9_-]+$/.test(keyPart);
}

/**
 * Extract the prefix from an API key for database lookup
 *
 * @param key - Full API key
 * @returns 8-character prefix or null if invalid
 */
export function extractKeyPrefix(key: string): string | null {
  if (!validateApiKeyFormat(key)) {
    return null;
  }

  return key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 8);
}

// =============================================================================
// Expiration Handling
// =============================================================================

/**
 * Check if an API key is expired
 *
 * @param expiresAt - Expiration date (null means never expires)
 * @returns true if key is expired
 */
export function isKeyExpired(expiresAt: Date | null): boolean {
  if (expiresAt === null) {
    return false;
  }

  return new Date() > expiresAt;
}

/**
 * Calculate default expiration date (90 days from now)
 *
 * @returns Expiration date
 */
export function calculateDefaultExpiration(): Date {
  const expiration = new Date();
  expiration.setDate(expiration.getDate() + DEFAULT_KEY_EXPIRATION_DAYS);
  return expiration;
}

/**
 * Calculate expiration date with custom days (capped at max)
 *
 * @param days - Number of days until expiration
 * @returns Expiration date
 */
export function calculateExpiration(days: number): Date {
  const cappedDays = Math.min(days, MAX_KEY_EXPIRATION_DAYS);
  const expiration = new Date();
  expiration.setDate(expiration.getDate() + cappedDays);
  return expiration;
}

/**
 * Get expiration days from environment or default
 *
 * @returns Number of days for key expiration
 */
export function getExpirationDays(): number {
  const envDays = process.env.API_KEY_EXPIRATION_DAYS;
  if (envDays) {
    const parsed = parseInt(envDays, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_KEY_EXPIRATION_DAYS);
    }
  }
  return DEFAULT_KEY_EXPIRATION_DAYS;
}

// =============================================================================
// IP Allowlisting
// =============================================================================

/**
 * Check if an IP address is in the allowlist
 *
 * Supports both individual IPs and CIDR notation
 *
 * @param ip - Client IP address
 * @param allowlist - Array of allowed IPs/CIDRs (empty or null allows all)
 * @returns true if IP is allowed
 */
export function isIpAllowed(
  ip: string,
  allowlist: string[] | null | undefined
): boolean {
  // Empty or null allowlist means all IPs are allowed
  if (!allowlist || allowlist.length === 0) {
    return true;
  }

  // Normalize IP for comparison
  const normalizedIp = normalizeIp(ip);

  for (const allowed of allowlist) {
    if (matchIp(normalizedIp, allowed)) {
      return true;
    }
  }

  return false;
}

/**
 * Normalize an IP address for comparison
 */
function normalizeIp(ip: string): string {
  // Handle IPv4-mapped IPv6 addresses
  if (ip.startsWith("::ffff:")) {
    return ip.slice(7);
  }
  return ip;
}

/**
 * Check if an IP matches an allowed pattern (IP or CIDR)
 */
function matchIp(ip: string, allowed: string): boolean {
  // Check for CIDR notation
  if (allowed.includes("/")) {
    return matchCidr(ip, allowed);
  }

  // Exact match
  return normalizeIp(ip) === normalizeIp(allowed);
}

/**
 * Check if an IP matches a CIDR range
 */
function matchCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split("/");
  const mask = parseInt(bits, 10);

  // Handle IPv6
  if (ip.includes(":") || range.includes(":")) {
    return matchCidrIpv6(ip, range, mask);
  }

  // IPv4 CIDR matching
  const ipNum = ipv4ToNumber(ip);
  const rangeNum = ipv4ToNumber(range);
  const maskNum = ~((1 << (32 - mask)) - 1);

  return (ipNum & maskNum) === (rangeNum & maskNum);
}

/**
 * Convert IPv4 address to number for CIDR matching
 */
function ipv4ToNumber(ip: string): number {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

/**
 * Match IPv6 CIDR (simplified implementation)
 */
function matchCidrIpv6(ip: string, range: string, mask: number): boolean {
  // Expand both addresses to full form
  const ipFull = expandIpv6(ip);
  const rangeFull = expandIpv6(range);

  // Compare the required number of bits
  const bitsToCompare = Math.ceil(mask / 4);
  const ipHex = ipFull.replace(/:/g, "");
  const rangeHex = rangeFull.replace(/:/g, "");

  return ipHex.slice(0, bitsToCompare) === rangeHex.slice(0, bitsToCompare);
}

/**
 * Expand IPv6 address to full form
 */
function expandIpv6(ip: string): string {
  // Handle :: expansion
  if (ip.includes("::")) {
    const [left, right] = ip.split("::");
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    const missing = 8 - leftParts.length - rightParts.length;
    const middle = Array(missing).fill("0000");
    const parts = [...leftParts, ...middle, ...rightParts];
    return parts.map((p) => p.padStart(4, "0")).join(":");
  }

  return ip
    .split(":")
    .map((p) => p.padStart(4, "0"))
    .join(":");
}

// =============================================================================
// Scope Enforcement
// =============================================================================

/**
 * Check if user has required scope
 *
 * @param userScopes - Scopes granted to user
 * @param requiredScope - Scope required for operation
 * @returns true if user has scope
 */
export function hasScope(
  userScopes: string[] | null | undefined,
  requiredScope: string
): boolean {
  if (!userScopes || userScopes.length === 0) {
    return false;
  }

  // Wildcard grants all permissions
  if (userScopes.includes("*")) {
    return true;
  }

  return userScopes.includes(requiredScope);
}

// =============================================================================
// Key Rotation
// =============================================================================

/**
 * Rotate an API key with optional grace period
 *
 * @param oldKeyHash - Hash of the old key (unused, for signature compatibility)
 * @param gracePeriodHours - Hours to allow old key (0 = immediate revocation)
 * @returns New key and grace period info
 */
export async function rotateApiKey(
  _oldKeyHash: string,
  gracePeriodHours: number
): Promise<RotationResult> {
  // Cap grace period
  const cappedGracePeriod = Math.min(gracePeriodHours, MAX_GRACE_PERIOD_HOURS);

  // Generate new key
  const newKey = await generateApiKey();

  // Calculate when old key becomes invalid
  const oldKeyValidUntil = new Date();
  oldKeyValidUntil.setTime(
    oldKeyValidUntil.getTime() + cappedGracePeriod * 60 * 60 * 1000
  );

  return {
    newKey,
    gracePeriodHours: cappedGracePeriod,
    oldKeyValidUntil,
  };
}

// =============================================================================
// Audit Logging
// =============================================================================

/**
 * Create an audit log entry
 *
 * @param params - Audit entry parameters
 * @returns Audit entry object
 */
export function createAuditEntry(params: {
  apiKeyId: string | null;
  action: AuditAction;
  success: boolean;
  ipAddress: string | null;
  userAgent?: string;
  requestPath?: string;
  failureReason?: string;
  metadata?: Record<string, unknown>;
}): AuditEntry {
  return {
    ...params,
    createdAt: new Date(),
  };
}

/**
 * Hash an API key for audit logging (never log full key)
 *
 * @param key - Full API key
 * @returns Truncated SHA-256 hash for identification
 */
export function hashForAudit(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// =============================================================================
// Authentication Middleware
// =============================================================================

/**
 * Authenticate an MCP request
 *
 * @param request - Request context
 * @param db - Database interface
 * @returns Authentication result
 * @throws Error if authentication fails
 */
export async function authenticateRequest(
  request: AuthRequest,
  db: AuthDatabase
): Promise<AuthResult> {
  const { apiKey, ip, toolName } = request;

  // Check if API key is provided
  if (!apiKey) {
    throw new Error("API key required");
  }

  // Validate format
  if (!validateApiKeyFormat(apiKey)) {
    await db.createAuditEntry(
      createAuditEntry({
        apiKeyId: null,
        action: AuditAction.AUTHENTICATE,
        success: false,
        ipAddress: ip,
        failureReason: "Invalid API key format",
      })
    );
    throw new Error("Invalid API key");
  }

  // Extract prefix for lookup
  const prefix = extractKeyPrefix(apiKey);
  if (!prefix) {
    throw new Error("Invalid API key");
  }

  // Look up key in database
  const keyRecord = await db.getApiKey(prefix);
  if (!keyRecord) {
    await db.createAuditEntry(
      createAuditEntry({
        apiKeyId: null,
        action: AuditAction.AUTHENTICATE,
        success: false,
        ipAddress: ip,
        failureReason: "API key not found",
      })
    );
    throw new Error("Invalid API key");
  }

  // Check if key is revoked
  if (keyRecord.revokedAt) {
    await db.createAuditEntry(
      createAuditEntry({
        apiKeyId: keyRecord.id,
        action: AuditAction.AUTHENTICATE,
        success: false,
        ipAddress: ip,
        failureReason: "API key revoked",
      })
    );
    throw new Error("API key has been revoked");
  }

  // Verify key hash
  const isValid = await verifyApiKey(apiKey, keyRecord.keyHash);
  if (!isValid) {
    await db.createAuditEntry(
      createAuditEntry({
        apiKeyId: keyRecord.id,
        action: AuditAction.AUTHENTICATE,
        success: false,
        ipAddress: ip,
        failureReason: "Invalid API key",
      })
    );
    throw new Error("Invalid API key");
  }

  // Check expiration
  if (isKeyExpired(keyRecord.expiresAt)) {
    await db.createAuditEntry(
      createAuditEntry({
        apiKeyId: keyRecord.id,
        action: AuditAction.EXPIRED,
        success: false,
        ipAddress: ip,
        failureReason: "API key expired",
      })
    );
    throw new Error("API key expired");
  }

  // Check IP allowlist
  if (!isIpAllowed(ip, keyRecord.ipAllowlist)) {
    await db.createAuditEntry(
      createAuditEntry({
        apiKeyId: keyRecord.id,
        action: AuditAction.IP_DENIED,
        success: false,
        ipAddress: ip,
        failureReason: `IP ${ip} not in allowlist`,
      })
    );
    throw new Error("IP address not allowed");
  }

  // Check scope
  if (!hasScope(keyRecord.scopes, toolName)) {
    await db.createAuditEntry(
      createAuditEntry({
        apiKeyId: keyRecord.id,
        action: AuditAction.SCOPE_DENIED,
        success: false,
        ipAddress: ip,
        failureReason: `Missing scope: ${toolName}`,
      })
    );
    throw new Error("Insufficient permissions");
  }

  // Update last used timestamp
  await db.updateLastUsed(keyRecord.id);

  // Log successful authentication
  await db.createAuditEntry(
    createAuditEntry({
      apiKeyId: keyRecord.id,
      action: AuditAction.AUTHENTICATE,
      success: true,
      ipAddress: ip,
      requestPath: toolName,
      userAgent: request.userAgent,
    })
  );

  return {
    authenticated: true,
    userId: keyRecord.userId,
    keyId: keyRecord.id,
    tier: keyRecord.tier,
    scopes: keyRecord.scopes,
  };
}

// =============================================================================
// Environment Configuration
// =============================================================================

/**
 * Check if authentication is enabled
 *
 * @returns true if AUTH_ENABLED=true
 */
export function isAuthEnabled(): boolean {
  return process.env.AUTH_ENABLED === "true";
}

// =============================================================================
// Rate Limit Tiers
// =============================================================================

/** Default rate limits per tier */
const TIER_RATE_LIMITS: Record<string, TierRateLimits> = {
  standard: {
    store_memory: 100,
    retrieve_memory: 300,
    list_recent: 60,
    get_stats: 30,
  },
  premium: {
    store_memory: 500,
    retrieve_memory: 1000,
    list_recent: 200,
    get_stats: 100,
  },
  unlimited: {
    store_memory: 2000,
    retrieve_memory: 5000,
    list_recent: 500,
    get_stats: 300,
  },
};

/**
 * Get rate limits for a tier
 *
 * @param tier - Rate limit tier
 * @returns Rate limits for the tier
 */
export function getRateLimitsForTier(tier: string): TierRateLimits {
  return TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS.standard;
}

// =============================================================================
// Auth Cache
// =============================================================================

/**
 * Create an in-memory cache for auth results
 *
 * @param options - Cache configuration
 * @returns Cache object with get/set methods
 */
export function createAuthCache(options: { maxSize: number; ttlSeconds: number }) {
  const cache = new Map<string, CacheEntry>();
  const { maxSize, ttlSeconds } = options;

  return {
    get(keyId: string): { userId: string; tier: string } | null {
      const entry = cache.get(keyId);
      if (!entry) {
        return null;
      }

      // Check TTL
      if (Date.now() > entry.expiresAt) {
        cache.delete(keyId);
        return null;
      }

      return { userId: entry.userId, tier: entry.tier };
    },

    set(keyId: string, value: { userId: string; tier: string }): void {
      // Evict oldest if at max size
      if (cache.size >= maxSize) {
        const firstKey = cache.keys().next().value;
        if (firstKey) {
          cache.delete(firstKey);
        }
      }

      cache.set(keyId, {
        userId: value.userId,
        tier: value.tier,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    },

    /**
     * Invalidate a specific key from the cache
     * HIGH-002: Used to immediately invalidate revoked/rotated keys
     *
     * @param keyId - The key ID (prefix) to invalidate
     * @returns true if key was in cache, false otherwise
     */
    invalidate(keyId: string): boolean {
      return cache.delete(keyId);
    },

    clear(): void {
      cache.clear();
    },

    size(): number {
      return cache.size;
    },
  };
}

// =============================================================================
// Cache Invalidation Helpers (HIGH-002)
// =============================================================================

/**
 * Type for cache invalidation callback
 */
export type AuthCache = ReturnType<typeof createAuthCache>;

/**
 * Revoke an API key and invalidate it from cache
 * HIGH-002: Ensures revoked keys cannot be used even if cached
 *
 * @param keyPrefix - The key prefix to revoke
 * @param cache - The auth cache instance
 * @param reason - Reason for revocation (for audit logging)
 * @returns true if key was invalidated from cache
 */
export function revokeApiKey(
  keyPrefix: string,
  cache: AuthCache,
  reason: string = "manual_revocation"
): boolean {
  console.error(`[INFO] Revoking API key: ${keyPrefix.slice(0, 4)}... (reason: ${reason})`);

  // Invalidate from cache immediately
  const wasInCache = cache.invalidate(keyPrefix);

  if (wasInCache) {
    console.error(`[INFO] Key ${keyPrefix.slice(0, 4)}... invalidated from cache`);
  }

  // In production, this would also update the PostgreSQL revoked_at timestamp
  // UPDATE api_keys SET revoked_at = NOW() WHERE key_prefix = $1

  return wasInCache;
}

/**
 * Invalidate a rotated API key from cache
 * HIGH-002: Ensures old keys cannot be used during rotation
 *
 * @param oldKeyPrefix - The old key prefix being rotated
 * @param cache - The auth cache instance
 * @returns true if old key was invalidated from cache
 */
export function invalidateRotatedKey(
  oldKeyPrefix: string,
  cache: AuthCache
): boolean {
  console.error(`[INFO] Invalidating rotated key: ${oldKeyPrefix.slice(0, 4)}...`);

  // Invalidate old key from cache immediately
  const wasInCache = cache.invalidate(oldKeyPrefix);

  if (wasInCache) {
    console.error(`[INFO] Old key ${oldKeyPrefix.slice(0, 4)}... invalidated from cache`);
  }

  return wasInCache;
}
