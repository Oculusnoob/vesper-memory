#!/bin/bash
# Ensures Docker services are running for Memory MCP server

# Dynamically determine installation directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR" || exit 1

# Set VESPER_HOME for user-level storage (default: ~/.vesper)
# This is exported so docker-compose can use it for volume mounts
export VESPER_HOME="${VESPER_HOME:-$HOME/.vesper}"

# Create required directories before Docker starts
# Docker will fail to mount volumes if these directories don't exist
mkdir -p "$VESPER_HOME/data"
mkdir -p "$VESPER_HOME/docker-data/qdrant"
mkdir -p "$VESPER_HOME/docker-data/redis"
mkdir -p "$VESPER_HOME/logs"

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "⚠️  Docker is not running. Please start Docker Desktop."
    exit 0  # Exit gracefully - don't block Claude startup
fi

# Check if core services are healthy using docker ps directly
REDIS_HEALTHY=$(docker ps --filter "name=vesper-redis" --filter "health=healthy" --format "{{.Names}}" | wc -l | tr -d ' ')
QDRANT_HEALTHY=$(docker ps --filter "name=vesper-qdrant" --filter "health=healthy" --format "{{.Names}}" | wc -l | tr -d ' ')
EMBEDDING_HEALTHY=$(docker ps --filter "name=vesper-embedding" --filter "health=healthy" --format "{{.Names}}" | wc -l | tr -d ' ')

if [ "$REDIS_HEALTHY" = "0" ] || [ "$QDRANT_HEALTHY" = "0" ] || [ "$EMBEDDING_HEALTHY" = "0" ]; then
    echo "🚀 Starting Memory infrastructure..."
    # Use --no-recreate to avoid conflicts with existing containers
    # Suppress bcrypt hash variable warnings from .env file
    docker-compose up -d --no-recreate 2>&1 | grep -v "is not set. Defaulting" | grep -v "level=warning" || true
    sleep 3  # Give services time to initialize
    echo "✅ Memory infrastructure started"
else
    echo "✅ Memory infrastructure already running"
fi

# Verify build artifacts exist
if [ ! -f "$PROJECT_DIR/dist/server.js" ]; then
    echo "🔨 Building MCP server..."
    npm run build
fi

echo "✅ Memory system infrastructure ready"
exit 0
