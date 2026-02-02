# Vesper Fresh Install Test Guide

## 📦 Package Created

Your Vesper npm package is ready:
- **File:** `vesper-0.1.0.tgz`
- **Size:** 134 KB
- **Location:** `/Users/fitzy/Documents/MemoryProject/vesper-0.1.0.tgz`

## 🧹 Step 1: Complete Uninstall

Run these commands to completely remove the existing installation:

```bash
# Stop all Docker services
cd /Users/fitzy/Documents/MemoryProject
docker-compose down -v

# Verify all containers are stopped
docker ps -a | grep vesper

# Remove any lingering containers (if any exist)
docker-compose rm -f

# Remove Docker volumes (optional - removes all data)
docker volume ls | grep vesper
# If you want to start completely fresh, remove volumes:
# docker volume rm vesper_redis_data vesper_qdrant_data vesper_postgres_data

# Remove MCP config entry
# Backup first
cp ~/.claude/mcp_config.json ~/.claude/mcp_config.json.backup

# Edit config to remove "vesper" and "memory" entries
# You can do this manually or use this command:
cat ~/.claude/mcp_config.json | jq 'del(.mcpServers.vesper, .mcpServers.memory)' > ~/.claude/mcp_config.json.tmp
mv ~/.claude/mcp_config.json.tmp ~/.claude/mcp_config.json

# Verify it's removed
cat ~/.claude/mcp_config.json | jq '.mcpServers'

# If you had installed globally (which you haven't yet), you would:
# npm uninstall -g vesper

# Clean npm cache (optional but recommended)
npm cache clean --force
```

## 🆕 Step 2: Fresh Install from Package

Now install Vesper from the local package tarball:

```bash
# Install globally from the tarball
npm install -g /Users/fitzy/Documents/MemoryProject/vesper-0.1.0.tgz

# Verify installation
which vesper
which vesper-server

# Check version
vesper --help
```

Expected output:
```
Vesper - AI Memory System for Claude Code

USAGE:
  vesper <command>

COMMANDS:
  install      Install Vesper and configure Claude Code (full setup)
  configure    Configure MCP server only (no Docker setup)
  uninstall    Remove Vesper completely
  status       Show installation and service status
  help         Show this help message
```

## 🐳 Step 3: Run Full Installation (with Docker)

This will set up Docker services AND configure the MCP server:

```bash
# Run the full install command
vesper install
```

**What this does:**
1. ✅ Creates installation directory at `~/.vesper`
2. ✅ Copies all files (config, docker-compose.yml, etc.)
3. ✅ Creates `.env` configuration
4. ✅ Installs npm dependencies
5. ✅ Starts Docker services (Redis, Qdrant, Embedding)
6. ✅ Configures MCP in `~/.claude/mcp_config.json`

**Expected output:**
```
🌟 Installing Vesper - AI Memory System for Claude Code

ℹ️  Checking prerequisites...
✅ Node.js found
✅ Docker found

ℹ️  Installing to /Users/fitzy/.vesper...
ℹ️  Copying files...
✅ Files copied

ℹ️  Creating .env configuration...
✅ .env created

ℹ️  Installing dependencies...
✅ Dependencies installed

ℹ️  Starting infrastructure services...
✅ Services started

ℹ️  Waiting for services to be ready...

ℹ️  Configuring Claude Code MCP integration...
ℹ️  Backed up existing config to /Users/fitzy/.claude/mcp_config.json.backup.XXXXXXXXXX
✅ MCP config updated

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ ✨ Vesper installation complete!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 Next steps:
   1. Restart Claude Code to load Vesper
   2. Ask Claude: "What MCP servers are available?"
   3. Test it: "Store a memory: I love TypeScript"

📖 Documentation:
   • Config: /Users/fitzy/.claude/mcp_config.json
   • Logs: cd /Users/fitzy/.vesper && docker-compose logs

💡 Tip: Ask Claude to "store a memory" to test!
```

## ✅ Step 4: Verify Docker Services

Check that all Docker services are running:

```bash
# Check service status
vesper status

# Or manually check Docker
cd ~/.vesper
docker-compose ps

# Should see these services running:
# - redis (healthy)
# - qdrant (healthy)
# - embedding (healthy)
# - postgres (healthy)
# - nginx (running)
# - prometheus (running)
# - grafana (healthy)
# - alertmanager (running)

# Check service logs
docker-compose logs -f redis
docker-compose logs -f qdrant
docker-compose logs -f embedding

# Press Ctrl+C to exit logs
```

Expected status output:
```
📊 Vesper Status

📁 Installation: /Users/fitzy/.vesper
✅ Installed

🤖 MCP Configuration:
✅ Configured in Claude Code

🐳 Docker Services:
✅ redis: running
✅ qdrant: running
✅ embedding: running
✅ postgres: running
```

## 🔧 Step 5: Verify MCP Configuration

Check that Vesper is properly configured:

```bash
# View MCP config
cat ~/.claude/mcp_config.json | jq '.mcpServers.vesper'
```

Expected output:
```json
{
  "command": "vesper-server",
  "args": [],
  "env": {
    "NODE_ENV": "production"
  }
}
```

The config should use the simple `vesper-server` command (not a full path).

## 🚀 Step 6: Test with Claude Code

1. **Restart Claude Code** (completely quit and restart)

2. **Check your statusline** - You should see:
   ```
   Sonnet 4.5 ~/YourProject main ctx:XX% Vesper ●
                                              ^pink  ^green
   ```
   The green dot means all services are ready!

3. **Test storing a memory:**
   ```
   Store a memory: Vesper uses BGE-large embeddings for semantic search
   ```

4. **Test retrieving:**
   ```
   What do you remember about embeddings?
   ```

5. **Check MCP server logs:**
   If you want to see what's happening behind the scenes:
   ```bash
   # The MCP server runs via Claude Code's stdio
   # Check Claude Code's debug logs or the server wrapper output
   ```

## 🐛 Troubleshooting

### Docker Services Won't Start

```bash
# Check Docker is running
docker info

# Start Docker Desktop if needed

# Try starting services manually
cd ~/.vesper
docker-compose up -d redis qdrant embedding

# Check for port conflicts
lsof -i :6379  # Redis
lsof -i :6333  # Qdrant
lsof -i :8000  # Embedding
```

### MCP Server Not Working

```bash
# Test the server wrapper manually
cd ~/.vesper
node dist/server-wrapper.js

# Should show service status and start server
# Press Ctrl+C to exit
```

Expected wrapper output:
```
ℹ️  Working directory: /Users/fitzy/.vesper
ℹ️  Checking required services...
✅ redis: Running and healthy
✅ qdrant: Running and healthy
✅ embedding: Running and healthy
ℹ️  Starting Vesper MCP server...
[INFO] Starting Vesper...
[INFO] Initializing connections to external services...
[INFO] ✅ Redis connected
[INFO] ✅ Redis ping successful
[INFO] SQLite database initialized at ./data/memory.db
[INFO] ✅ Embedding service connected: BAAI/bge-large-en-v1.5 (1024-dim)
[INFO] ✅ Qdrant hybrid search initialized
[INFO] ✅ Metrics collector initialized

============================================================
📊 Vesper Service Status:
============================================================
SQLite:           ✓ Ready (required)
Redis:            ✓ Ready (working memory, rate limiting)
Embedding:        ✓ Ready (semantic search)
Qdrant:           ✓ Ready (vector storage)
Rate Limiter:     ✓ Ready (requires Redis)
Metrics:          ✓ Ready (monitoring)
============================================================
```

### Statusline Shows Red Dot

```bash
# Check services
vesper status

# Restart services
cd ~/.vesper
docker-compose restart redis qdrant embedding

# Wait 10 seconds for health checks
sleep 10

# Statusline should update to green automatically
```

### "Command not found: vesper"

```bash
# Verify global installation
npm list -g vesper

# Check npm global bin directory is in PATH
npm config get prefix
# Should be in your $PATH

# Reinstall if needed
npm install -g /Users/fitzy/Documents/MemoryProject/vesper-0.1.0.tgz
```

## 🔄 Step 7: Test Degraded Mode

Verify graceful degradation works:

```bash
# Stop Redis
cd ~/.vesper
docker-compose stop redis

# Statusline should show yellow dot (degraded)
# MCP server should still work with reduced features

# Check server output shows degraded mode
# Restart to see the warning:
docker-compose start redis
```

## ✨ Success Checklist

After completing all steps, verify:

- [ ] `vesper --help` shows command help
- [ ] `vesper status` shows all services running
- [ ] `docker-compose ps` shows 13 services
- [ ] `cat ~/.claude/mcp_config.json | jq '.mcpServers.vesper'` shows config
- [ ] Claude Code statusline shows "Vesper ●" in neon pink with green dot
- [ ] You can store and retrieve memories in Claude Code
- [ ] Server logs show all services ready

## 📝 Notes

### Installation Directory

Vesper installs to: `~/.vesper/`
- Contains: `dist/`, `config/`, `docker-compose.yml`, `.env`, `data/`
- Can be changed with `VESPER_INSTALL_DIR` environment variable

### MCP Configuration

Location: `~/.claude/mcp_config.json`
- Backup created automatically
- Uses `vesper-server` global command
- Environment variables can be customized

### Data Persistence

Your data is stored in:
- `~/.vesper/data/memory.db` - SQLite database
- Docker volumes: `vesper_redis_data`, `vesper_qdrant_data`, `vesper_postgres_data`

To completely reset data:
```bash
cd ~/.vesper
docker-compose down -v
rm -rf data/
docker-compose up -d
```

## 🎉 Next Steps

Once everything is working:

1. **Test all MCP tools:**
   - `store_memory`
   - `retrieve_memory`
   - `list_recent`
   - `get_stats`

2. **Monitor services:**
   - Prometheus: http://localhost:9090
   - Grafana: http://localhost:3000 (admin/admin)

3. **Explore features:**
   - Semantic search with embeddings
   - Working memory cache
   - Conflict detection
   - Rate limiting

4. **Publish to npm:** (optional)
   ```bash
   npm publish vesper-0.1.0.tgz
   # Then anyone can: npm install -g vesper
   ```

## 📚 Documentation

- Main README: `/Users/fitzy/Documents/MemoryProject/README.md`
- MCP Wrapper: `/Users/fitzy/Documents/MemoryProject/docs/MCP_WRAPPER_IMPLEMENTATION.md`
- Statusline: `/Users/fitzy/Documents/MemoryProject/docs/STATUSLINE_INTEGRATION.md`
- Production Guide: `/Users/fitzy/Documents/MemoryProject/docs/PRODUCTION_READY_SUMMARY.md`
