/**
 * Smart Query Router
 *
 * Implements intelligent routing logic from v3.0 plan:
 * 1. Always check working memory first (fast path)
 * 2. Classify query type using regex patterns
 * 3. Route to appropriate handler based on classification
 * 4. Fall back to hybrid search for complex queries
 */

import { WorkingMemoryLayer } from '../memory-layers/working-memory.js';

/**
 * Module-level dependency - set via init()
 */
let workingMemoryLayer: WorkingMemoryLayer | null = null;

/**
 * Initialize the router with dependencies
 */
export function init(deps: { workingMemory?: WorkingMemoryLayer }): void {
  workingMemoryLayer = deps.workingMemory || null;
}

/**
 * Query type enumeration
 * Used to classify queries and route to appropriate handlers
 */
export enum QueryType {
  FACTUAL = "factual",
  PREFERENCE = "preference",
  PROJECT = "project",
  TEMPORAL = "temporal",
  SKILL = "skill",
  COMPLEX = "complex"
}

/**
 * Query classification result
 */
export interface ClassificationResult {
  type: QueryType;
  confidence: number;  // 0-1, indicates how certain the classification is
  matchedPattern?: string;  // The regex pattern that matched (for debugging)
}

/**
 * Context for routing decisions
 */
export interface RoutingContext {
  userId: string;
  conversationId: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Memory result from any layer
 */
export interface MemoryResult {
  id: string;
  source: "working" | "semantic" | "procedural" | "hybrid";
  content: string;
  similarity: number;  // 0-1 relevance score
  timestamp: Date;
  confidence?: number;  // For semantic layer facts
}

/**
 * Classify a query into one of the six query types
 *
 * Uses simple regex patterns to identify query intent without LLM calls.
 * Falls back to 'complex' for ambiguous queries.
 *
 * Patterns (in order of specificity):
 * - skill: "like before", "same as", "same way", "how you", "analyze"
 * - factual: "what is", "who is", "where is"
 * - temporal: "last week", "yesterday", "recently", etc.
 * - preference: "prefer", "want", "style", "favorite"
 * - project: "project", "working on", "decided", "building", "creating", "developing"
 * - complex: fallback for anything else
 */
export function classifyQuery(query: string): ClassificationResult {
  const normalizedQuery = query.toLowerCase().trim();

  // Pattern definitions with confidence scores
  // NOTE: More specific patterns should be checked first to avoid ambiguity
  const patterns = [
    // Skill patterns are most specific - check before preference and temporal
    {
      type: QueryType.SKILL,
      regex: /\b(like before|same as|same way|how you)\b/i,
      confidence: 0.85,
      label: "skill"
    },
    {
      type: QueryType.SKILL,
      regex: /\banalyze\b/i,
      confidence: 0.75,
      label: "skill_analyze"
    },
    // Temporal patterns - check before factual WH questions since temporal is more specific
    {
      type: QueryType.TEMPORAL,
      regex: /\b(last week|last month|last year|last time)\b/i,
      confidence: 0.95,
      label: "temporal_specific"
    },
    {
      type: QueryType.TEMPORAL,
      regex: /\b(yesterday|recently|earlier)\b/i,
      confidence: 0.9,
      label: "temporal"
    },
    {
      type: QueryType.TEMPORAL,
      regex: /\bbefore\b/i,
      confidence: 0.7,
      label: "temporal_before"
    },
    // Factual patterns (WH questions) - after temporal to avoid misclassifying temporal queries
    {
      type: QueryType.FACTUAL,
      regex: /\b(what|who|where)\s+(is|was|are|were)\b/i,
      confidence: 0.95,
      label: "factual_wh"
    },
    // Preference patterns
    {
      type: QueryType.PREFERENCE,
      regex: /\b(prefer|want|style|favorite)\b/i,
      confidence: 0.9,
      label: "preference"
    },
    // Note: 'like' as preference is checked but has lower confidence due to ambiguity
    {
      type: QueryType.PREFERENCE,
      regex: /\bhow do i like\b/i,
      confidence: 0.85,
      label: "preference_like"
    },
    // Project patterns
    {
      type: QueryType.PROJECT,
      regex: /\b(working on|decided|decide|decision)\b/i,
      confidence: 0.9,
      label: "project_specific"
    },
    {
      type: QueryType.PROJECT,
      regex: /\b(project|building|creating|developing)\b/i,
      confidence: 0.85,
      label: "project"
    }
  ];

  // Check each pattern in order
  for (const pattern of patterns) {
    if (pattern.regex.test(normalizedQuery)) {
      return {
        type: pattern.type,
        confidence: pattern.confidence,
        matchedPattern: pattern.label
      };
    }
  }

  // Default to complex query
  return {
    type: QueryType.COMPLEX,
    confidence: 0.5
  };
}

/**
 * Smart query router following v3.0 plan retrieval strategy
 *
 * Routing decision tree:
 * 1. Check working memory first (5ms, high confidence threshold)
 * 2. Classify query type with regex
 * 3. Route to appropriate handler:
 *    - factual: direct entity lookup
 *    - preference: preference retrieval
 *    - project: graph traversal with HippoRAG
 *    - temporal: time-based filtering
 *    - skill: skill library search
 *    - complex: hybrid search (dense + sparse + BM25)
 *
 * @param query - The user's query string
 * @param context - Routing context (user, conversation, etc.)
 * @returns Promise resolving to array of memory results
 *
 * @throws Error if query is empty or context is invalid
 */
export async function retrieve(
  query: string,
  context: RoutingContext
): Promise<MemoryResult[]> {
  // Input validation
  if (!query || query.trim().length === 0) {
    throw new Error("Query cannot be empty");
  }

  if (!context || !context.userId) {
    throw new Error("Valid routing context with userId is required");
  }

  // Step 1: ALWAYS check working memory first (5ms fast path)
  const recentMemories = await checkWorkingMemory(query, context);

  // High similarity threshold suggests cache hit - return immediately
  if (recentMemories.length > 0 && recentMemories[0].similarity > 0.85) {
    console.debug(`[Router] Cache hit in working memory for query: "${query}"`);
    return recentMemories;
  }

  // Step 2: Classify query type using regex patterns
  const classification = classifyQuery(query);
  console.debug(
    `[Router] Query classified as ${classification.type} ` +
    `(confidence: ${classification.confidence}, pattern: ${classification.matchedPattern})`
  );

  // Step 3: Route to appropriate handler based on classification
  let results: MemoryResult[] = [];

  switch (classification.type) {
    case QueryType.FACTUAL:
      results = await handleFactualQuery(query, context);
      break;

    case QueryType.PREFERENCE:
      results = await handlePreferenceQuery(query, context);
      break;

    case QueryType.PROJECT:
      results = await handleProjectQuery(query, context);
      break;

    case QueryType.TEMPORAL:
      results = await handleTemporalQuery(query, context);
      break;

    case QueryType.SKILL:
      results = await handleSkillQuery(query, context);
      break;

    case QueryType.COMPLEX:
    default:
      results = await handleComplexQuery(query, context);
      break;
  }

  return results;
}

/**
 * Check working memory for recent relevant memories
 *
 * Implementation stub - will integrate with Redis/Hopfield layer
 * Current behavior: returns empty array (no working memory yet)
 *
 * @param query - Search query
 * @param context - Routing context
 * @returns Recent memory results matching query
 */
async function checkWorkingMemory(
  query: string,
  _context: RoutingContext
): Promise<MemoryResult[]> {
  console.debug(`[Router] Checking working memory for: "${query}"`);

  // Early return if working memory not available
  if (!workingMemoryLayer) {
    console.debug(`[Router] Working memory layer not initialized`);
    return [];
  }

  try {
    // Search working memory using keyword matching (5ms fast path)
    const results = await workingMemoryLayer.search(query, 3);

    // Transform to MemoryResult format
    return results.map(r => ({
      id: r.memory.conversationId,
      source: "working" as const,
      content: r.memory.fullText,
      similarity: r.similarity,
      timestamp: r.memory.timestamp,
    }));
  } catch (err) {
    console.error(`[Router] Working memory search error:`, err);
    return [];
  }
}

/**
 * Handle factual queries
 *
 * Pattern: "What is X?", "Who is Y?", "Where is Z?"
 * Handler: Direct entity lookup in semantic memory
 *
 * Implementation stub
 *
 * @param query - The factual query
 * @param context - Routing context
 * @returns Entity information
 */
async function handleFactualQuery(
  query: string,
  _context: RoutingContext
): Promise<MemoryResult[]> {
  console.debug(`[Router] Handling factual query: "${query}"`);

  // TODO: Implement factual query handler
  // 1. Extract entity name from query (using NER or simple heuristics)
  // 2. Lookup entity in semantic memory
  // 3. Retrieve related facts and properties
  // 4. Return with confidence scores

  return [];
}

/**
 * Handle preference queries
 *
 * Pattern: "How do I prefer X?", "What style do I like?"
 * Handler: Preference retrieval from semantic memory
 *
 * Implementation stub
 *
 * @param query - The preference query
 * @param context - Routing context
 * @returns User preference information
 */
async function handlePreferenceQuery(
  query: string,
  _context: RoutingContext
): Promise<MemoryResult[]> {
  console.debug(`[Router] Handling preference query: "${query}"`);

  // TODO: Implement preference query handler
  // 1. Extract preference domain from query
  // 2. Search semantic memory for related preference facts
  // 3. Apply temporal decay to weight recent preferences
  // 4. Return ranked by recency and reinforcement

  return [];
}

/**
 * Handle project queries
 *
 * Pattern: "What did we decide about X?", "What's the status on Y?"
 * Handler: Graph traversal with HippoRAG personalized PageRank
 *
 * Implementation stub
 *
 * @param query - The project query
 * @param context - Routing context
 * @returns Project-related information via graph traversal
 */
async function handleProjectQuery(
  query: string,
  _context: RoutingContext
): Promise<MemoryResult[]> {
  console.debug(`[Router] Handling project query: "${query}"`);

  // TODO: Implement project query handler
  // 1. Extract project entity name from query
  // 2. Lookup project entity in semantic memory
  // 3. Run HippoRAG personalized PageRank from project node (depth=2)
  // 4. Return connected entities and relationships

  return [];
}

/**
 * Handle temporal queries
 *
 * Pattern: "What were we working on last week?", "What was discussed yesterday?"
 * Handler: Time-based filtering from semantic memory
 *
 * Implementation stub
 *
 * @param query - The temporal query
 * @param context - Routing context
 * @returns Memories from specified time range
 */
async function handleTemporalQuery(
  query: string,
  _context: RoutingContext
): Promise<MemoryResult[]> {
  console.debug(`[Router] Handling temporal query: "${query}"`);

  // TODO: Implement temporal query handler
  // 1. Parse temporal references from query
  // 2. Convert to time range (start_date, end_date)
  // 3. Query semantic memory for memories in that range
  // 4. Apply temporal decay based on specificity

  return [];
}

/**
 * Handle skill queries
 *
 * Pattern: "Analyze this like before", "Same way as last time"
 * Handler: Skill library semantic search
 *
 * Implementation stub
 *
 * @param query - The skill query
 * @param context - Routing context
 * @returns Matching skills from skill library
 */
async function handleSkillQuery(
  query: string,
  _context: RoutingContext
): Promise<MemoryResult[]> {
  console.debug(`[Router] Handling skill query: "${query}"`);

  // TODO: Implement skill query handler
  // 1. Embed query using BGE-large
  // 2. Search skill library for matching triggers
  // 3. Filter by prerequisites being met in context
  // 4. Return skills ranked by success rate

  return [];
}

/**
 * Handle complex queries
 *
 * Pattern: Ambiguous queries that don't match specific patterns
 * Handler: Hybrid search across all representations
 *
 * Hybrid search pipeline:
 * 1. Parallel search: dense embeddings + sparse vectors + BM25
 * 2. Reciprocal Rank Fusion (k=60) to combine results
 * 3. Light reranking with cross-encoder on top-10
 * 4. Return top-5 fused results
 *
 * Implementation stub
 *
 * @param query - The complex query
 * @param context - Routing context
 * @returns Hybrid search results
 */
async function handleComplexQuery(
  query: string,
  _context: RoutingContext
): Promise<MemoryResult[]> {
  console.debug(`[Router] Handling complex query with hybrid search: "${query}"`);

  // TODO: Implement hybrid search
  // 1. Embed query in multiple representations:
  //    - Dense: BGE-large embeddings
  //    - Sparse: SPLADE++ sparse vectors
  //    - Keyword: BM25 tokenization
  //
  // 2. Parallel search in Qdrant:
  //    - Dense similarity search (limit: 20)
  //    - Sparse similarity search (limit: 20)
  //    - BM25 full-text search (limit: 20)
  //
  // 3. Reciprocal Rank Fusion:
  //    - Combine ranked lists from three searches
  //    - Weight scores using RRF formula with k=60
  //
  // 4. Light reranking:
  //    - Use cross-encoder (not ColBERT for speed)
  //    - Rerank only top-10 results
  //    - Adds ~20ms but significant accuracy gain
  //
  // 5. Return top-5 after reranking

  return [];
}

/**
 * Extract entity name from a query
 *
 * Implementation stub for entity extraction
 * Will later integrate with NER or simple heuristics
 */
export function extractEntityName(_query: string): string | null {
  // TODO: Implement entity extraction
  // Current: just return null
  return null;
}

/**
 * Extract domain/category from a query
 *
 * Implementation stub for domain extraction
 * Used for preference and skill queries
 */
export function extractDomain(_query: string): string | null {
  // TODO: Implement domain extraction
  // Current: just return null
  return null;
}

/**
 * Parse temporal references from query
 *
 * Implementation stub for temporal parsing
 * Will extract time ranges like "last week", "yesterday", etc.
 */
export interface TimeRange {
  startDate: Date;
  endDate: Date;
}

export function parseTimeRange(_query: string): TimeRange | null {
  // TODO: Implement temporal reference parsing
  // Current: just return null
  return null;
}
