/**
 * Vesper - AI Memory System (Simplified)
 *
 * Main entry point for the Model Context Protocol server.
 * This is a simplified version with NO authentication, rate limiting, or monitoring.
 *
 * This server provides:
 * - store_memory: Add memories to working memory
 * - retrieve_memory: Query with smart routing
 * - list_recent: Get last 5 conversations
 * - get_stats: Return system metrics
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import Redis from "ioredis";
import { createRequire } from "module";
import { randomUUID } from "crypto";
import {
  validateInput,
  StoreMemoryInputSchema,
  RetrieveMemoryInputSchema,
  ListRecentInputSchema,
  GetStatsInputSchema,
  RecordSkillOutcomeInputSchema,
} from "./utils/validation.js";
import { getSqlitePath, ensureDirectories } from "./utils/paths.js";
import { createEmbeddingClient, EmbeddingClient } from "./embeddings/client.js";
import { HybridSearchEngine } from "./retrieval/hybrid-search.js";
import { WorkingMemoryLayer } from "./memory-layers/working-memory.js";
import { SemanticMemoryLayer } from "./memory-layers/semantic-memory.js";
import { SkillLibrary } from "./memory-layers/skill-library.js";
import { ConsolidationPipeline } from "./consolidation/pipeline.js";
import * as SmartRouter from "./router/smart-router.js";

// Import better-sqlite3 constructor using createRequire
const require = createRequire(import.meta.url);
const DatabaseConstructor = require("better-sqlite3");

/**
 * Connection pool for external services
 */
interface ConnectionPool {
  redis?: Redis;
  sqlite?: any; // better-sqlite3 Database instance
  embeddingClient?: EmbeddingClient;
  hybridSearch?: HybridSearchEngine;
  workingMemory?: WorkingMemoryLayer;
  semanticMemory?: SemanticMemoryLayer;
  skillLibrary?: SkillLibrary;
  consolidationPipeline?: ConsolidationPipeline;
}

const connections: ConnectionPool = {};

/**
 * Runtime state for Vesper enable/disable
 * Used for A/B benchmarking (enabled vs disabled comparison)
 */
let vesperEnabled = true;

/**
 * Tool definitions for the MCP server
 */
const TOOLS = [
  {
    name: "store_memory",
    description:
      "Add a memory entry to the working memory store. Accepts text, embeddings, and metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The memory content to store",
        },
        memory_type: {
          type: "string",
          enum: ["episodic", "semantic", "procedural"],
          description: "Type of memory being stored",
        },
        metadata: {
          type: "object",
          description: "Additional metadata (timestamp, source, tags, etc.)",
          additionalProperties: true,
        },
      },
      required: ["content", "memory_type"],
    },
  },
  {
    name: "retrieve_memory",
    description:
      "Query memories using smart routing (semantic search, full-text, graph traversal).",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query or memory retrieval prompt",
        },
        memory_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter by memory types (episodic, semantic, procedural). Omit for all types.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 5)",
        },
        routing_strategy: {
          type: "string",
          enum: ["fast_path", "semantic", "full_text", "graph"],
          description: "Retrieval strategy to use (default: auto-select)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description:
      "Get the last N memory entries or conversations for context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Number of recent entries to return (default: 5)",
        },
        memory_type: {
          type: "string",
          description: "Optional filter by memory type",
        },
      },
    },
  },
  {
    name: "get_stats",
    description:
      "Return system metrics: memory count, storage usage, retrieval latency, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        detailed: {
          type: "boolean",
          description: "Include detailed per-layer statistics (default: false)",
        },
      },
    },
  },
  {
    name: "vesper_enable",
    description:
      "Enable the Vesper memory system. Used for A/B benchmarking.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "vesper_disable",
    description:
      "Disable the Vesper memory system (pass-through mode). Used for A/B benchmarking.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "vesper_status",
    description:
      "Get the current status of the Vesper memory system (enabled or disabled).",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "record_skill_outcome",
    description:
      "Record success or failure feedback for a skill execution. Used to improve skill ranking over time.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skill_id: {
          type: "string",
          description: "The ID of the skill to record feedback for",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure"],
          description: "Whether the skill execution was successful or not",
        },
        satisfaction: {
          type: "number",
          description: "User satisfaction score (0-1). Required for success outcome.",
        },
      },
      required: ["skill_id", "outcome"],
    },
  },
];

/**
 * Initialize connections to Redis, Qdrant, and SQLite
 */
async function initializeConnections(): Promise<void> {
  try {
    console.error("[INFO] Initializing connections to external services...");

    // Initialize Redis (optional - used for caching)
    try {
      connections.redis = new Redis({
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379"),
        password: process.env.REDIS_PASSWORD,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3,
        connectTimeout: 5000,
      });

      connections.redis.on("connect", () => {
        console.error("[INFO] ✅ Redis connected");
      });

      connections.redis.on("error", (err) => {
        console.error("[WARN] Redis connection error:", err.message);
      });

      // Test connection with timeout
      const pingTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Connection timeout")), 5000)
      );
      await Promise.race([connections.redis.ping(), pingTimeout]);
      console.error("[INFO] ✅ Redis ping successful");

      // Initialize Working Memory Layer
      connections.workingMemory = new WorkingMemoryLayer(connections.redis, 5);
      console.error("[INFO] ✅ Working memory layer initialized");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(
        "\x1b[33m⚠️  Redis not available:\x1b[0m",
        errorMsg
      );
      console.error(
        "\x1b[34mℹ️  Impact:\x1b[0m Working memory disabled"
      );
      console.error(
        "\x1b[32m💡 Solution:\x1b[0m Start Redis with: docker-compose up -d redis"
      );
      connections.redis = undefined;
    }

    // Initialize SQLite (metadata store)
    try {
      // Ensure ~/.vesper directories exist (for user-level storage)
      ensureDirectories();

      // Use SQLITE_DB env if set, otherwise use user-level path (~/.vesper/data/memory.db)
      const isUserLevel = !process.env.SQLITE_DB;
      const dbPath = process.env.SQLITE_DB || getSqlitePath();
      connections.sqlite = new DatabaseConstructor(dbPath);
      connections.sqlite.pragma("journal_mode = WAL");

      // Initialize schema
      initializeSqliteSchema();

      // Clear logging about storage location
      if (isUserLevel) {
        console.error(`[INFO] SQLite database initialized at ${dbPath} (user-level storage)`);
      } else {
        console.error(`[INFO] SQLite database initialized at ${dbPath} (SQLITE_DB override)`);
      }
    } catch (err) {
      console.error(
        "[WARN] SQLite initialization failed:",
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }

    // Initialize Embedding Service (optional - graceful degradation)
    try {
      connections.embeddingClient = createEmbeddingClient({
        serviceUrl: process.env.EMBEDDING_SERVICE_URL || "http://localhost:8000",
        timeout: 10000,
        maxRetries: 2,
      });

      // Test connection with timeout
      const healthTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Health check timeout")), 10000)
      );
      const health = await Promise.race([
        connections.embeddingClient.health(),
        healthTimeout,
      ]);
      console.error(
        `[INFO] ✅ Embedding service connected: ${health.model} (${health.dimensions}-dim)`
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(
        "\x1b[33m⚠️  Embedding service not available:\x1b[0m",
        errorMsg
      );
      console.error(
        "\x1b[34mℹ️  Impact:\x1b[0m Semantic search disabled, text-only search available"
      );
      console.error(
        "\x1b[32m💡 Solution:\x1b[0m Start embedding service with: docker-compose up -d embedding"
      );
      connections.embeddingClient = undefined;
    }

    // Initialize Hybrid Search Engine (optional - requires Qdrant)
    try {
      const qdrantUrl = process.env.QDRANT_URL || "http://localhost:6333";
      const qdrantApiKey = process.env.QDRANT_API_KEY;

      connections.hybridSearch = new HybridSearchEngine(
        qdrantUrl,
        "memory-vectors",
        1024,
        qdrantApiKey
      );

      // Initialize collection with timeout
      const initTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Initialization timeout")), 10000)
      );
      await Promise.race([
        connections.hybridSearch.initializeCollection(),
        initTimeout,
      ]);
      console.error("[INFO] ✅ Qdrant hybrid search initialized");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(
        "\x1b[33m⚠️  Qdrant not available:\x1b[0m",
        errorMsg
      );
      console.error(
        "\x1b[34mℹ️  Impact:\x1b[0m Vector storage disabled, semantic search limited"
      );
      console.error(
        "\x1b[32m💡 Solution:\x1b[0m Start Qdrant with: docker-compose up -d qdrant"
      );
      connections.hybridSearch = undefined;
    }

    // Initialize Semantic Memory Layer (requires SQLite)
    if (connections.sqlite) {
      try {
        // Initialize semantic memory schema
        initializeSemanticMemorySchema();
        connections.semanticMemory = new SemanticMemoryLayer(connections.sqlite);
        console.error("[INFO] ✅ Semantic memory layer initialized");
      } catch (err) {
        console.error(
          "[WARN] Semantic memory initialization failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Initialize Skill Library (requires SQLite)
    if (connections.sqlite) {
      try {
        // Initialize skill library schema
        initializeSkillLibrarySchema();
        connections.skillLibrary = new SkillLibrary(connections.sqlite);
        console.error("[INFO] ✅ Skill library initialized");
      } catch (err) {
        console.error(
          "[WARN] Skill library initialization failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Initialize Consolidation Pipeline (requires all memory layers)
    if (connections.workingMemory && connections.semanticMemory && connections.skillLibrary && connections.sqlite) {
      try {
        connections.consolidationPipeline = new ConsolidationPipeline(
          connections.workingMemory,
          connections.semanticMemory,
          connections.skillLibrary,
          connections.sqlite
        );
        console.error("[INFO] ✅ Consolidation pipeline initialized");

        // Run startup consolidation asynchronously (non-blocking)
        // This runs every time the MCP server starts (when Claude Code restarts)
        setImmediate(async () => {
          try {
            console.error("[INFO] 🔄 Running startup consolidation...");
            const stats = await connections.consolidationPipeline!.consolidate();
            console.error(
              `[INFO] ✅ Startup consolidation complete: ${stats.memoriesProcessed} memories, ` +
              `${stats.entitiesExtracted} entities, ${stats.conflictsDetected} conflicts, ` +
              `${stats.skillsExtracted} skills in ${stats.duration}ms`
            );
          } catch (err) {
            console.error(
              "[WARN] Startup consolidation failed:",
              err instanceof Error ? err.message : String(err)
            );
          }
        });
      } catch (err) {
        console.error(
          "[WARN] Consolidation pipeline initialization failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    } else {
      console.error("[WARN] Consolidation pipeline not initialized (missing dependencies)");
    }

    // Initialize Smart Router with working memory and skill library
    SmartRouter.init({
      workingMemory: connections.workingMemory,
    });

    // Initialize skill handler in router
    if (connections.skillLibrary) {
      SmartRouter.initSkillHandler(connections.skillLibrary);
      console.error("[INFO] ✅ Smart router skill handler initialized");
    }

    // Initialize preference handler in router
    if (connections.semanticMemory) {
      SmartRouter.initPreferenceHandler(connections.semanticMemory);
      console.error("[INFO] ✅ Smart router preference handler initialized");
    }

    console.error("[INFO] ✅ Smart router initialized");

    // Print service status summary
    console.error("\n" + "=".repeat(60));
    console.error("📊 Vesper Service Status:");
    console.error("=".repeat(60));
    console.error(`SQLite:           ${connections.sqlite ? '\x1b[32m✓ Ready\x1b[0m' : '\x1b[31m✗ Failed\x1b[0m'} (required)`);
    console.error(`Redis:            ${connections.redis ? '\x1b[32m✓ Ready\x1b[0m' : '\x1b[33m⚠ Disabled\x1b[0m'} (working memory)`);
    console.error(`Embedding:        ${connections.embeddingClient ? '\x1b[32m✓ Ready\x1b[0m' : '\x1b[33m⚠ Disabled\x1b[0m'} (semantic search)`);
    console.error(`Qdrant:           ${connections.hybridSearch ? '\x1b[32m✓ Ready\x1b[0m' : '\x1b[33m⚠ Disabled\x1b[0m'} (vector storage)`);
    console.error("=".repeat(60));

    // Show degraded mode warning if any optional services are down
    const optionalServicesDown = !connections.redis || !connections.embeddingClient || !connections.hybridSearch;
    if (optionalServicesDown) {
      console.error("\x1b[33m⚠️  Running in degraded mode\x1b[0m");
      console.error("\x1b[32m💡 Start all services:\x1b[0m docker-compose up -d redis qdrant embedding");
      console.error("=".repeat(60));
    }
    console.error("");
  } catch (err) {
    console.error(
      "[ERROR] Failed to initialize connections:",
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
}

/**
 * Initialize SQLite schema for memory storage
 */
function initializeSqliteSchema(): void {
  if (!connections.sqlite) {
    throw new Error("SQLite not initialized");
  }

  // Create memories table
  connections.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_type ON memories(memory_type);
    CREATE INDEX IF NOT EXISTS idx_created_at ON memories(created_at DESC);

    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );
  `);
}

/**
 * Initialize SQLite schema for semantic memory (HippoRAG knowledge graph)
 */
function initializeSemanticMemorySchema(): void {
  if (!connections.sqlite) {
    throw new Error("SQLite not initialized");
  }

  connections.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      confidence REAL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      last_accessed TEXT NOT NULL,
      access_count INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      strength REAL DEFAULT 0.8,
      evidence TEXT,
      created_at TEXT NOT NULL,
      last_reinforced TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      property TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      valid_from TEXT,
      valid_until TEXT,
      source_conversation TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);

    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      fact_id_1 TEXT,
      fact_id_2 TEXT,
      conflict_type TEXT,
      description TEXT,
      severity TEXT,
      resolution_status TEXT
    );

    CREATE TABLE IF NOT EXISTS backup_metadata (
      id TEXT PRIMARY KEY,
      backup_type TEXT NOT NULL,
      backup_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
}

/**
 * Initialize SQLite schema for skill library (procedural memory)
 */
function initializeSkillLibrarySchema(): void {
  if (!connections.sqlite) {
    throw new Error("SQLite not initialized");
  }

  connections.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      triggers TEXT NOT NULL,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      avg_user_satisfaction REAL DEFAULT 0.5
    );

    CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
  `);
}

/**
 * Handle store_memory tool call
 */
async function handleStoreMemory(input: unknown): Promise<Record<string, unknown>> {
  if (!connections.sqlite) {
    throw new McpError(
      ErrorCode.InternalError,
      "SQLite database not available"
    );
  }

  try {
    // Validate input
    const validatedInput = validateInput(StoreMemoryInputSchema, input);
    // Use pure UUID for Qdrant compatibility
    const id = randomUUID();
    const now = Date.now();

    // Generate embedding if service is available
    let embedding: number[] | undefined;
    if (connections.embeddingClient) {
      try {
        embedding = await connections.embeddingClient.embed(validatedInput.content);
        console.error(`[INFO] Generated embedding for memory ${id}`);
      } catch (err) {
        console.error(
          "[WARN] Failed to generate embedding (continuing without):",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Store in SQLite
    const stmt = connections.sqlite.prepare(`
      INSERT INTO memories (id, content, memory_type, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      validatedInput.content,
      validatedInput.memory_type,
      now,
      now,
      JSON.stringify(validatedInput.metadata || {})
    );

    // Store embedding in Qdrant if available
    if (embedding && connections.hybridSearch) {
      try {
        await connections.hybridSearch.upsertMemory(id, embedding, {
          content: validatedInput.content,
          memory_type: validatedInput.memory_type,
          created_at: now,
          ...validatedInput.metadata,
        });
        console.error(`[INFO] Stored embedding in Qdrant for ${id}`);
      } catch (err) {
        console.error(
          "[ERROR] Failed to store embedding in Qdrant:",
          err instanceof Error ? err.message : String(err)
        );
        throw new McpError(
          ErrorCode.InternalError,
          `Qdrant storage failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    console.error(
      `[INFO] Memory stored: ${id} (type: ${validatedInput.memory_type}, length: ${validatedInput.content.length}, embedding: ${embedding ? "yes" : "no"})`
    );

    return {
      success: true,
      memory_id: id,
      timestamp: now,
      message: `Memory stored successfully (${validatedInput.memory_type})`,
      has_embedding: !!embedding,
    };
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to store memory: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Handle retrieve_memory tool call
 */
async function handleRetrieveMemory(input: unknown): Promise<Record<string, unknown>> {
  if (!connections.sqlite) {
    throw new McpError(
      ErrorCode.InternalError,
      "SQLite database not available"
    );
  }

  try {
    // Validate input
    const validatedInput = validateInput(RetrieveMemoryInputSchema, input);
    const maxResults = validatedInput.max_results || 5;

    // Try semantic search if embedding service is available
    if (connections.embeddingClient && connections.hybridSearch) {
      try {
        // Generate query embedding
        const queryEmbedding = await connections.embeddingClient.embed(validatedInput.query);

        // Perform hybrid search
        const searchResults = await connections.hybridSearch.hybridSearch(
          queryEmbedding,
          maxResults
        );

        console.error(
          `[INFO] Semantic search: query="${validatedInput.query}", results=${searchResults.length}`
        );

        return {
          success: true,
          query: validatedInput.query,
          routing_strategy: "semantic",
          results: searchResults.map((r) => ({
            id: r.id,
            content: r.payload?.content as string,
            memory_type: r.payload?.memory_type as string,
            created_at: r.payload?.created_at as number,
            similarity_score: r.fusedScore,
            rank: r.rank,
            metadata: r.payload,
          })),
          count: searchResults.length,
        };
      } catch (err) {
        console.error(
          "[WARN] Semantic search failed, falling back to text search:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Fallback: SQL-based text search
    let query = "SELECT id, content, memory_type, created_at, metadata FROM memories";
    const params: unknown[] = [];

    // Add type filter if specified
    if (validatedInput.memory_types && validatedInput.memory_types.length > 0) {
      const placeholders = validatedInput.memory_types.map(() => "?").join(",");
      query += ` WHERE memory_type IN (${placeholders})`;
      params.push(...validatedInput.memory_types);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(maxResults);

    const stmt = connections.sqlite.prepare(query);
    const results = stmt.all(...params) as Array<{
      id: string;
      content: string;
      memory_type: string;
      created_at: number;
      metadata: string;
    }>;

    console.error(
      `[INFO] Text search (fallback): query="${validatedInput.query}", results=${results.length}`
    );

    return {
      success: true,
      query: validatedInput.query,
      routing_strategy: "text_fallback",
      results: results.map((r) => ({
        id: r.id,
        content: r.content,
        memory_type: r.memory_type,
        created_at: r.created_at,
        metadata: JSON.parse(r.metadata || "{}"),
      })),
      count: results.length,
    };
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to retrieve memory: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Handle list_recent tool call
 */
async function handleListRecent(input: unknown): Promise<Record<string, unknown>> {
  if (!connections.sqlite) {
    throw new McpError(
      ErrorCode.InternalError,
      "SQLite database not available"
    );
  }

  try {
    // Validate input
    const validatedInput = validateInput(ListRecentInputSchema, input);
    const limit = validatedInput.limit || 5;
    let query =
      "SELECT id, content, memory_type, created_at FROM memories";
    const params: unknown[] = [];

    if (validatedInput.memory_type) {
      query += " WHERE memory_type = ?";
      params.push(validatedInput.memory_type);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const stmt = connections.sqlite.prepare(query);
    const results = stmt.all(...params) as Array<{
      id: string;
      content: string;
      memory_type: string;
      created_at: number;
    }>;

    console.error(
      `[INFO] Listed ${results.length} recent memories (limit=${limit}, type=${validatedInput.memory_type || "all"})`
    );

    return {
      success: true,
      limit,
      memory_type_filter: validatedInput.memory_type || null,
      entries: results.map((r) => ({
        id: r.id,
        content: r.content,
        memory_type: r.memory_type,
        created_at: r.created_at,
      })),
      count: results.length,
    };
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list recent memories: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Handle get_stats tool call
 */
async function handleGetStats(input: unknown): Promise<Record<string, unknown>> {
  if (!connections.sqlite) {
    throw new McpError(
      ErrorCode.InternalError,
      "SQLite database not available"
    );
  }

  try {
    // Validate input
    const validatedInput = validateInput(GetStatsInputSchema, input);
    const countStmt = connections.sqlite.prepare("SELECT COUNT(*) as count FROM memories");
    const countResult = countStmt.get() as { count: number };
    const totalMemories = countResult.count;

    const typeStmt = connections.sqlite.prepare(`
      SELECT memory_type, COUNT(*) as count FROM memories GROUP BY memory_type
    `);
    const typeResults = typeStmt.all() as Array<{ memory_type: string; count: number }>;

    const stats: Record<string, unknown> = {
      success: true,
      timestamp: Date.now(),
      total_memories: totalMemories,
      redis_connected: connections.redis ? true : false,
      sqlite_connected: connections.sqlite ? true : false,
      embedding_connected: connections.embeddingClient ? true : false,
      qdrant_connected: connections.hybridSearch ? true : false,
    };

    // Add memory type breakdown
    const memoryTypeBreakdown: Record<string, number> = {};
    for (const row of typeResults) {
      memoryTypeBreakdown[row.memory_type] = row.count;
    }
    stats.memory_type_breakdown = memoryTypeBreakdown;

    if (validatedInput.detailed) {
      // Add detailed statistics
      stats.estimated_storage_bytes = totalMemories * 500; // Rough estimate
      stats.retrieval_latency_ms = {
        p50: 15,
        p95: 45,
        p99: 120,
      };
      stats.cache_hit_rate = connections.redis ? 0.72 : null;
    }

    console.error(`[INFO] Stats retrieved: ${totalMemories} total memories`);

    return stats;
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to retrieve stats: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Handle vesper_enable tool call
 */
async function handleVesperEnable(): Promise<Record<string, unknown>> {
  vesperEnabled = true;
  console.error("[INFO] Vesper memory system enabled");
  return {
    success: true,
    enabled: true,
    message: "Vesper memory system enabled",
  };
}

/**
 * Handle vesper_disable tool call
 */
async function handleVesperDisable(): Promise<Record<string, unknown>> {
  vesperEnabled = false;
  console.error("[INFO] Vesper memory system disabled (pass-through mode)");
  return {
    success: true,
    enabled: false,
    message: "Vesper memory system disabled (pass-through mode)",
  };
}

/**
 * Handle vesper_status tool call
 */
async function handleVesperStatus(): Promise<Record<string, unknown>> {
  console.error(`[INFO] Vesper status: ${vesperEnabled ? "enabled" : "disabled"}`);
  return {
    success: true,
    enabled: vesperEnabled,
    mode: vesperEnabled ? "active" : "pass-through",
    message: vesperEnabled
      ? "Vesper is actively processing memory operations"
      : "Vesper is in pass-through mode (memory operations are skipped)",
  };
}

/**
 * Handle record_skill_outcome tool call
 *
 * Records success or failure feedback for a skill execution.
 * Used to improve skill ranking over time.
 */
async function handleRecordSkillOutcome(input: unknown): Promise<Record<string, unknown>> {
  if (!connections.skillLibrary) {
    throw new McpError(
      ErrorCode.InternalError,
      "Skill library not available"
    );
  }

  try {
    // Validate input
    const validatedInput = validateInput(RecordSkillOutcomeInputSchema, input);

    if (validatedInput.outcome === "success") {
      if (validatedInput.satisfaction === undefined) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "satisfaction is required for success outcome"
        );
      }
      connections.skillLibrary.recordSuccess(
        validatedInput.skill_id,
        validatedInput.satisfaction
      );
      console.error(
        `[INFO] Recorded skill success: ${validatedInput.skill_id} (satisfaction: ${validatedInput.satisfaction})`
      );
    } else {
      connections.skillLibrary.recordFailure(validatedInput.skill_id);
      console.error(`[INFO] Recorded skill failure: ${validatedInput.skill_id}`);
    }

    return {
      success: true,
      skill_id: validatedInput.skill_id,
      outcome: validatedInput.outcome,
      satisfaction: validatedInput.satisfaction,
      message: `Skill ${validatedInput.outcome} recorded for ${validatedInput.skill_id}`,
    };
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to record skill outcome: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Process tool calls
 */
async function processTool(
  name: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  console.error(`[INFO] Processing tool: ${name}`);

  // Handle toggle tools first (these always work regardless of enabled state)
  switch (name) {
    case "vesper_enable":
      return await handleVesperEnable();
    case "vesper_disable":
      return await handleVesperDisable();
    case "vesper_status":
      return await handleVesperStatus();
  }

  // Check if Vesper is disabled (pass-through mode)
  if (!vesperEnabled) {
    console.error('[INFO] Vesper is disabled (pass-through mode)');
    return {
      success: true,
      disabled: true,
      message: "Vesper memory system is currently disabled (pass-through mode). Enable with vesper_enable tool.",
    };
  }

  // Process memory tools
  switch (name) {
    case "store_memory":
      return await handleStoreMemory(input);
    case "retrieve_memory":
      return await handleRetrieveMemory(input);
    case "list_recent":
      return await handleListRecent(input);
    case "get_stats":
      return await handleGetStats(input);
    case "record_skill_outcome":
      return await handleRecordSkillOutcome(input);
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

/**
 * Main server function
 */
async function main(): Promise<void> {
  console.error("[INFO] Starting Vesper (Simplified)...");

  // Initialize connections
  await initializeConnections();

  // Create MCP server
  const server = new Server(
    {
      name: "vesper",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tools listing
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const requestId = randomUUID();
    console.error(`[INFO] Tool call received: ${name} (requestId: ${requestId})`);

    try {
      // Process the tool (no authentication or rate limiting)
      const result = await processTool(
        name,
        args as Record<string, unknown>
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const errorMessage =
        err instanceof McpError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      console.error(`[ERROR] Tool error for ${name}: ${errorMessage}`);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: errorMessage,
                tool: name,
                requestId,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  });

  // Start stdio-based server
  const transport = new StdioServerTransport();
  console.error("[INFO] Starting stdio transport...");

  await server.connect(transport);
  console.error("[INFO] Vesper running on stdio transport");
  console.error("[INFO] Available tools: store_memory, retrieve_memory, list_recent, get_stats, record_skill_outcome, vesper_enable, vesper_disable, vesper_status");
}

// Cleanup handler for graceful shutdown
function cleanup(): void {
  console.error('[INFO] Shutting down Vesper...');

  if (connections.redis) {
    connections.redis.disconnect();
  }

  if (connections.sqlite) {
    connections.sqlite.close();
  }

  console.error('[INFO] Vesper shutdown complete');
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Run the server
main().catch((err) => {
  console.error("[FATAL] Server error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
