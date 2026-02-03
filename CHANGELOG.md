# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-02-03

### BREAKING CHANGES

**User-Level Storage Migration**
- All data now stored at `~/.vesper/` (user-level) instead of project directories
- SQLite database: `~/.vesper/data/memory.db` (was `./data/memory.db`)
- Docker volumes: `~/.vesper/docker-data/` (were named volumes `qdrant_storage`, `redis_storage`)
- Memories now persist across all projects

**Migration Required:**
```bash
# Automatic migration from v0.3.x
vesper migrate

# Or manually:
mkdir -p ~/.vesper/data
cp ./data/memory.db ~/.vesper/data/memory.db
docker-compose down
docker-compose up -d
```

### Added

**CLI Enhancements**
- `vesper migrate` command for automatic data migration from v0.3.x
- User-level directory structure creation with secure permissions (0o700)
- `VESPER_HOME` environment variable for custom storage location
- Improved `vesper status` showing data directory and database size
- Detection of old data needing migration

**Path Utilities**
- Cross-platform path resolution module (`src/utils/paths.ts`)
- `getVesperHome()` - Resolves `~/.vesper` with platform-specific home directory
- `getSqlitePath()` - Returns user-level SQLite database path
- `ensureDirectories()` - Creates all required directories with proper permissions
- Tilde expansion support in environment variables

**Security Improvements**
- Path traversal warnings for system directories
- Restrictive directory permissions (owner-only: 0o700)
- Fixed command injection vulnerability in CLI uninstall
- Secrets excluded from version control (.claude/settings.local.json)

**Testing**
- 62 new tests for path utilities, CLI migration, and Docker config
- Total: 632 tests passing (up from 570)
- 100% test coverage for migration logic

### Changed

- Docker volumes changed from named volumes to host bind mounts
- Default SQLITE_DB path from `./data/memory.db` to `~/.vesper/data/memory.db`
- CLI install creates `~/.vesper/` structure instead of local `data/` directory
- Server logs now indicate whether using user-level storage or override
- Environment variable handling improved with `VESPER_HOME` support

### Fixed

- Command injection vulnerability in `vesper uninstall` (replaced shell `rm -rf` with `fs.rmSync`)
- Race condition in directory creation (removed redundant `existsSync` checks)
- Missing error handling for directory creation failures
- Secrets exposure risk (added .claude/settings.local.json to .gitignore)

### Security

- **CRITICAL**: Prevented hardcoded secrets in version control
- **HIGH**: Fixed command injection in CLI uninstall
- **HIGH**: Added path traversal warnings for dangerous paths
- **MEDIUM**: Set restrictive permissions on data directories
- Security review conducted by automated security-reviewer agent

## [0.3.0] - 2026-02-02

### Added

**Performance Optimizations**
- Preference query handler with direct SQLite lookup (31% faster: 204ms → 142ms)
- Temporal decay weighting for preference ranking
- LRU embedding cache (1000 entries, 1hr TTL) eliminates redundant HTTP calls
- Working memory integration in smart router for fast-path retrieval
- Optimized SQL index for preference queries

**Multi-hop Reasoning**
- `personalizedPageRankWithFacts()` method for knowledge graph traversal
- Fact retrieval along traversal paths for multi-hop query answering
- Chain tracking with intermediary entities for explainability
- Path information showing relationship types between entities
- Support for inferring A→C connections via A→B→C chains

**Testing & Validation**
- 6 new preference handler tests (edge cases, performance, scaling)
- 8 new multi-hop fact chaining tests
- All 529 tests passing (100% pass rate)

### Performance

- Preference queries: -31% latency (204.4ms → 141.8ms)
- Multi-hop queries: -11% latency (173.4ms → 154.2ms)
- Overall accuracy: 98.5% F1 score
- P50 latency: 4.4ms (target: <30ms) ✅
- P95 latency: 5.3ms (target: <200ms) ✅

## [0.2.0] - 2026-02-02

### Added

**Scientific Benchmarking System**
- Accuracy-focused benchmark measuring answer quality (not just latency)
- Real-world benchmark with A/B testing methodology
- Statistical validation (Welch's t-test, Cohen's d effect size)
- 5 test categories: Factual, Preference, Temporal, Multi-hop, Contradiction
- Automated report generation with detailed metrics

**Documentation**
- Reorganized README with performance section before origin story
- Updated benchmark results with clean database runs
- Fixed accuracy claims and routing strategy documentation
- Corrected latency measurements and improvement calculations

### Fixed

- Database contamination in benchmarks (now cleared between runs)
- Semantic versioning (0.1.1 → 0.2.0 for features)
- README inaccuracies in tech stack descriptions

## [0.1.0] - 2026-02-01

### Added

**Core Memory System**
- Three-layer memory architecture (Working, Semantic, Procedural)
- BGE-large embeddings (1024-dimensional vectors)
- Hybrid semantic search with RRF fusion
- Smart query routing with 6 query types
- Conflict detection (temporal, contradiction, preference)
- Nightly consolidation pipeline

**Production Features**
- HTTPS/TLS encryption with nginx
- API key authentication with bcrypt hashing
- Tier-based rate limiting (standard/premium/unlimited)
- Comprehensive Prometheus metrics (13 metric types)
- Grafana dashboards (16 panels)
- AlertManager integration (PagerDuty, Slack, Email)
- Certificate expiration monitoring

**Infrastructure**
- Docker Compose orchestration (13 services)
- Redis for working memory (<5ms latency)
- Qdrant for vector storage
- PostgreSQL for auth and metadata
- SQLite for knowledge graphs
- Python embedding service (BGE-large-en-v1.5)

**Developer Experience**
- Automatic MCP configuration on install
- CLI tools (install, configure, status, uninstall)
- Health checks and service validation
- Session startup hooks
- Comprehensive error handling

**Security & Compliance**
- OWASP Top 10 compliance
- Fail-closed rate limiting
- Audit logging for all auth attempts
- Secure credential storage
- Input validation with Zod v4
- No CRITICAL/HIGH vulnerabilities

**Testing & Quality**
- 171 tests (100% pass rate)
- Integration tests for all features
- Performance validation (<200ms P95)
- Security audit completed
- TypeScript strict mode

**Documentation**
- Complete README with deployment guide
- API documentation
- Security audit report
- Production readiness checklist
- Troubleshooting guide

### Performance

- P50 latency: 12ms (target: <30ms) ✅
- P95 latency: 165ms (target: <200ms) ✅
- P99 latency: 280ms (target: <500ms) ✅
- Working memory hit: ~5ms
- Semantic search: ~150ms
- Total security overhead: ~15ms

### Cost Efficiency

- Infrastructure: $49-73/month
- Per user: $0.49-0.73/month (100 users)
- 97% cost reduction vs. target

[0.3.0]: https://github.com/fitz2882/vesper-memory/releases/tag/v0.3.0
[0.2.0]: https://github.com/fitz2882/vesper-memory/releases/tag/v0.2.0
[0.1.0]: https://github.com/fitz2882/vesper-memory/releases/tag/v0.1.0
