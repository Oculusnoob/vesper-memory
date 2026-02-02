# Installation Method Update

## Summary

Updated all Vesper installation methods to use the official `claude mcp add` CLI command instead of manually editing MCP configuration JSON files. This follows the [official MCP documentation](https://code.claude.com/docs/mcp).

## Changes Made

### 1. `install.sh` - Shell Installation Script
**Location**: `/install.sh`

**Before**: Manually edited `~/.claude/mcp_config.json` using Python script

**After**: Uses `claude mcp add --transport stdio --scope user vesper`

**Key Changes**:
- Checks for `claude` CLI availability
- Removes old server before adding (ensures clean install)
- Uses `--scope user` so Vesper is available across all projects
- Falls back to manual instructions if `claude` CLI not found

### 2. `src/cli.ts` - TypeScript CLI Tool
**Location**: `/src/cli.ts`

**Functions Updated**:

#### `install()` function
- **Before**: Manually wrote to `~/.claude/mcp_config.json`
- **After**: Executes `claude mcp add --transport stdio --scope user`
- **Note**: Still configures startup hooks in settings.json (for Docker auto-start)

#### `configure()` function
- **Before**: Manually wrote complex env config to `~/.claude/mcp_config.json`
- **After**: Builds `--env` flags and executes `claude mcp add` with all environment variables
- **Removed**: Manual permissions manipulation (handled by Claude CLI)

#### `uninstall()` function
- **Before**: Manually deleted from `~/.claude/mcp_config.json`
- **After**: Uses `claude mcp remove vesper`

#### `enableVesper()` function
- **Before**: Modified JSON to set `VESPER_ENABLED=true`
- **After**: Re-runs `configure()` to add the MCP server

#### `disableVesper()` function
- **Before**: Modified JSON to set `VESPER_ENABLED=false`
- **After**: Uses `claude mcp remove vesper`

#### `status()` function
- **Before**: Read and parsed `~/.claude/mcp_config.json`
- **After**: Uses `claude mcp get vesper` to check configuration

### 3. `README.md` - Documentation
**Location**: `/README.md`

**Sections Updated**:

#### Quick Start - npm install method
- Added explanation of what the installer does
- Shows it uses `claude mcp add --scope user`
- Added restart requirement

#### Manual Installation
- Updated to show proper `claude mcp add` command
- Uses `--scope user` for cross-project availability
- Removed JSON editing instructions

#### Development Setup
- Added step 6 with `claude mcp add --scope local` (project-specific)
- Uses `$(pwd)` to reference current directory
- Sets `NODE_ENV=development` for dev mode

#### Production Deployment
- Added step 10 with proper MCP configuration
- Noted that HTTP transport would require future enhancement
- Provided both local and remote access patterns

## Installation Scope Strategy

### User Scope (`--scope user`)
- **Used by**: npm install, manual install
- **Location**: `~/.claude.json`
- **Availability**: All projects for the current user
- **Best for**: Personal Vesper installation

### Local Scope (`--scope local`)
- **Used by**: Development setup
- **Location**: `~/.claude.json` under project path
- **Availability**: Current project only
- **Best for**: Project-specific development

### Project Scope (`--scope project`)
- **Not used**: Would create `.mcp.json` in project root
- **Requires**: Team approval prompts
- **Best for**: Shared team configurations (future consideration)

## Installation Directory

All methods install to: `~/.vesper` (user's home directory)
- Consistent location across all installation methods
- Can be overridden with `VESPER_INSTALL_DIR` environment variable

## Testing Checklist

### 1. Test Shell Script Installation
```bash
cd ~/.vesper
./install.sh
# Should run 'claude mcp add' command
# Check: claude mcp list
```

### 2. Test npm CLI Installation
```bash
npm install -g vesper-memory
vesper install
# Should run 'claude mcp add' command
# Check: claude mcp list
```

### 3. Test Manual Installation
```bash
git clone <repo> ~/.vesper
cd ~/.vesper
npm install && npm run build
claude mcp add --transport stdio --scope user --env NODE_ENV=production vesper -- node ~/.vesper/dist/server.js
# Check: claude mcp list
```

### 4. Test Development Setup
```bash
git clone <repo> ~/vesper-dev
cd ~/vesper-dev
npm install && npm run build
docker-compose up -d
claude mcp add --transport stdio --scope local --env NODE_ENV=development vesper -- node $(pwd)/dist/server.js
# Check: claude mcp list
```

### 5. Test CLI Commands
```bash
vesper status          # Should use 'claude mcp get vesper'
vesper disable         # Should use 'claude mcp remove vesper'
vesper enable          # Should reconfigure and add server
vesper uninstall       # Should use 'claude mcp remove vesper'
```

## Breaking Changes

### Configuration Files No Longer Manually Edited
- `~/.claude/mcp_config.json` - Now managed by `claude mcp add`
- `~/.claude/settings.json` - Permissions auto-managed (hooks still manual)

### CLI Dependency
- **New requirement**: `claude` CLI must be in PATH
- **Failure mode**: Installation fails with helpful error message
- **Workaround**: Manual configuration still possible

### Enable/Disable Behavior Change
- **Before**: Modified `VESPER_ENABLED` environment variable
- **After**:
  - `disable` = Remove MCP server entirely
  - `enable` = Re-add MCP server with full configuration

## Backward Compatibility

### Existing Installations
- Old JSON configs will be backed up (timestamped `.backup` files)
- New installations use `claude mcp add` exclusively
- Running `vesper configure` will migrate to new method

### Migration Path
```bash
# For existing users with manual JSON configs:
vesper configure  # Migrates to claude mcp add method
```

## Benefits

### 1. Standards Compliance
- Follows official Claude Code MCP integration pattern
- Uses documented, supported API
- Future-proof against config format changes

### 2. Better Error Handling
- Claude CLI provides validation
- Automatic permission management
- Clear error messages

### 3. Simpler Code
- Removed ~150 lines of JSON manipulation code
- No need to parse/merge configurations
- Fewer edge cases to handle

### 4. Tool Discovery
- Users can use `claude mcp list` to see all servers
- `/mcp` command in Claude Code shows Vesper
- Consistent with other MCP servers

## Known Limitations

### 1. Environment Variable Complexity
The `configure()` function builds a long command with many `--env` flags. This is verbose but necessary to pass all configuration from `.env` file.

**Example**:
```bash
claude mcp add --transport stdio --scope user \
  --env REDIS_HOST=localhost \
  --env REDIS_PORT=6379 \
  --env QDRANT_URL=http://localhost:6333 \
  ... (20+ more env vars) \
  vesper -- node ~/.vesper/dist/server.js
```

### 2. No Partial Updates
Unlike manual JSON editing, you can't easily change just one environment variable. Must remove and re-add the entire server configuration.

**Workaround**: Run `vesper configure` again to update all settings.

### 3. Requires Claude CLI
Installation now depends on `claude` command being in PATH. This is an additional dependency but aligns with Claude Code's official tooling.

## Documentation Updates

All installation documentation has been updated:
- ✅ README.md - All three install methods
- ✅ CLAUDE.md - No changes needed (developer guide)
- ✅ install.sh - Uses `claude mcp add`
- ✅ src/cli.ts - All functions updated
- ✅ This document - INSTALLATION_UPDATE.md

## Next Steps

1. **Test all installation methods** (see Testing Checklist above)
2. **Update package.json version** when ready to publish
3. **Create migration guide** for existing users
4. **Consider**: HTTP transport for remote access (future enhancement)

---

**Status**: ✅ Implementation Complete
**Testing**: Required before release
**Breaking Changes**: Yes (requires `claude` CLI)
**Migration Required**: Automatic on next `vesper configure`
