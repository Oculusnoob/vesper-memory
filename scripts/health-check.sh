#!/bin/bash
# Health check for Memory MCP server and dependencies

set -e

PROJECT_DIR="/Users/fitzy/Documents/MemoryProject"

echo "🔍 Memory System Health Check"
echo "=============================="

# Check Docker
if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker: Not running"
    exit 1
else
    echo "✅ Docker: Running"
fi

# Check Redis
if docker-compose -f "$PROJECT_DIR/docker-compose.yml" ps redis | grep -q "Up"; then
    REDIS_PASSWORD="${REDIS_PASSWORD:-MHot0MIuDfST4QUY6g3WVbLzcDEzJ14B}"
    if docker exec memory-redis redis-cli -a "$REDIS_PASSWORD" ping 2>/dev/null | grep -q "PONG"; then
        echo "✅ Redis: Running and responsive"
    else
        echo "⚠️  Redis: Running but not responsive"
    fi
else
    echo "❌ Redis: Not running"
fi

# Check PostgreSQL
if docker-compose -f "$PROJECT_DIR/docker-compose.yml" ps postgres | grep -q "Up"; then
    if docker exec memory-postgres pg_isready -U postgres 2>/dev/null | grep -q "accepting connections"; then
        echo "✅ PostgreSQL: Running and responsive"
    else
        echo "⚠️  PostgreSQL: Running but not responsive"
    fi
else
    echo "❌ PostgreSQL: Not running"
fi

# Check Qdrant
if docker-compose -f "$PROJECT_DIR/docker-compose.yml" ps qdrant | grep -q "Up"; then
    if curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
        echo "✅ Qdrant: Running and responsive"
    else
        echo "⚠️  Qdrant: Running but not responsive"
    fi
else
    echo "❌ Qdrant: Not running"
fi

# Check build artifacts
if [ -f "$PROJECT_DIR/dist/server.js" ]; then
    echo "✅ MCP Server: Build artifacts present"
else
    echo "❌ MCP Server: Build artifacts missing (run: npm run build)"
fi

# Check MCP config
if [ -f "/Users/fitzy/.claude/mcp_config.json" ]; then
    if grep -q "memory" "/Users/fitzy/.claude/mcp_config.json"; then
        echo "✅ MCP Config: Memory server configured"
    else
        echo "⚠️  MCP Config: Memory server not configured"
    fi
else
    echo "❌ MCP Config: Not found"
fi

echo ""
echo "📊 Memory System Status: Ready"
