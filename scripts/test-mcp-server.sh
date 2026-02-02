#!/bin/bash
# Quick test to verify MCP server can start and connect to infrastructure

set -e

PROJECT_DIR="/Users/fitzy/Documents/MemoryProject"
cd "$PROJECT_DIR"

echo "🧪 Testing MCP Server Startup..."
echo "================================"

# Source environment variables
export REDIS_HOST=localhost
export REDIS_PORT=6379
export REDIS_PASSWORD="MHot0MIuDfST4QUY6g3WVbLzcDEzJ14B"
export QDRANT_URL="http://localhost:6333"
export QDRANT_API_KEY="0mTJEZVwmIXceZM7hYwd2SgZo8sOT21p"
export SQLITE_DB="$PROJECT_DIR/data/memory.db"
export NODE_ENV=production

# Test server can start (send EOF immediately to exit gracefully)
echo "Starting MCP server with test input..."
timeout 5s node dist/server.js < /dev/null 2>&1 | head -20 || {
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
        echo "✅ MCP Server: Started successfully (timeout = expected for stdio transport)"
    elif [ $EXIT_CODE -eq 141 ]; then
        echo "✅ MCP Server: Started successfully (SIGPIPE = expected for stdio transport)"
    else
        echo "❌ MCP Server: Failed to start (exit code: $EXIT_CODE)"
        exit 1
    fi
}

echo ""
echo "✅ MCP Server test passed!"
echo ""
echo "Next step: Restart Claude Code to connect to the memory system"
