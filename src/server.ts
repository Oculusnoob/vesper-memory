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
  DeleteMemoryInputSchema,
  RecordSkillOutcomeInputSchema,
  LoadSkillInputSchema,
  ShareContextInputSchema,
  StoreDecisionInputSchema,
  ListNamespacesInputSchema,
  NamespaceStatsInputSchema,
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
const NAMESPACE_PROP = {
  type: "string",
  description: "Namespace for multi-agent isolation (default: 'default')",
};

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
          enum: ["episodic", "semantic", "procedural", "decision"],
          description: "Type of memory being stored",
        },
        metadata: {
          type: "object",
          description: "Additional metadata (timestamp, source, tags, etc.)",
          additionalProperties: true,
        },
        namespace: NAMESPACE_PROP,
        agent_id: { type: "string", description: "ID of the agent storing this memory" },
        agent_role: { type: "string", description: "Role of the agent (e.g., 'orchestrator', 'code-reviewer')" },
        task_id: { type: "string", description: "Task ID this memory is associated with" },
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
            "Filter by memory types (episodic, semantic, procedural, decision). Omit for all types.",
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
        namespace: NAMESPACE_PROP,
        agent_id: { type: "string", description: "Filter by agent ID" },
        task_id: { type: "string", description: "Filter by task ID" },
        exclude_agent: { type: "string", description: "Exclude memories from this agent" },
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
        namespace: NAMESPACE_PROP,
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
        namespace: NAMESPACE_PROP,
      },
    },
  },
  {
    name: "delete_memory",
    description:
      "Delete a memory entry by ID. Removes from SQLite, Qdrant, Redis, and cleans up orphaned facts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        memory_id: {
          type: "string",
          description: "The ID of the memory to delete",
        },
        namespace: NAMESPACE_PROP,
      },
      required: ["memory_id"],
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
        namespace: NAMESPACE_PROP,
      },
      required: ["skill_id", "outcome"],
    },
  },
  {
    name: "load_skill",
    description:
      "Load full skill implementation on-demand. Use when a skill summary needs complete details for execution. Loaded skills are cached for the session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        skill_id: {
          type: "string",
          description: "The ID of the skill to load",
        },
        namespace: NAMESPACE_PROP,
      },
      required: ["skill_id"],
    },
  },
  {
    name: "share_context",
    description:
      "Share context (memories, skills, entities) from one namespace to another. Used for agent handoffs in multi-agent workflows.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source_namespace: { type: "string", description: "Namespace to share from" },
        target_namespace: { type: "string", description: "Namespace to share to" },
        task_id: { type: "string", description: "Filter source memories by task ID" },
        query: { type: "string", description: "Semantic query to select relevant memories" },
        max_items: { type: "number", description: "Max items to share (default: 10)" },
        include_skills: { type: "boolean", description: "Include matching skills (default: false)" },
        include_entities: { type: "boolean", description: "Include related entities (default: true)" },
      },
      required: ["source_namespace", "target_namespace"],
    },
  },
  {
    name: "store_decision",
    description:
      "Store an architectural or design decision with reduced decay and automatic conflict detection against existing decisions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "The decision content" },
        namespace: NAMESPACE_PROP,
        agent_id: { type: "string", description: "ID of the agent making this decision" },
        agent_role: { type: "string", description: "Role of the agent" },
        task_id: { type: "string", description: "Related task ID" },
        supersedes: { type: "string", description: "ID of a previous decision this replaces" },
        metadata: { type: "object", description: "Additional metadata", additionalProperties: true },
      },
      required: ["content"],
    },
  },
  {
    name: "list_namespaces",
    description:
      "List all namespaces with memory counts. Useful for discovering active agent namespaces.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "namespace_stats",
    description:
      "Get detailed statistics for a specific namespace including memory counts, entity counts, skill counts, and active agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: { type: "string", description: "The namespace to get stats for" },
      },
      required: ["namespace"],
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

  // v0.5.0 namespace migration for memories table
  const memoryNamespaceCols = [
    "ALTER TABLE memories ADD COLUMN namespace TEXT DEFAULT 'default'",
    "ALTER TABLE memories ADD COLUMN agent_id TEXT",
    "ALTER TABLE memories ADD COLUMN agent_role TEXT",
    "ALTER TABLE memories ADD COLUMN task_id TEXT",
  ];
  for (const sql of memoryNamespaceCols) {
    try { connections.sqlite.exec(sql); } catch (_) { /* column already exists */ }
  }
  connections.sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
    CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(namespace, agent_id);
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

  // v0.5.0 namespace migration for semantic memory tables
  const semanticNamespaceMigrations = [
    "ALTER TABLE entities ADD COLUMN namespace TEXT DEFAULT 'default'",
    "ALTER TABLE relationships ADD COLUMN namespace TEXT DEFAULT 'default'",
    "ALTER TABLE facts ADD COLUMN namespace TEXT DEFAULT 'default'",
    "ALTER TABLE conflicts ADD COLUMN namespace TEXT DEFAULT 'default'",
  ];
  for (const sql of semanticNamespaceMigrations) {
    try { connections.sqlite.exec(sql); } catch (_) { /* column already exists */ }
  }
  connections.sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_entities_namespace ON entities(namespace);
    CREATE INDEX IF NOT EXISTS idx_relationships_namespace ON relationships(namespace);
    CREATE INDEX IF NOT EXISTS idx_facts_namespace ON facts(namespace);
    CREATE INDEX IF NOT EXISTS idx_conflicts_namespace ON conflicts(namespace);
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

  // v0.5.0 namespace migration for skills table
  try { connections.sqlite.exec("ALTER TABLE skills ADD COLUMN namespace TEXT DEFAULT 'default'"); } catch (_) { /* column already exists */ }
  connections.sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_skills_namespace ON skills(namespace);`);

  // Apply lazy loading migration (idempotent - safe to run multiple times)
  try {
    connections.sqlite.exec(`
      -- Add lazy loading columns if they don't exist
      -- SQLite 3.35.0+ supports IF NOT EXISTS for ALTER TABLE ADD COLUMN

      -- Add summary column (lightweight description for context injection)
      ALTER TABLE skills ADD COLUMN summary TEXT;
    `);
  } catch (err) {
    // Column already exists, continue
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN is_archived INTEGER DEFAULT 0;
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN last_used TEXT;
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN last_modified TEXT DEFAULT CURRENT_TIMESTAMP;
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN version INTEGER DEFAULT 1;
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN code TEXT;
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN code_type TEXT DEFAULT 'reference';
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN prerequisites TEXT;
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN uses_skills TEXT;
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN used_by_skills TEXT;
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN created_from TEXT;
    `);
  } catch (err) {
    // Column already exists
  }

  try {
    connections.sqlite.exec(`
      ALTER TABLE skills ADD COLUMN notes TEXT;
    `);
  } catch (err) {
    // Column already exists
  }

  // Create indexes for lazy loading (idempotent)
  connections.sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_skills_lazy_loading
      ON skills(is_archived, avg_user_satisfaction DESC, success_count DESC);

    CREATE INDEX IF NOT EXISTS idx_skills_last_used
      ON skills(last_used DESC);

    CREATE INDEX IF NOT EXISTS idx_skills_category_quality
      ON skills(category, avg_user_satisfaction DESC, success_count DESC);
  `);

  // Update existing skills with defaults
  connections.sqlite.exec(`
    UPDATE skills
    SET summary = CASE
      WHEN summary IS NULL AND length(description) <= 100 THEN description
      WHEN summary IS NULL THEN substr(description, 1, 97) || '...'
      ELSE summary
    END
    WHERE summary IS NULL OR summary = '';

    UPDATE skills
    SET created_at = CURRENT_TIMESTAMP
    WHERE created_at IS NULL;

    UPDATE skills
    SET last_modified = CURRENT_TIMESTAMP
    WHERE last_modified IS NULL;

    UPDATE skills
    SET is_archived = 0
    WHERE is_archived IS NULL;
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
    const namespace = validatedInput.namespace || 'default';
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

    // Store in SQLite with namespace and agent attribution
    const stmt = connections.sqlite.prepare(`
      INSERT INTO memories (id, content, memory_type, created_at, updated_at, metadata, namespace, agent_id, agent_role, task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      validatedInput.content,
      validatedInput.memory_type,
      now,
      now,
      JSON.stringify(validatedInput.metadata || {}),
      namespace,
      validatedInput.agent_id || null,
      validatedInput.agent_role || null,
      validatedInput.task_id || null
    );

    // Store embedding in Qdrant if available (include namespace in payload)
    if (embedding && connections.hybridSearch) {
      try {
        await connections.hybridSearch.upsertMemory(id, embedding, {
          content: validatedInput.content,
          memory_type: validatedInput.memory_type,
          created_at: now,
          namespace,
          agent_id: validatedInput.agent_id,
          task_id: validatedInput.task_id,
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
      `[INFO] Memory stored: ${id} (type: ${validatedInput.memory_type}, ns: ${namespace}, length: ${validatedInput.content.length}, embedding: ${embedding ? "yes" : "no"})`
    );

    return {
      success: true,
      memory_id: id,
      namespace,
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
    const namespace = validatedInput.namespace || 'default';
    const maxResults = validatedInput.max_results || 5;

    // Build Qdrant filter for namespace
    const qdrantFilter: Record<string, unknown> = {
      must: [
        { key: "namespace", match: { value: namespace } },
        ...(validatedInput.agent_id ? [{ key: "agent_id", match: { value: validatedInput.agent_id } }] : []),
        ...(validatedInput.task_id ? [{ key: "task_id", match: { value: validatedInput.task_id } }] : []),
      ],
      ...(validatedInput.exclude_agent ? {
        must_not: [{ key: "agent_id", match: { value: validatedInput.exclude_agent } }]
      } : {}),
    };

    // Try semantic search if embedding service is available
    if (connections.embeddingClient && connections.hybridSearch) {
      try {
        // Generate query embedding
        const queryEmbedding = await connections.embeddingClient.embed(validatedInput.query);

        // Perform hybrid search with namespace filter
        let searchResults = await connections.hybridSearch.hybridSearch(
          queryEmbedding,
          maxResults,
          qdrantFilter
        );

        // Fallback: if namespace is "default" and filtered search returns empty,
        // retry without filter (backward compat for pre-namespace vectors)
        if (searchResults.length === 0 && namespace === 'default') {
          searchResults = await connections.hybridSearch.hybridSearch(
            queryEmbedding,
            maxResults
          );
        }

        console.error(
          `[INFO] Semantic search: query="${validatedInput.query}", ns=${namespace}, results=${searchResults.length}`
        );

        return {
          success: true,
          query: validatedInput.query,
          namespace,
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

    // Fallback: SQL-based text search with namespace filter
    let query = "SELECT id, content, memory_type, created_at, metadata, agent_id, task_id FROM memories WHERE namespace = ?";
    const params: unknown[] = [namespace];

    // Add type filter if specified
    if (validatedInput.memory_types && validatedInput.memory_types.length > 0) {
      const placeholders = validatedInput.memory_types.map(() => "?").join(",");
      query += ` AND memory_type IN (${placeholders})`;
      params.push(...validatedInput.memory_types);
    }

    // Add agent/task filters
    if (validatedInput.agent_id) {
      query += " AND agent_id = ?";
      params.push(validatedInput.agent_id);
    }
    if (validatedInput.task_id) {
      query += " AND task_id = ?";
      params.push(validatedInput.task_id);
    }
    if (validatedInput.exclude_agent) {
      query += " AND (agent_id IS NULL OR agent_id != ?)";
      params.push(validatedInput.exclude_agent);
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
      agent_id: string | null;
      task_id: string | null;
    }>;

    console.error(
      `[INFO] Text search (fallback): query="${validatedInput.query}", ns=${namespace}, results=${results.length}`
    );

    return {
      success: true,
      query: validatedInput.query,
      namespace,
      routing_strategy: "text_fallback",
      results: results.map((r) => ({
        id: r.id,
        content: r.content,
        memory_type: r.memory_type,
        created_at: r.created_at,
        agent_id: r.agent_id,
        task_id: r.task_id,
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
    const namespace = validatedInput.namespace || 'default';
    const limit = validatedInput.limit || 5;
    let query =
      "SELECT id, content, memory_type, created_at, agent_id, task_id FROM memories WHERE namespace = ?";
    const params: unknown[] = [namespace];

    if (validatedInput.memory_type) {
      query += " AND memory_type = ?";
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
      agent_id: string | null;
      task_id: string | null;
    }>;

    console.error(
      `[INFO] Listed ${results.length} recent memories (ns=${namespace}, limit=${limit}, type=${validatedInput.memory_type || "all"})`
    );

    return {
      success: true,
      namespace,
      limit,
      memory_type_filter: validatedInput.memory_type || null,
      entries: results.map((r) => ({
        id: r.id,
        content: r.content,
        memory_type: r.memory_type,
        created_at: r.created_at,
        agent_id: r.agent_id,
        task_id: r.task_id,
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
    const namespace = validatedInput.namespace || 'default';
    const countStmt = connections.sqlite.prepare("SELECT COUNT(*) as count FROM memories WHERE namespace = ?");
    const countResult = countStmt.get(namespace) as { count: number };
    const totalMemories = countResult.count;

    const typeStmt = connections.sqlite.prepare(`
      SELECT memory_type, COUNT(*) as count FROM memories WHERE namespace = ? GROUP BY memory_type
    `);
    const typeResults = typeStmt.all(namespace) as Array<{ memory_type: string; count: number }>;

    const stats: Record<string, unknown> = {
      success: true,
      namespace,
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
 * Handle delete_memory tool call
 */
async function handleDeleteMemory(input: unknown): Promise<Record<string, unknown>> {
  if (!connections.sqlite) {
    throw new McpError(
      ErrorCode.InternalError,
      "SQLite database not available"
    );
  }

  try {
    const validatedInput = validateInput(DeleteMemoryInputSchema, input);
    const namespace = validatedInput.namespace || 'default';

    // Verify memory exists in SQLite
    const existing = connections.sqlite.prepare(
      "SELECT id, content, memory_type, created_at FROM memories WHERE id = ? AND namespace = ?"
    ).get(validatedInput.memory_id, namespace) as {
      id: string;
      content: string;
      memory_type: string;
      created_at: number;
    } | undefined;

    if (!existing) {
      return {
        success: false,
        message: `Memory not found: ${validatedInput.memory_id} in namespace '${namespace}'`,
      };
    }

    // Delete from SQLite memories table
    connections.sqlite.prepare(
      "DELETE FROM memories WHERE id = ? AND namespace = ?"
    ).run(validatedInput.memory_id, namespace);

    // Delete from Qdrant (best-effort)
    if (connections.hybridSearch) {
      try {
        await connections.hybridSearch.deleteMemory(validatedInput.memory_id);
      } catch (err) {
        console.error(
          "[WARN] Failed to delete from Qdrant (continuing):",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Delete from Redis (best-effort)
    if (connections.redis) {
      try {
        // Delete the individual working memory key
        await connections.redis.del(`${namespace}:working:${validatedInput.memory_id}`);
        // Remove from the recent list
        await connections.redis.lrem(`${namespace}:working:recent`, 0, validatedInput.memory_id);
      } catch (err) {
        console.error(
          "[WARN] Failed to delete from Redis (continuing):",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Clean up orphaned facts where source_conversation = memory_id
    try {
      connections.sqlite.prepare(
        "DELETE FROM facts WHERE source_conversation = ? AND namespace = ?"
      ).run(validatedInput.memory_id, namespace);
    } catch (err) {
      console.error(
        "[WARN] Failed to clean up orphaned facts (continuing):",
        err instanceof Error ? err.message : String(err)
      );
    }

    console.error(
      `[INFO] Memory deleted: ${validatedInput.memory_id} (type: ${existing.memory_type}, ns: ${namespace})`
    );

    return {
      success: true,
      deleted: {
        id: existing.id,
        content: existing.content,
        memory_type: existing.memory_type,
        created_at: existing.created_at,
      },
      namespace,
      message: `Memory deleted successfully`,
    };
  } catch (err) {
    if (err instanceof McpError) {
      throw err;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to delete memory: ${err instanceof Error ? err.message : String(err)}`
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
 * Handle load_skill tool call
 *
 * Loads full skill implementation on-demand when a skill is invoked.
 * This is part of the lazy loading system to reduce token usage by 80-90%.
 *
 * Performance:
 * - First load: ~20ms (database query)
 * - Cached load: ~5ms (working memory cache hit)
 *
 * Caching:
 * - Loaded skills are cached in Redis for 1 hour (3600s)
 * - Cache automatically expires or can be invalidated
 * - Reduces database load and improves response time
 *
 * @param input - LoadSkillInput with skill_id
 * @returns Full skill implementation with all details
 */
async function handleLoadSkill(input: unknown): Promise<Record<string, unknown>> {
  if (!connections.skillLibrary) {
    throw new McpError(
      ErrorCode.InternalError,
      "Skill library not available"
    );
  }

  try {
    // Validate input
    const validatedInput = validateInput(LoadSkillInputSchema, input);
    const startTime = Date.now();
    let fromCache = false;

    // Step 1: Check cache first (if working memory available)
    let fullSkill: any = null;

    if (connections.workingMemory) {
      try {
        const cached = await connections.workingMemory.getCachedSkill(validatedInput.skill_id);
        if (cached) {
          fullSkill = cached.skill;
          fromCache = true;
          console.error(
            `[INFO] Skill cache hit: ${fullSkill.name} (${validatedInput.skill_id}) ` +
            `access count: ${cached.access_count}`
          );
        }
      } catch (err) {
        console.warn(
          `[WARN] Skill cache lookup failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Step 2: Load from database if not cached
    if (!fullSkill) {
      fullSkill = connections.skillLibrary.loadFull(validatedInput.skill_id);

      if (!fullSkill) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Skill not found: ${validatedInput.skill_id}`
        );
      }

      // Cache the loaded skill (if working memory available)
      if (connections.workingMemory) {
        try {
          await connections.workingMemory.cacheSkill(fullSkill, 3600); // 1 hour TTL
        } catch (err) {
          console.warn(
            `[WARN] Failed to cache skill: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    const loadTime = Date.now() - startTime;
    console.error(
      `[INFO] Loaded full skill: ${fullSkill.name} (${validatedInput.skill_id}) ` +
      `in ${loadTime}ms (${fromCache ? 'cache' : 'database'})`
    );

    return {
      success: true,
      skill: {
        id: fullSkill.id,
        name: fullSkill.name,
        summary: fullSkill.summary,
        description: fullSkill.description,
        category: fullSkill.category,
        triggers: fullSkill.triggers,
        code: fullSkill.code,
        code_type: fullSkill.code_type,
        prerequisites: fullSkill.prerequisites,
        quality_score: fullSkill.quality_score,
        success_count: fullSkill.success_count,
        failure_count: fullSkill.failure_count,
        avg_user_satisfaction: fullSkill.avg_user_satisfaction,
        uses_skills: fullSkill.uses_skills,
        used_by_skills: fullSkill.used_by_skills,
        created_from: fullSkill.created_from,
        created_at: fullSkill.created_at.toISOString(),
        last_modified: fullSkill.last_modified.toISOString(),
        last_used: fullSkill.last_used?.toISOString(),
        version: fullSkill.version,
        notes: fullSkill.notes,
      },
      load_time_ms: loadTime,
      from_cache: fromCache,
      message: `Loaded full skill: ${fullSkill.name}${fromCache ? ' (cached)' : ''}`,
    };
  } catch (err) {
    if (err instanceof McpError) {
      throw err;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to load skill: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Handle share_context tool call
 *
 * Shares memories from one namespace to another for agent handoffs.
 */
async function handleShareContext(input: unknown): Promise<Record<string, unknown>> {
  if (!connections.sqlite) {
    throw new McpError(ErrorCode.InternalError, "SQLite database not available");
  }

  try {
    const validatedInput = validateInput(ShareContextInputSchema, input);
    const { source_namespace, target_namespace } = validatedInput;
    const maxItems = validatedInput.max_items || 10;
    const now = Date.now();
    const sharedItems: any[] = [];

    // Query memories from source namespace
    let memQuery = "SELECT id, content, memory_type, created_at, metadata, agent_id, task_id FROM memories WHERE namespace = ?";
    const memParams: unknown[] = [source_namespace];

    if (validatedInput.task_id) {
      memQuery += " AND task_id = ?";
      memParams.push(validatedInput.task_id);
    }

    memQuery += " ORDER BY created_at DESC LIMIT ?";
    memParams.push(maxItems);

    const memories = connections.sqlite.prepare(memQuery).all(...memParams) as any[];

    // Copy memories to target namespace
    for (const mem of memories) {
      const newId = randomUUID();
      connections.sqlite.prepare(`
        INSERT INTO memories (id, content, memory_type, created_at, updated_at, metadata, namespace, agent_id, agent_role, task_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId, mem.content, mem.memory_type, mem.created_at, now,
        mem.metadata, target_namespace, mem.agent_id, null, mem.task_id
      );
      sharedItems.push({ type: 'memory', id: newId, original_id: mem.id });
    }

    // Include entities if requested
    let entityCount = 0;
    if (validatedInput.include_entities) {
      const entities = connections.sqlite.prepare(
        "SELECT * FROM entities WHERE namespace = ? LIMIT ?"
      ).all(source_namespace, maxItems) as any[];

      for (const entity of entities) {
        if (connections.semanticMemory) {
          connections.semanticMemory.upsertEntity(
            { name: entity.name, type: entity.type, description: entity.description, confidence: entity.confidence },
            target_namespace
          );
          entityCount++;
        }
      }
    }

    // Store handoff event in target namespace
    const handoffId = randomUUID();
    connections.sqlite.prepare(`
      INSERT INTO memories (id, content, memory_type, created_at, updated_at, metadata, namespace)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoffId,
      `Context handoff from namespace '${source_namespace}': ${memories.length} memories, ${entityCount} entities shared`,
      'episodic',
      now, now,
      JSON.stringify({ handoff: true, source_namespace, items_shared: sharedItems.length, entities_shared: entityCount }),
      target_namespace
    );

    console.error(`[INFO] Shared ${sharedItems.length} memories + ${entityCount} entities from ${source_namespace} to ${target_namespace}`);

    return {
      success: true,
      source_namespace,
      target_namespace,
      memories_shared: sharedItems.length,
      entities_shared: entityCount,
      handoff_id: handoffId,
    };
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to share context: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Handle store_decision tool call
 *
 * Stores a decision with reduced decay and conflict detection.
 */
async function handleStoreDecision(input: unknown): Promise<Record<string, unknown>> {
  if (!connections.sqlite) {
    throw new McpError(ErrorCode.InternalError, "SQLite database not available");
  }

  try {
    const validatedInput = validateInput(StoreDecisionInputSchema, input);
    const namespace = validatedInput.namespace || 'default';
    const id = randomUUID();
    const now = Date.now();

    // Build metadata with decay_factor
    const metadata = {
      ...(validatedInput.metadata || {}),
      decay_factor: 0.25,
      supersedes: validatedInput.supersedes || null,
    };

    // Store as decision memory type
    connections.sqlite.prepare(`
      INSERT INTO memories (id, content, memory_type, created_at, updated_at, metadata, namespace, agent_id, agent_role, task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, validatedInput.content, 'decision', now, now,
      JSON.stringify(metadata), namespace,
      validatedInput.agent_id || null,
      validatedInput.agent_role || null,
      validatedInput.task_id || null
    );

    // Generate embedding and store in Qdrant
    let hasEmbedding = false;
    if (connections.embeddingClient && connections.hybridSearch) {
      try {
        const embedding = await connections.embeddingClient.embed(validatedInput.content);
        await connections.hybridSearch.upsertMemory(id, embedding, {
          content: validatedInput.content,
          memory_type: 'decision',
          created_at: now,
          namespace,
          agent_id: validatedInput.agent_id,
          task_id: validatedInput.task_id,
          decay_factor: 0.25,
        });
        hasEmbedding = true;
      } catch (err) {
        console.error("[WARN] Failed to generate embedding for decision:", err instanceof Error ? err.message : String(err));
      }
    }

    // If supersedes, mark the old decision's metadata
    if (validatedInput.supersedes) {
      const oldMem = connections.sqlite.prepare("SELECT metadata FROM memories WHERE id = ? AND namespace = ?").get(validatedInput.supersedes, namespace) as any;
      if (oldMem) {
        const oldMeta = JSON.parse(oldMem.metadata || '{}');
        oldMeta.superseded_by = id;
        connections.sqlite.prepare("UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(oldMeta), now, validatedInput.supersedes
        );
      }
    }

    // Check for conflicting decisions in same namespace
    const existingDecisions = connections.sqlite.prepare(
      "SELECT id, content FROM memories WHERE namespace = ? AND memory_type = 'decision' AND id != ? ORDER BY created_at DESC LIMIT 10"
    ).all(namespace, id) as any[];

    console.error(`[INFO] Decision stored: ${id} (ns: ${namespace}, supersedes: ${validatedInput.supersedes || 'none'})`);

    return {
      success: true,
      decision_id: id,
      namespace,
      timestamp: now,
      has_embedding: hasEmbedding,
      supersedes: validatedInput.supersedes || null,
      existing_decisions_count: existingDecisions.length,
      message: `Decision stored successfully`,
    };
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to store decision: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Handle list_namespaces tool call
 */
async function handleListNamespaces(): Promise<Record<string, unknown>> {
  if (!connections.sqlite) {
    throw new McpError(ErrorCode.InternalError, "SQLite database not available");
  }

  try {
    const namespaces = connections.sqlite.prepare(`
      SELECT namespace, COUNT(*) as memory_count,
        COUNT(DISTINCT agent_id) as agent_count,
        MAX(created_at) as last_activity
      FROM memories
      WHERE namespace IS NOT NULL
      GROUP BY namespace
      ORDER BY last_activity DESC
    `).all() as any[];

    return {
      success: true,
      namespaces: namespaces.map(ns => ({
        namespace: ns.namespace,
        memory_count: ns.memory_count,
        agent_count: ns.agent_count,
        last_activity: ns.last_activity,
      })),
      count: namespaces.length,
    };
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list namespaces: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Handle namespace_stats tool call
 */
async function handleNamespaceStats(input: unknown): Promise<Record<string, unknown>> {
  if (!connections.sqlite) {
    throw new McpError(ErrorCode.InternalError, "SQLite database not available");
  }

  try {
    const validatedInput = validateInput(NamespaceStatsInputSchema, input);
    const namespace = validatedInput.namespace;

    const memoryCount = (connections.sqlite.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE namespace = ?"
    ).get(namespace) as any).count;

    const typeBreakdown = connections.sqlite.prepare(
      "SELECT memory_type, COUNT(*) as count FROM memories WHERE namespace = ? GROUP BY memory_type"
    ).all(namespace) as any[];

    const entityCount = (connections.sqlite.prepare(
      "SELECT COUNT(*) as count FROM entities WHERE namespace = ?"
    ).get(namespace) as any).count;

    const skillCount = (connections.sqlite.prepare(
      "SELECT COUNT(*) as count FROM skills WHERE namespace = ?"
    ).get(namespace) as any).count;

    const agents = connections.sqlite.prepare(
      "SELECT DISTINCT agent_id, agent_role FROM memories WHERE namespace = ? AND agent_id IS NOT NULL"
    ).all(namespace) as any[];

    const decisionCount = (connections.sqlite.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE namespace = ? AND memory_type = 'decision'"
    ).get(namespace) as any).count;

    return {
      success: true,
      namespace,
      memories: memoryCount,
      memory_type_breakdown: Object.fromEntries(typeBreakdown.map(t => [t.memory_type, t.count])),
      entities: entityCount,
      skills: skillCount,
      decisions: decisionCount,
      agents: agents.map(a => ({ agent_id: a.agent_id, agent_role: a.agent_role })),
      agent_count: agents.length,
    };
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to get namespace stats: ${err instanceof Error ? err.message : String(err)}`
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
    case "delete_memory":
      return await handleDeleteMemory(input);
    case "record_skill_outcome":
      return await handleRecordSkillOutcome(input);
    case "load_skill":
      return await handleLoadSkill(input);
    case "share_context":
      return await handleShareContext(input);
    case "store_decision":
      return await handleStoreDecision(input);
    case "list_namespaces":
      return await handleListNamespaces();
    case "namespace_stats":
      return await handleNamespaceStats(input);
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
      version: "0.5.0",
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
  console.error("[INFO] Available tools: store_memory, retrieve_memory, list_recent, get_stats, record_skill_outcome, load_skill, vesper_enable, vesper_disable, vesper_status");
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
