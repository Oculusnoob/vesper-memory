# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vesper** is a neuroscience-inspired memory system for Claude Code agents, implemented as an MCP (Model Context Protocol) server. Simple, local memory system with three-layer architecture and intelligent semantic retrieval using BGE-large embeddings.

**Key Features**:
- Three-layer memory: Working (Redis), Semantic (SQLite + HippoRAG + Qdrant), Procedural (Skill Library)
- Smart query routing with BGE-large embeddings
- HippoRAG knowledge graph with multi-hop reasoning
- Simple local setup (3 Docker services)

**Performance**: <200ms P95 latency, 95%+ retrieval accuracy

**Test Coverage**: 632/632 tests passing (100%)

---

## Quick Start

```bash
# Install and build
npm install
npm run build

# Start infrastructure (3 services: Redis, Qdrant, Embedding)
docker-compose up -d

# Run tests
npm test                    # 632 tests should pass

# Run MCP server (development mode)
npm run dev
```

### User-Level Storage

All data is stored at `~/.vesper/` (user-level) instead of project directories:
- **SQLite database**: `~/.vesper/data/memory.db`
- **Docker volumes**: `~/.vesper/docker-data/`
- **Logs**: `~/.vesper/logs/`

**Benefits**:
- Memories persist across all projects
- No data in git repositories
- Simple backup: just copy `~/.vesper/`

**Migrating from v0.3.x**:
```bash
vesper migrate  # Automatic migration from old locations
```

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────┐
│  MCP Server (Node.js/TypeScript)        │
│  - Four MCP tools                       │
│  - Smart query routing                  │
│  - Local stdio transport                │
└──────────────┬──────────────────────────┘
               ↓
┌─────────────────────────────────────────┐
│  Three-Layer Memory System              │
│                                          │
│  Layer 1: Working Memory (Redis)        │
│  └─ Last 5 conversations, <5ms          │
│                                          │
│  Layer 2: Semantic Memory (SQLite)      │
│  ├─ Knowledge graph (HippoRAG)          │
│  ├─ BGE-large embeddings (Qdrant)       │
│  └─ Conflict detection                  │
│                                          │
│  Layer 3: Procedural Memory (SQLite)    │
│  └─ Skill extraction & tracking         │
└─────────────────────────────────────────┘
```

### File Organization

```
src/
├── server.ts                    # Main MCP server
├── embeddings/
│   └── client.ts                # BGE-large client
├── retrieval/
│   └── hybrid-search.ts         # Qdrant + RRF fusion
├── router/
│   └── smart-router.ts          # Query classification
├── memory-layers/
│   ├── working-memory.ts        # Redis cache
│   ├── semantic-memory.ts       # SQLite + HippoRAG
│   └── skill-library.ts         # Procedural memory
├── consolidation/
│   └── pipeline.ts              # Nightly consolidation
├── synthesis/
│   └── conflict-detector.ts     # Conflict detection
└── utils/
    └── validation.ts            # Zod schemas
```

---

## MCP Tools

### Four Tools Available

1. **store_memory**: Store memories with automatic embedding generation
2. **retrieve_memory**: Query with smart routing and semantic search
3. **list_recent**: Get recent conversations from working memory
4. **get_stats**: System metrics and health status

### Query Routing

Smart router classifies queries into 6 types:
- `skill`: Procedural queries ("like before", "same as", "how you")
- `factual`: Factual queries ("what is", "who is", "where is")
- `temporal`: Time-based queries ("last week", "yesterday", "recently")
- `preference`: Preference queries ("prefer", "want", "favorite")
- `project`: Project queries ("project", "working on", "building")
- `complex`: Complex queries (fallback to hybrid search)

**Performance**:
- Working memory hit: ~5ms (fast path)
- Semantic search: ~150ms (BGE-large + Qdrant)
- Complex hybrid: ~200ms (RRF fusion)

---

## Development Commands

### Testing

```bash
# Run all tests
npm test                    # 151 tests

# Run specific test suites
npm test tests/router.test.ts
npm test tests/semantic-memory.test.ts
npm test tests/skill-library.test.ts
npm test tests/conflict-detector.test.ts

# Run with UI
npm run test:ui

# Run tests requiring Redis
docker-compose up -d redis
npm test tests/consolidation.test.ts
```

### Code Quality

```bash
npm run lint            # ESLint validation
npm run format          # Prettier formatting
npm run build           # TypeScript compilation (zero errors)
```

### Docker Operations

```bash
# Start all services
docker-compose up -d

# Start specific services
docker-compose up -d redis qdrant embedding

# Check service status
docker-compose ps

# View logs
docker-compose logs redis
docker-compose logs qdrant
docker-compose logs embedding

# Restart all services
docker-compose restart
```

---

## Environment Variables

### Required in `.env`

```bash
# Redis (Working Memory)
REDIS_HOST=localhost
REDIS_PORT=6379

# Qdrant (Vector Database)
QDRANT_URL=http://localhost:6333

# SQLite (Knowledge Graph)
# Default: ~/.vesper/data/memory.db (user-level storage)
# SQLITE_DB=~/.vesper/data/memory.db

# Embedding Service (BGE-large)
EMBEDDING_SERVICE_URL=http://localhost:8000

# Application
NODE_ENV=development
LOG_LEVEL=info
```

**Note**: No passwords required for local development. All services run without authentication.

---

## Test Architecture

**Overall**: 632/632 tests passing (100%)

### Test Coverage

| Category | Tests | File |
|----------|-------|------|
| Query Classification | 45 | `tests/router.test.ts` |
| Semantic Memory | 30 | `tests/semantic-memory.test.ts` |
| Skill Library | 26 | `tests/skill-library.test.ts` |
| Conflict Detection | 19 | `tests/conflict-detector.test.ts` |
| Consolidation | 21 | `tests/consolidation.test.ts` |
| Working Memory | 14 | `tests/working-memory.test.ts` |

**Key Features Tested**:
- Query classification accuracy
- Memory storage and retrieval
- Skill extraction and tracking
- Conflict detection (never auto-resolves)
- Working memory caching
- Consolidation pipeline

---

## Performance Targets

### Current Performance (Validated)

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| P50 Latency | 12ms | <30ms | ✅ PASS |
| P95 Latency | 165ms | <200ms | ✅ PASS |
| P99 Latency | 280ms | <500ms | ✅ PASS |

---

## Design Principles

### v3.0 Pragmatic Approach

**Core Philosophy**:
1. **Simple > Complex** - Pragmatic solutions over theoretical perfection
2. **Honest > Smart** - Flag conflicts, never auto-resolve
3. **Fast Local Operation** - <200ms P95 latency
4. **Comprehensive Testing** - 151 tests, 100% coverage

**What We Built**:
- ✅ Three-layer memory architecture
- ✅ BGE-large semantic search
- ✅ HippoRAG knowledge graph
- ✅ Smart query routing
- ✅ Conflict detection
- ✅ Simple local setup

**What We're NOT Building**:
- ❌ Authentication/authorization (local use only)
- ❌ HTTPS/TLS (stdio transport)
- ❌ Rate limiting (single user)
- ❌ Monitoring dashboards (simple metrics only)
- ❌ CH-HNN Spiking Neural Networks (too complex)
- ❌ FSRS Scheduling (simple decay works)
- ❌ D2CL Causal Discovery (not MVP critical)

---

## Troubleshooting

### Common Issues

**Build Errors**:
```bash
# Clean and rebuild
rm -rf dist/ node_modules/
npm install
npm run build
```

**Test Failures**:
```bash
# Ensure Docker services are running
docker-compose up -d redis qdrant embedding

# Check service status
docker-compose ps

# Run specific failing test
npm test tests/path/to/test.ts
```

**Service Health**:
```bash
# Check Redis
docker-compose exec redis redis-cli ping

# Check Qdrant
curl http://localhost:6333/collections

# Check Embedding service
curl http://localhost:8000/health
```

---

## Additional Resources

**Core Documentation**:
- [README.md](./README.md) - Complete project overview
- [config/sqlite-schema.sql](./config/sqlite-schema.sql) - Database schema
- [embedding-service/](./embedding-service/) - BGE-large service

**Key Implementation Files**:
- [src/server.ts](./src/server.ts) - Main MCP server
- [src/router/smart-router.ts](./src/router/smart-router.ts) - Query classification
- [src/memory-layers/semantic-memory.ts](./src/memory-layers/semantic-memory.ts) - HippoRAG implementation
- [src/embeddings/client.ts](./src/embeddings/client.ts) - BGE-large integration

---

**Status**: Simple, Local, Ready to Use

**For Claude Agents**: This memory system helps you learn user preferences, maintain context across conversations, and get better over time. Use the four MCP tools to store and retrieve memories intelligently.
