-- Initialize PostgreSQL database schema for Memory System

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm" SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- Memory nodes table - core structure for storing memories
CREATE TABLE IF NOT EXISTS memory_nodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    memory_type VARCHAR(50) NOT NULL CHECK (memory_type IN ('working', 'episodic', 'semantic', 'procedural')),
    embedding_id UUID,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accessed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    importance_score FLOAT DEFAULT 0.5,
    retention_strength FLOAT DEFAULT 0.5,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}'::JSONB,
    CONSTRAINT valid_scores CHECK (importance_score >= 0 AND importance_score <= 1),
    CONSTRAINT valid_strength CHECK (retention_strength >= 0 AND retention_strength <= 1)
);

-- Relationships between memory nodes
CREATE TABLE IF NOT EXISTS memory_relationships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_node_id UUID NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    target_node_id UUID NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    relationship_type VARCHAR(100) NOT NULL,
    weight FLOAT DEFAULT 1.0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'::JSONB,
    CONSTRAINT valid_weight CHECK (weight >= 0 AND weight <= 1),
    CONSTRAINT no_self_relationship CHECK (source_node_id != target_node_id)
);

-- Temporal events and state changes
CREATE TABLE IF NOT EXISTS temporal_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT NOT NULL,
    node_id UUID REFERENCES memory_nodes(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN ('created', 'accessed', 'consolidated', 'pruned', 'updated')),
    event_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'::JSONB
);

-- Conflict detection log
CREATE TABLE IF NOT EXISTS conflicts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT NOT NULL,
    node_id_1 UUID NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    node_id_2 UUID NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    conflict_type VARCHAR(50) NOT NULL,
    confidence_score FLOAT DEFAULT 0.0,
    detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved BOOLEAN DEFAULT false,
    resolution_details JSONB,
    CONSTRAINT valid_confidence CHECK (confidence_score >= 0 AND confidence_score <= 1),
    CONSTRAINT no_self_conflict CHECK (node_id_1 != node_id_2)
);

-- Consolidation sessions (sleep-phase like operations)
CREATE TABLE IF NOT EXISTS consolidation_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT NOT NULL,
    session_type VARCHAR(50) NOT NULL CHECK (session_type IN ('sleep-replay', 'compression', 'pruning', 'integration')),
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    nodes_processed INTEGER DEFAULT 0,
    compression_ratio FLOAT,
    metadata JSONB DEFAULT '{}'::JSONB
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_memory_nodes_user_id ON memory_nodes(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_memory_type ON memory_nodes(memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_is_active ON memory_nodes(is_active);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_created_at ON memory_nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_importance ON memory_nodes(importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_user_active ON memory_nodes(user_id, is_active);

CREATE INDEX IF NOT EXISTS idx_relationships_source ON memory_relationships(source_node_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON memory_relationships(target_node_id);
CREATE INDEX IF NOT EXISTS idx_relationships_type ON memory_relationships(relationship_type);

CREATE INDEX IF NOT EXISTS idx_temporal_events_user_id ON temporal_events(user_id);
CREATE INDEX IF NOT EXISTS idx_temporal_events_node_id ON temporal_events(node_id);
CREATE INDEX IF NOT EXISTS idx_temporal_events_timestamp ON temporal_events(event_timestamp);

CREATE INDEX IF NOT EXISTS idx_conflicts_user_id ON conflicts(user_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_node_id_1 ON conflicts(node_id_1);
CREATE INDEX IF NOT EXISTS idx_conflicts_node_id_2 ON conflicts(node_id_2);
CREATE INDEX IF NOT EXISTS idx_conflicts_resolved ON conflicts(resolved);

CREATE INDEX IF NOT EXISTS idx_consolidation_user_id ON consolidation_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_consolidation_completed ON consolidation_sessions(completed_at);

-- Full-text search index for content
CREATE INDEX IF NOT EXISTS idx_memory_content_trgm ON memory_nodes USING GIN (content gin_trgm_ops);

-- Update trigger for updated_at timestamp
CREATE OR REPLACE FUNCTION update_memory_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memory_nodes_updated_at
BEFORE UPDATE ON memory_nodes
FOR EACH ROW
EXECUTE FUNCTION update_memory_updated_at();

-- Grant permissions
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO memory_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO memory_user;
