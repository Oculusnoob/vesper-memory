-- PostgreSQL Authentication Schema for Memory MCP
-- Implements secure API key storage with bcrypt hashing

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- API Keys Table
-- Stores API keys with bcrypt hashed values
-- =============================================================================

CREATE TABLE IF NOT EXISTS api_keys (
    -- Primary key
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- User association
    user_id TEXT NOT NULL,

    -- Key storage (never store plaintext!)
    key_hash TEXT NOT NULL,  -- bcrypt hash of full API key
    key_prefix CHAR(8) NOT NULL,  -- First 8 chars after 'mem_v1_' for lookup

    -- Key metadata
    name VARCHAR(255) NOT NULL,  -- Human-readable key name

    -- Permissions
    scopes TEXT[] NOT NULL DEFAULT '{}',  -- Array of allowed operations
    tier VARCHAR(50) DEFAULT 'standard',  -- Rate limit tier: standard, premium, unlimited

    -- Expiration
    expires_at TIMESTAMP WITH TIME ZONE,  -- NULL means never expires

    -- IP Restrictions (optional)
    ip_allowlist INET[],  -- Array of allowed IP addresses/CIDRs

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,  -- NULL means active, set when revoked

    -- Audit metadata
    created_by TEXT,  -- Who created this key (admin user ID)
    created_ip INET,  -- IP address where key was created

    -- Constraints
    CONSTRAINT valid_tier CHECK (tier IN ('standard', 'premium', 'unlimited')),
    CONSTRAINT valid_scopes CHECK (
        scopes <@ ARRAY['store_memory', 'retrieve_memory', 'list_recent', 'get_stats', '*']::TEXT[]
    ),
    CONSTRAINT key_prefix_format CHECK (key_prefix ~ '^[A-Za-z0-9_-]{8}$')
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at) WHERE revoked_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(id) WHERE revoked_at IS NULL;

-- =============================================================================
-- API Key Rotations Table
-- Tracks key rotation history for grace period support
-- =============================================================================

CREATE TABLE IF NOT EXISTS api_key_rotations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Reference to the key being rotated
    api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,

    -- Old and new key hashes for grace period validation
    old_key_hash TEXT NOT NULL,
    new_key_hash TEXT NOT NULL,

    -- Grace period end time
    grace_period_ends TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Audit
    rotated_by TEXT,  -- Who initiated the rotation
    rotated_ip INET   -- IP address where rotation was initiated
);

-- Indexes for rotation lookups
CREATE INDEX IF NOT EXISTS idx_rotations_key_id ON api_key_rotations(api_key_id);
CREATE INDEX IF NOT EXISTS idx_rotations_grace_active ON api_key_rotations(api_key_id, grace_period_ends)
    WHERE grace_period_ends > NOW();

-- =============================================================================
-- Authentication Audit Log Table
-- Logs all authentication attempts for security monitoring
-- =============================================================================

CREATE TABLE IF NOT EXISTS auth_audit_log (
    id BIGSERIAL PRIMARY KEY,

    -- Key reference (nullable for failed attempts with unknown keys)
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,

    -- Action type
    action VARCHAR(50) NOT NULL,  -- authenticate, rate_limited, revoked, rotated, created

    -- Result
    success BOOLEAN NOT NULL DEFAULT FALSE,
    failure_reason TEXT,  -- Reason for failure if applicable

    -- Request context
    ip_address INET,
    user_agent TEXT,
    request_path TEXT,  -- Tool name or endpoint

    -- Additional metadata
    metadata JSONB DEFAULT '{}',

    -- Timestamp (use timestamptz for proper timezone handling)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT valid_action CHECK (
        action IN ('authenticate', 'rate_limited', 'revoked', 'rotated', 'created', 'scope_denied', 'ip_denied', 'expired')
    )
);

-- Indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_audit_key_id ON auth_audit_log(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON auth_audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_success ON auth_audit_log(success, created_at DESC) WHERE success = FALSE;
CREATE INDEX IF NOT EXISTS idx_audit_ip ON auth_audit_log(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON auth_audit_log(created_at DESC);

-- Partition audit log by month for performance (optional, comment out if not needed)
-- This requires PostgreSQL 11+
-- CREATE TABLE auth_audit_log (
--     ...
-- ) PARTITION BY RANGE (created_at);

-- =============================================================================
-- Rate Limit Tiers Table
-- Configurable rate limits per tier
-- =============================================================================

CREATE TABLE IF NOT EXISTS rate_limit_tiers (
    tier VARCHAR(50) PRIMARY KEY,
    store_memory_limit INTEGER NOT NULL DEFAULT 100,
    retrieve_memory_limit INTEGER NOT NULL DEFAULT 300,
    list_recent_limit INTEGER NOT NULL DEFAULT 60,
    get_stats_limit INTEGER NOT NULL DEFAULT 30,
    window_seconds INTEGER NOT NULL DEFAULT 60,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default tiers
INSERT INTO rate_limit_tiers (tier, store_memory_limit, retrieve_memory_limit, list_recent_limit, get_stats_limit)
VALUES
    ('standard', 100, 300, 60, 30),
    ('premium', 500, 1000, 200, 100),
    ('unlimited', 2000, 5000, 500, 300)
ON CONFLICT (tier) DO NOTHING;

-- =============================================================================
-- Helper Functions
-- =============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_rate_limit_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for rate_limit_tiers
DROP TRIGGER IF EXISTS rate_limit_tiers_updated_at ON rate_limit_tiers;
CREATE TRIGGER rate_limit_tiers_updated_at
BEFORE UPDATE ON rate_limit_tiers
FOR EACH ROW
EXECUTE FUNCTION update_rate_limit_updated_at();

-- Function to clean up expired audit logs (run periodically)
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(retention_days INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM auth_audit_log
    WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to check if an API key is valid (not expired, not revoked)
CREATE OR REPLACE FUNCTION is_api_key_valid(key_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM api_keys
        WHERE id = key_id
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
    );
END;
$$ LANGUAGE plpgsql;

-- Function to get API key by prefix (for lookup before full verification)
CREATE OR REPLACE FUNCTION get_api_key_by_prefix(prefix CHAR(8))
RETURNS TABLE (
    id UUID,
    user_id TEXT,
    key_hash TEXT,
    scopes TEXT[],
    tier VARCHAR(50),
    expires_at TIMESTAMP WITH TIME ZONE,
    ip_allowlist INET[],
    revoked_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ak.id,
        ak.user_id,
        ak.key_hash,
        ak.scopes,
        ak.tier,
        ak.expires_at,
        ak.ip_allowlist,
        ak.revoked_at
    FROM api_keys ak
    WHERE ak.key_prefix = prefix;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- Row Level Security (Optional - Uncomment for multi-tenant security)
-- =============================================================================

-- Enable RLS
-- ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE auth_audit_log ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own keys
-- CREATE POLICY api_keys_user_policy ON api_keys
--     FOR ALL
--     USING (user_id = current_setting('app.current_user_id', true));

-- =============================================================================
-- Grants
-- =============================================================================

-- Grant permissions to application user (adjust role name as needed)
-- GRANT SELECT, INSERT, UPDATE ON api_keys TO memory_app;
-- GRANT SELECT, INSERT ON api_key_rotations TO memory_app;
-- GRANT SELECT, INSERT ON auth_audit_log TO memory_app;
-- GRANT SELECT ON rate_limit_tiers TO memory_app;
-- GRANT USAGE ON SEQUENCE auth_audit_log_id_seq TO memory_app;

-- =============================================================================
-- Comments for documentation
-- =============================================================================

COMMENT ON TABLE api_keys IS 'Stores API keys with bcrypt-hashed values for MCP authentication';
COMMENT ON TABLE api_key_rotations IS 'Tracks key rotations with grace period support';
COMMENT ON TABLE auth_audit_log IS 'Audit log for all authentication attempts and security events';
COMMENT ON TABLE rate_limit_tiers IS 'Configurable rate limits per subscription tier';

COMMENT ON COLUMN api_keys.key_hash IS 'bcrypt hash of the full API key - never store plaintext';
COMMENT ON COLUMN api_keys.key_prefix IS 'First 8 characters after mem_v1_ prefix for efficient lookup';
COMMENT ON COLUMN api_keys.scopes IS 'Array of allowed tool operations: store_memory, retrieve_memory, list_recent, get_stats, *';
COMMENT ON COLUMN api_keys.tier IS 'Rate limiting tier: standard (default), premium, unlimited';
COMMENT ON COLUMN api_keys.ip_allowlist IS 'Optional array of allowed IP addresses/CIDRs';
