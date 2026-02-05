-- AI Memory System v3.0 - SQLite Schema
-- Core graph structure for semantic memory layer
-- Includes entities, relationships, facts, conflicts, and procedural skills

-- ============================================================================
-- ENTITIES TABLE
-- Represents semantic concepts: people, projects, preferences, general concepts
-- ============================================================================

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'person', 'project', 'concept', 'preference'
  description TEXT,
  embedding BLOB,  -- Vector for Qdrant synchronization (binary-encoded)
  confidence REAL DEFAULT 1.0,  -- 0.0-1.0, decreases when conflicts detected
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_accessed TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  access_count INTEGER DEFAULT 1,

  -- Metadata for tracking
  last_modified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_archived BOOLEAN DEFAULT 0,
  metadata TEXT  -- JSON for extensibility
);

-- Entity indexes for fast lookup and retrieval
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_confidence ON entities(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_entities_created_at ON entities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_last_accessed ON entities(last_accessed DESC);
CREATE INDEX IF NOT EXISTS idx_entities_access_count ON entities(access_count DESC);

-- Optimized index for preference queries (direct SQLite lookup optimization)
-- Used by handlePreferenceQueryDirect for fast preference retrieval
CREATE INDEX IF NOT EXISTS idx_entities_preference_lookup
  ON entities(type, last_accessed DESC, confidence DESC)
  WHERE type = 'preference';

-- ============================================================================
-- RELATIONSHIPS TABLE
-- Represents connections between entities with temporal decay
-- ============================================================================

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,  -- 'worked_on', 'prefers', 'mentioned', 'related_to', etc.
  strength REAL NOT NULL DEFAULT 1.0,  -- 0.0-1.0, decays over time with exponential formula
  evidence TEXT,  -- JSON array of conversation IDs supporting this relationship
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_reinforced TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_modified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Access tracking for decay calculation
  access_count INTEGER DEFAULT 1,

  -- Metadata
  is_archived BOOLEAN DEFAULT 0,
  metadata TEXT,  -- JSON for extensibility

  -- Foreign key constraints
  FOREIGN KEY (source_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES entities(id) ON DELETE CASCADE,
  CONSTRAINT unique_relationship UNIQUE(source_id, target_id, relation_type)
);

-- Relationship indexes for efficient traversal and decay updates
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(relation_type);
CREATE INDEX IF NOT EXISTS idx_relationships_strength ON relationships(strength DESC);
CREATE INDEX IF NOT EXISTS idx_relationships_last_reinforced ON relationships(last_reinforced DESC);
CREATE INDEX IF NOT EXISTS idx_relationships_created_at ON relationships(created_at DESC);

-- Index for finding relationships that need decay updates (consolidation process)
CREATE INDEX IF NOT EXISTS idx_relationships_decay_candidates
  ON relationships(last_reinforced, access_count)
  WHERE strength > 0.0 AND is_archived = 0;

-- ============================================================================
-- FACTS TABLE
-- Represents temporal properties of entities with validity windows
-- Tracks confidence and detected contradictions
-- ============================================================================

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  property TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,  -- 0.0-1.0, lowered when contradictions detected
  valid_from TIMESTAMP NOT NULL,  -- When this fact became true
  valid_until TIMESTAMP,  -- When this fact became false (NULL if currently valid)
  source_conversation TEXT,  -- ID of conversation where fact was learned
  contradicts TEXT,  -- JSON array of fact IDs that contradict this one
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_modified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Metadata for tracking
  is_archived BOOLEAN DEFAULT 0,
  notes TEXT,  -- Explanation of why this fact was lowered/disputed
  metadata TEXT,  -- JSON for extensibility

  -- Foreign key constraint
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,

  -- Ensure no exact duplicates
  CONSTRAINT unique_fact UNIQUE(entity_id, property, value, valid_from)
);

-- Fact indexes for retrieval and conflict detection
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_property ON facts(property);
CREATE INDEX IF NOT EXISTS idx_facts_confidence ON facts(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_facts_valid_from ON facts(valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_facts_valid_until ON facts(valid_until DESC);
CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_conversation);
CREATE INDEX IF NOT EXISTS idx_facts_created_at ON facts(created_at DESC);

-- Composite index for finding currently valid facts (used in retrieval)
CREATE INDEX IF NOT EXISTS idx_facts_valid_temporal
  ON facts(entity_id, property, valid_from DESC)
  WHERE valid_until IS NULL AND is_archived = 0;

-- Index for conflict detection queries
CREATE INDEX IF NOT EXISTS idx_facts_conflicts
  ON facts(entity_id, property)
  WHERE contradicts IS NOT NULL AND is_archived = 0;

-- ============================================================================
-- CONFLICTS TABLE
-- Tracks detected contradictions between facts
-- Never auto-resolves, only flags for user clarification
-- ============================================================================

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  fact_id_1 TEXT NOT NULL,
  fact_id_2 TEXT NOT NULL,
  conflict_type TEXT NOT NULL,  -- 'temporal_overlap', 'contradiction', 'preference_shift', 'unknown'
  entity_id TEXT NOT NULL,  -- The entity involved in both facts
  property TEXT,  -- If applicable, the property being contradicted
  description TEXT,  -- Human-readable description of the conflict
  severity TEXT DEFAULT 'medium',  -- 'low', 'medium', 'high'
  resolution_status TEXT DEFAULT 'flagged',  -- 'flagged', 'acknowledged', 'resolved'
  user_resolution TEXT,  -- User's clarification of which fact is correct
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_reviewed TIMESTAMP,

  -- Metadata
  metadata TEXT,  -- JSON for extensibility

  -- Foreign key constraints
  FOREIGN KEY (fact_id_1) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (fact_id_2) REFERENCES facts(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

-- Conflict indexes for efficient detection and resolution
CREATE INDEX IF NOT EXISTS idx_conflicts_entity ON conflicts(entity_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_fact_1 ON conflicts(fact_id_1);
CREATE INDEX IF NOT EXISTS idx_conflicts_fact_2 ON conflicts(fact_id_2);
CREATE INDEX IF NOT EXISTS idx_conflicts_type ON conflicts(conflict_type);
CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(resolution_status);
CREATE INDEX IF NOT EXISTS idx_conflicts_created_at ON conflicts(created_at DESC);

-- Index for finding unresolved conflicts (used during consolidation)
CREATE INDEX IF NOT EXISTS idx_conflicts_unresolved
  ON conflicts(entity_id, created_at DESC)
  WHERE resolution_status IN ('flagged', 'acknowledged');

-- ============================================================================
-- SKILLS TABLE
-- Voyager-style procedural memory: reusable patterns that work well
-- Tracks executable logic, success rates, and dependencies
-- ============================================================================

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  summary TEXT,  -- Lightweight description for context injection (~20 words, ~50 tokens)
  category TEXT,  -- Optional categorization: 'data_analysis', 'writing', 'coding', etc.

  -- Executable logic (references or code)
  code TEXT,  -- The actual implementation (TypeScript or reference)
  code_type TEXT DEFAULT 'reference',  -- 'inline' or 'reference'

  -- Triggering conditions
  triggers TEXT NOT NULL,  -- JSON array of semantic descriptions for when to use
  prerequisites TEXT,  -- JSON array of required context/skills

  -- Success tracking
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  avg_user_satisfaction REAL DEFAULT 0.5,  -- 0.0-1.0, from feedback

  -- Dependency tracking (for composition)
  uses_skills TEXT,  -- JSON array of skill IDs this skill depends on
  used_by_skills TEXT,  -- JSON array of skill IDs that use this skill

  -- Metadata
  is_archived INTEGER DEFAULT 0,  -- Soft deletion flag
  created_from TEXT,  -- Conversation ID where skill was extracted
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used TIMESTAMP,
  last_modified TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER DEFAULT 1,
  is_archived BOOLEAN DEFAULT 0,
  notes TEXT,
  metadata TEXT  -- JSON for extensibility
);

-- Skill indexes for efficient retrieval
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_created_at ON skills(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_success_rate ON skills(success_count, failure_count);

-- Lazy loading indexes for token-efficient skill retrieval
CREATE INDEX IF NOT EXISTS idx_skills_lazy_loading
  ON skills(is_archived, avg_user_satisfaction DESC, success_count DESC);

CREATE INDEX IF NOT EXISTS idx_skills_last_used
  ON skills(last_used DESC)
  WHERE is_archived = 0 AND last_used IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skills_category_quality
  ON skills(category, avg_user_satisfaction DESC, success_count DESC)
  WHERE is_archived = 0;

-- Index for finding high-confidence skills (used in skill-based retrieval)
CREATE INDEX IF NOT EXISTS idx_skills_reliability
  ON skills(avg_user_satisfaction DESC, success_count DESC)
  WHERE is_archived = 0;

-- ============================================================================
-- CONSOLIDATION METADATA TABLE
-- Tracks the consolidation process for recovery and monitoring
-- ============================================================================

CREATE TABLE IF NOT EXISTS consolidation_log (
  id TEXT PRIMARY KEY,
  consolidation_id TEXT NOT NULL UNIQUE,
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  status TEXT NOT NULL,  -- 'in_progress', 'completed', 'failed'

  -- Statistics
  entities_processed INTEGER DEFAULT 0,
  relationships_processed INTEGER DEFAULT 0,
  facts_processed INTEGER DEFAULT 0,
  conflicts_detected INTEGER DEFAULT 0,
  relationships_pruned INTEGER DEFAULT 0,
  skills_extracted INTEGER DEFAULT 0,

  -- Recovery information
  last_checkpoint TIMESTAMP,
  checkpoint_entity_count INTEGER DEFAULT 0,
  error_message TEXT,

  -- Performance tracking
  duration_seconds INTEGER,

  -- Metadata
  notes TEXT,
  metadata TEXT  -- JSON for extensibility
);

-- Consolidation log indexes for monitoring
CREATE INDEX IF NOT EXISTS idx_consolidation_started ON consolidation_log(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_consolidation_status ON consolidation_log(status);

-- ============================================================================
-- BACKUP METADATA TABLE
-- Tracks backups for rollback capability
-- ============================================================================

CREATE TABLE IF NOT EXISTS backup_metadata (
  id TEXT PRIMARY KEY,
  backup_timestamp TIMESTAMP NOT NULL,
  backup_type TEXT NOT NULL,  -- 'daily', 'pre_consolidation', 'manual'
  status TEXT NOT NULL,  -- 'completed', 'failed'

  -- Backup information
  backup_path TEXT,
  file_size_bytes INTEGER,

  -- Backup contents summary
  entities_count INTEGER,
  relationships_count INTEGER,
  facts_count INTEGER,

  -- Retention
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,  -- Auto-delete after 7 days

  -- Metadata
  notes TEXT,
  metadata TEXT
);

-- Backup metadata indexes
CREATE INDEX IF NOT EXISTS idx_backup_timestamp ON backup_metadata(backup_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_backup_status ON backup_metadata(status);
CREATE INDEX IF NOT EXISTS idx_backup_expiry ON backup_metadata(expires_at);

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- Provide convenient access patterns for application code
-- ============================================================================

-- View: Currently valid facts (no longer temporal lookup needed in code)
CREATE VIEW IF NOT EXISTS valid_facts AS
SELECT f.*
FROM facts f
WHERE f.valid_until IS NULL
  AND f.is_archived = 0
  AND f.confidence > 0.0;

-- View: Active relationships (not archived, still have strength)
CREATE VIEW IF NOT EXISTS active_relationships AS
SELECT r.*,
       e1.name as source_name,
       e2.name as target_name
FROM relationships r
JOIN entities e1 ON r.source_id = e1.id
JOIN entities e2 ON r.target_id = e2.id
WHERE r.is_archived = 0
  AND r.strength > 0.0;

-- View: Unresolved conflicts for consolidation
CREATE VIEW IF NOT EXISTS unresolved_conflicts AS
SELECT c.*,
       f1.property as property_1,
       f1.value as value_1,
       f2.property as property_2,
       f2.value as value_2
FROM conflicts c
JOIN facts f1 ON c.fact_id_1 = f1.id
JOIN facts f2 ON c.fact_id_2 = f2.id
WHERE c.resolution_status IN ('flagged', 'acknowledged');

-- View: High-confidence skills ready for use
CREATE VIEW IF NOT EXISTS reliable_skills AS
SELECT s.*,
       CASE
         WHEN (s.success_count + s.failure_count) = 0 THEN 0.5
         ELSE CAST(s.success_count AS REAL) / (s.success_count + s.failure_count)
       END as success_rate
FROM skills s
WHERE s.is_archived = 0
ORDER BY s.avg_user_satisfaction DESC, s.success_count DESC;

-- View: Entities with connection counts
CREATE VIEW IF NOT EXISTS entity_stats AS
SELECT
  e.id,
  e.name,
  e.type,
  e.confidence,
  COUNT(DISTINCT r.id) as relationship_count,
  COUNT(DISTINCT f.id) as fact_count,
  e.access_count,
  e.last_accessed
FROM entities e
LEFT JOIN relationships r ON (e.id = r.source_id OR e.id = r.target_id) AND r.is_archived = 0
LEFT JOIN facts f ON e.id = f.entity_id AND f.is_archived = 0
GROUP BY e.id;

-- ============================================================================
-- INITIALIZATION NOTES
-- ============================================================================
--
-- This schema supports the AI Memory System v3.0 architecture:
--
-- 1. ENTITIES: Semantic concepts (people, projects, preferences)
--    - Embedding field enables Qdrant vector search integration
--    - Confidence tracks reliability (lowered when conflicts detected)
--    - Access patterns tracked for eviction decisions
--
-- 2. RELATIONSHIPS: Temporal connections between entities
--    - strength: Decays over time using exponential formula
--    - evidence: Links to source conversations for traceability
--    - Indexed for efficient graph traversal (HippoRAG support)
--
-- 3. FACTS: Temporal properties with validity windows
--    - valid_from/valid_until: Enables temporal reasoning
--    - contradicts: Links to conflicting facts for detection
--    - confidence: Lowered when contradictions detected
--
-- 4. CONFLICTS: Flagged contradictions (never auto-resolved)
--    - Types: temporal_overlap, contradiction, preference_shift
--    - Resolution: Manual user clarification required
--
-- 5. SKILLS: Procedural memory (Voyager-style)
--    - triggers: Semantic descriptions for skill matching
--    - Dependency tracking for composition
--    - Success/satisfaction metrics for ranking
--
-- CONSOLIDATION PROCESS (Nightly at 3 AM):
--   1. Extract entities/relationships from working memory
--   2. Upsert to semantic layer (entities, relationships, facts)
--   3. Apply exponential decay to all relationships
--   4. Detect conflicts (temporal, semantic, preference shifts)
--   5. Prune low-strength, rarely-accessed memories
--   6. Extract skills from positive interactions
--   7. Create backup for recovery
--
-- DECAY FORMULA (exponential):
--   strength(t) = strength(0) * e^(-t/30)
--   - Decays to 50% in ~21 days
--   - Decays to 10% in ~69 days
--   - Pruning threshold: strength < 0.05 AND access_count < 3
--
-- PERFORMANCE TARGETS:
--   - Entity lookup: <1ms (indexed by name, type)
--   - Relationship traversal: <10ms (indexed for HippoRAG)
--   - Fact retrieval: <5ms (indexed by entity, temporal)
--   - Conflict detection: <100ms (indexed for query efficiency)
--   - Consolidation: <15min for 10K memories
--
-- ============================================================================
