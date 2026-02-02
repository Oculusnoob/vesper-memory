#!/usr/bin/env npx tsx
/**
 * API Key Generation Script
 *
 * Generates a new API key for MCP authentication.
 *
 * Usage:
 *   npx tsx scripts/generate-api-key.ts
 *   npx tsx scripts/generate-api-key.ts --user-id myuser --tier premium
 *
 * Output:
 *   - Full API key (show to user ONCE)
 *   - bcrypt hash (store in database or .env)
 *   - Environment variable format for .env file
 */

import { randomBytes } from "crypto";
import bcrypt from "bcrypt";

// Constants (must match src/middleware/auth.ts)
const API_KEY_PREFIX = "mem_v1_";
const API_KEY_BYTES = 30;
const BCRYPT_ROUNDS = 12;

interface GeneratedKey {
  fullKey: string;
  keyPrefix: string;
  keyHash: string;
}

async function generateApiKey(): Promise<GeneratedKey> {
  // Generate cryptographically secure random bytes
  const randomPart = randomBytes(API_KEY_BYTES).toString("base64url").slice(0, 40);
  const fullKey = `${API_KEY_PREFIX}${randomPart}`;

  // Extract prefix for database lookup
  const keyPrefix = randomPart.slice(0, 8);

  // Hash with bcrypt for secure storage
  const keyHash = await bcrypt.hash(fullKey, BCRYPT_ROUNDS);

  return {
    fullKey,
    keyPrefix,
    keyHash,
  };
}

async function main(): Promise<void> {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let userId = "default-user";
  let tier = "standard";
  let scopes = ["store_memory", "retrieve_memory", "list_recent", "get_stats"];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--user-id":
        userId = args[++i] || userId;
        break;
      case "--tier":
        tier = args[++i] || tier;
        break;
      case "--scopes":
        scopes = (args[++i] || "").split(",").filter(Boolean);
        if (scopes.length === 0) {
          scopes = ["*"];
        }
        break;
      case "--help":
        console.log(`
API Key Generation Script

Usage:
  npx tsx scripts/generate-api-key.ts [options]

Options:
  --user-id <id>    User ID to associate with the key (default: default-user)
  --tier <tier>     Rate limit tier: standard, premium, enterprise (default: standard)
  --scopes <list>   Comma-separated scopes (default: all tools)
  --help            Show this help message

Examples:
  npx tsx scripts/generate-api-key.ts
  npx tsx scripts/generate-api-key.ts --user-id myuser --tier premium
  npx tsx scripts/generate-api-key.ts --scopes retrieve_memory,get_stats
        `);
        process.exit(0);
    }
  }

  console.log("\n=== Generating MCP API Key ===\n");
  console.log("Parameters:");
  console.log(`  User ID: ${userId}`);
  console.log(`  Tier:    ${tier}`);
  console.log(`  Scopes:  ${scopes.join(", ")}`);
  console.log("");

  // Generate the key
  const key = await generateApiKey();

  console.log("=== IMPORTANT: Save this information ===\n");

  console.log("API Key (show to user ONCE, never store in plaintext):");
  console.log(`  ${key.fullKey}\n`);

  console.log("Key Prefix (for identification):");
  console.log(`  ${key.keyPrefix}\n`);

  console.log("bcrypt Hash (store in database or .env):");
  console.log(`  ${key.keyHash}\n`);

  console.log("=== Environment Variables for .env ===\n");
  console.log(`# MCP Authentication`);
  console.log(`AUTH_ENABLED=true`);
  console.log(`MCP_API_KEY_HASH=${key.keyHash}`);
  console.log(`MCP_API_KEY_USER_ID=${userId}`);
  console.log(`MCP_API_KEY_TIER=${tier}`);
  console.log(`MCP_API_KEY_SCOPES=${scopes.join(",")}`);
  console.log("");

  console.log("=== PostgreSQL Insert Statement ===\n");
  console.log(`INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes, tier, expires_at)`);
  console.log(`VALUES (`);
  console.log(`  '${userId}',`);
  console.log(`  '${key.keyHash}',`);
  console.log(`  '${key.keyPrefix}',`);
  console.log(`  'API Key for ${userId}',`);
  console.log(`  ARRAY[${scopes.map((s) => `'${s}'`).join(", ")}]::TEXT[],`);
  console.log(`  '${tier}',`);
  console.log(`  NOW() + INTERVAL '90 days'`);
  console.log(`);\n`);

  console.log("=== Testing the Key ===\n");
  console.log("Verify the key works:");
  console.log(`  MCP_API_KEY=${key.fullKey} npm run dev\n`);

  console.log("=== Security Reminders ===\n");
  console.log("1. Never share the full API key in logs, emails, or chat");
  console.log("2. Store only the bcrypt hash in your database or .env file");
  console.log("3. The key prefix can be used for identification in logs");
  console.log("4. Rotate keys every 90 days (or as configured)\n");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
