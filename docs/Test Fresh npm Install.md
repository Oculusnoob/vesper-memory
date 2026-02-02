  # Test Fresh npm Install

  1. Pack the npm package (creates a tarball like npm would)

  cd /Users/fitzy/Documents/MemoryProject \
  npm run build \
  npm pack

  This creates a tarball like vesper-memory-0.1.0.tgz

  2. Clean up existing installation

  # Remove global install
  npm uninstall -g vesper

  # Remove installation directory
  rm -rf ~/.vesper

  # Backup and remove MCP config (optional - only if you want clean slate)
  cp ~/.claude/mcp_config.json ~/.claude/mcp_config.json.backup.test
  cp ~/.claude/settings.json ~/.claude/settings.json.backup.test

  # Remove Vesper from configs
  python3 -c "
  import json
  # Remove from mcp_config.json
  with open('$HOME/.claude/mcp_config.json') as f:
      config = json.load(f)
  if 'vesper' in config.get('mcpServers', {}):
      del config['mcpServers']['vesper']
      with open('$HOME/.claude/mcp_config.json', 'w') as f:
          json.dump(config, f, indent=2)

  # Remove from settings.json
  with open('$HOME/.claude/settings.json') as f:
      settings = json.load(f)
  if 'mcp__vesper' in settings.get('permissions', {}).get('allow', []):
      settings['permissions']['allow'].remove('mcp__vesper')
      with open('$HOME/.claude/settings.json', 'w') as f:
          json.dump(settings, f, indent=2)
  "

  3. Install from the tarball (simulates npm install)

  npm install -g ./vesper-memory-0.1.0.tgz

  This will:
  - ✅ Run npm install (dependencies)
  - ✅ Run npm run build if needed
  - ✅ Run scripts/postinstall.js
  - ✅ Call vesper configure
  - ✅ Update mcp_config.json
  - ✅ Update settings.json with permissions ⭐ (NEW!)

  4. Verify the installation

  # Check MCP config
  cat ~/.claude/mcp_config.json | python3 -m json.tool | grep -A10 vesper

  # Check permissions (CRITICAL!)
  grep -A5 '"permissions"' ~/.claude/settings.json

  # Should show:
  # "permissions": {
  #   "allow": [
  #     ...
  #     "mcp__vesper",
  #     ...
  #   ]
  # }

  # Check Vesper CLI is available
  which vesper
  vesper status

  5. Start services and test

  # Full installation (Docker + MCP)
  vesper install

  # Or just start services
  cd ~/.vesper
  docker-compose up -d redis qdrant embedding

  # Check service health
  vesper status

  6. Test with Claude Code

  # Restart Claude Code (quit completely and reopen)

  # Check debug logs for Vesper
  grep -i "vesper" ~/.claude/debug/latest

  # Should see:
  # MCP server "vesper": Starting connection
  # MCP server "vesper": Successfully connected

  Quick Validation Checklist

  After npm install -g ./vesper-memory-0.1.0.tgz:

  - ~/.claude/mcp_config.json has vesper entry
  - ~/.claude/settings.json has "mcp__vesper" in permissions.allow ⭐
  - vesper command is available globally
  - ~/.vesper/ directory exists with all files
  - Claude Code loads Vesper after restart

  If permissions.allow includes mcp__vesper, the fix worked! 🎉
