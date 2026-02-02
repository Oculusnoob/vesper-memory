# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/fitz2882/vesper/releases/tag/v0.1.0
