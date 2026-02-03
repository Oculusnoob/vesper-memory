#!/usr/bin/env node

/**
 * Vesper CLI
 *
 * Command-line interface for installing and managing Vesper
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Installation directory
const INSTALL_DIR = process.env.VESPER_INSTALL_DIR || join(homedir(), '.vesper');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function header(message: string) {
  log(`\n${message}`, colors.bright + colors.cyan);
}

function success(message: string) {
  log(`✅ ${message}`, colors.green);
}

function error(message: string) {
  log(`❌ ${message}`, colors.red);
}

function warning(message: string) {
  log(`⚠️  ${message}`, colors.yellow);
}

function info(message: string) {
  log(`ℹ️  ${message}`, colors.blue);
}

// Generate secure random password
function generatePassword(): string {
  return randomBytes(32).toString('base64');
}

// Check if Docker is running
function checkDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Install Vesper
async function install() {
  header('🌟 Installing Vesper - AI Memory System for Claude Code');

  // Check prerequisites
  info('Checking prerequisites...');

  try {
    execSync('node --version', { stdio: 'ignore' });
    success('Node.js found');
  } catch {
    error('Node.js 20+ required. Install from https://nodejs.org');
    process.exit(1);
  }

  if (!checkDocker()) {
    error('Docker not running. Please start Docker Desktop');
    process.exit(1);
  }
  success('Docker found');

  // Create installation directory
  info(`Installing to ${INSTALL_DIR}...`);

  if (existsSync(INSTALL_DIR)) {
    warning(`Directory ${INSTALL_DIR} already exists`);
    info('Updating existing installation...');
  } else {
    mkdirSync(INSTALL_DIR, { recursive: true });
  }

  // Copy files from npm package to install directory
  const packageRoot = join(__dirname, '..');

  info('Copying files...');
  const filesToCopy = [
    'dist',
    'config',
    'embedding-service',
    'scripts',
    'docker-compose.yml',
    '.env.example',
    'package.json',
  ];

  for (const file of filesToCopy) {
    const src = join(packageRoot, file);
    const dest = join(INSTALL_DIR, file);

    if (existsSync(src)) {
      cpSync(src, dest, { recursive: true });
    }
  }
  success('Files copied');

  // Create .env if it doesn't exist
  const envFile = join(INSTALL_DIR, '.env');
  if (!existsSync(envFile)) {
    info('Creating .env configuration...');
    cpSync(join(INSTALL_DIR, '.env.example'), envFile);
    success('.env created');
  }

  // Install dependencies in install directory
  info('Installing dependencies...');
  try {
    execSync('npm install --production --silent', {
      cwd: INSTALL_DIR,
      stdio: 'inherit',
    });
    success('Dependencies installed');
  } catch (err) {
    error('Failed to install dependencies');
    throw err;
  }

  // Start Docker services (3 services: redis, qdrant, embedding)
  info('Starting infrastructure services...');
  try {
    execSync('docker-compose up -d', {
      cwd: INSTALL_DIR,
      stdio: 'inherit',
    });
    success('Services started (redis, qdrant, embedding)');
  } catch (err) {
    error('Failed to start services');
    throw err;
  }

  // Wait for services
  info('Waiting for services to be ready...');
  await new Promise(resolve => setTimeout(resolve, 10000));

  // Configure MCP using the official claude CLI
  info('Configuring Claude Code MCP integration...');

  // Check if claude CLI is available
  try {
    execSync('claude --version', { stdio: 'ignore' });
  } catch {
    error('Claude Code CLI not found in PATH');
    error('Please install Claude Code from: https://claude.ai/download');
    throw new Error('Claude CLI not found');
  }

  // Remove old MCP server if it exists (to ensure clean install)
  try {
    execSync('claude mcp remove vesper', { stdio: 'ignore' });
  } catch {
    // Ignore errors if server doesn't exist
  }

  // Add Vesper using the proper claude mcp add command
  const serverPath = join(INSTALL_DIR, 'dist', 'server.js');

  try {
    execSync(
      `claude mcp add vesper --transport stdio --scope user -e NODE_ENV=production -- node "${serverPath}"`,
      { stdio: 'inherit' }
    );
    success('MCP server configured successfully');
  } catch (err) {
    error('Failed to configure Vesper MCP server');
    error(`You can manually configure it later with:`);
    error(`claude mcp add vesper --transport stdio --scope user -e NODE_ENV=production -- node "${serverPath}"`);
    throw err;
  }

  // Configure startup hook (optional - ensures Docker services are running)
  info('Configuring startup hook...');

  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let settings: any = { hooks: {} };

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch (err) {
      warning('Could not parse settings.json, creating new one');
      settings = { hooks: {} };
    }
  }

  // Ensure hooks structure exists
  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = settings.hooks.SessionStart || [];

  // Add or update Vesper startup hook (just for Docker services)
  const hookScript = join(INSTALL_DIR, 'scripts', 'ensure-infrastructure.sh');
  const vesperHook = {
    description: 'Ensure Vesper memory infrastructure is running',
    hooks: [{
      type: 'command',
      command: `if [ -f ${hookScript} ]; then ${hookScript} 2>&1; fi`,
      continueOnError: true
    }]
  };

  // Remove any existing Vesper hooks and add new one
  settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
    (h: any) => !h.description?.includes('Vesper') && !h.description?.includes('memory infrastructure')
  );
  settings.hooks.SessionStart.push(vesperHook);

  // Ensure directory exists
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  success('Startup hook configured');
  info('Note: Permissions are handled automatically by claude mcp add');

  // Success message
  header('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  success('✨ Vesper installation complete!');
  header('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  log('\n🎯 Next steps:', colors.bright);
  log('   1. Restart Claude Code to load Vesper');
  log('   2. Ask Claude: "What MCP servers are available?"');
  log('   3. Test it: "Store a memory: I love TypeScript"');

  log('\n📖 Documentation:', colors.bright);
  log(`   • Installation: ${INSTALL_DIR}`);
  log(`   • View config: claude mcp get vesper`);
  log(`   • Logs: cd ${INSTALL_DIR} && docker-compose logs`);

  log('\n💡 Tip: Ask Claude to "store a memory" to test!\n');
}

// Uninstall Vesper
async function uninstall() {
  header('🗑️  Uninstalling Vesper');

  if (!existsSync(INSTALL_DIR)) {
    warning('Vesper not installed');
    return;
  }

  // Stop services
  info('Stopping services...');
  try {
    execSync('docker-compose down -v', {
      cwd: INSTALL_DIR,
      stdio: 'inherit',
    });
    success('Services stopped');
  } catch {
    warning('Could not stop services (may not be running)');
  }

  // Remove from MCP config using claude CLI
  info('Removing from MCP config...');
  try {
    execSync('claude mcp remove vesper', { stdio: 'inherit' });
    success('Removed from MCP config');
  } catch {
    warning('Could not remove from MCP config (may not be configured)');
  }

  // Remove startup hook
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    info('Removing startup hook...');
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.hooks?.SessionStart) {
        settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
          (h: any) => !h.description?.includes('Vesper') && !h.description?.includes('memory infrastructure')
        );
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        success('Startup hook removed');
      }
    } catch (err) {
      warning('Could not update settings.json');
    }
  }

  // Remove installation directory
  info('Removing files...');
  try {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    success('Files removed');
  } catch (err) {
    error(`Failed to remove ${INSTALL_DIR}: ${err instanceof Error ? err.message : String(err)}`);
  }

  log('\n✅ Vesper uninstalled successfully\n');
  info('Restart Claude Code to complete removal');
}

// Load environment variables from .env file
// If .env doesn't exist, create it from .env.example with secure generated passwords
function loadEnvFile(packageRoot: string): Record<string, string> {
  const envPath = join(packageRoot, '.env');
  const envExamplePath = join(packageRoot, '.env.example');

  let envContent: string;
  let shouldGeneratePasswords = false;

  if (!existsSync(envPath)) {
    if (existsSync(envExamplePath)) {
      info('Creating .env from .env.example...');
      envContent = readFileSync(envExamplePath, 'utf-8');
      shouldGeneratePasswords = true;
    } else {
      warning('.env and .env.example not found, using default values');
      return {};
    }
  } else {
    envContent = readFileSync(envPath, 'utf-8');
  }

  const env: Record<string, string> = {};

  // Parse environment variables
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const [, key, value] = match;
        env[key.trim()] = value.trim();
      }
    }
  }

  // Generate secure passwords if creating new .env
  if (shouldGeneratePasswords) {
    info('Generating secure passwords...');

    const redisPassword = generatePassword();
    const qdrantKey = generatePassword();
    const postgresPassword = generatePassword();

    // Replace placeholder passwords in content
    envContent = envContent.replace(
      /REDIS_PASSWORD=.*/,
      `REDIS_PASSWORD=${redisPassword}`
    );
    envContent = envContent.replace(
      /QDRANT_API_KEY=.*/,
      `QDRANT_API_KEY=${qdrantKey}`
    );
    envContent = envContent.replace(
      /POSTGRES_PASSWORD=.*/,
      `POSTGRES_PASSWORD=${postgresPassword}`
    );

    // Write new .env file
    writeFileSync(envPath, envContent);
    success('.env created with secure passwords');

    // Update env object with generated passwords
    env.REDIS_PASSWORD = redisPassword;
    env.QDRANT_API_KEY = qdrantKey;
    env.POSTGRES_PASSWORD = postgresPassword;
  }

  return env;
}

// Configure MCP only (no Docker services)
async function configure() {
  header('⚙️  Configuring Vesper MCP Server');

  // Determine package location (could be in node_modules or ~/.vesper)
  const packageRoot = dirname(dirname(__filename));
  const serverPath = join(packageRoot, 'dist', 'server.js');

  if (!existsSync(serverPath)) {
    error(`Server not found at ${serverPath}`);
    error('Run "npm run build" first');
    process.exit(1);
  }

  info('Loading environment configuration...');
  const envVars = loadEnvFile(packageRoot);

  // Resolve SQLite DB path relative to package root
  const sqliteDb = envVars.SQLITE_DB || './data/memory.db';
  const absoluteSqliteDb = sqliteDb.startsWith('/')
    ? sqliteDb
    : join(packageRoot, sqliteDb);

  info('Configuring Claude Code MCP integration...');

  // Check if claude CLI is available
  try {
    execSync('claude --version', { stdio: 'ignore' });
  } catch {
    error('Claude Code CLI not found in PATH');
    error('Please install Claude Code from: https://claude.ai/download');
    throw new Error('Claude CLI not found');
  }

  // Remove old MCP server if it exists (to ensure clean install)
  try {
    execSync('claude mcp remove vesper', { stdio: 'ignore' });
  } catch {
    // Ignore errors if server doesn't exist
  }

  // Build environment variable flags (use -e for each variable)
  const envFlags = [
    // Connection settings
    `-e REDIS_HOST=${envVars.REDIS_HOST || 'localhost'}`,
    `-e REDIS_PORT=${envVars.REDIS_PORT || '6379'}`,
    `-e QDRANT_URL=${envVars.QDRANT_URL || 'http://localhost:6333'}`,
    `-e SQLITE_DB=${absoluteSqliteDb}`,
    `-e EMBEDDING_SERVICE_URL=${envVars.EMBEDDING_SERVICE_URL || 'http://localhost:8000'}`,

    // PostgreSQL (optional, for auth)
    `-e POSTGRES_HOST=${envVars.POSTGRES_HOST || 'localhost'}`,
    `-e POSTGRES_PORT=${envVars.POSTGRES_PORT || '5432'}`,
    `-e POSTGRES_DB=${envVars.POSTGRES_DB || 'memory'}`,
    `-e POSTGRES_USER=${envVars.POSTGRES_USER || 'postgres'}`,

    // Application settings
    `-e NODE_ENV=${envVars.NODE_ENV || 'production'}`,
    `-e LOG_LEVEL=${envVars.LOG_LEVEL || 'info'}`,

    // Authentication (optional)
    `-e AUTH_ENABLED=${envVars.AUTH_ENABLED || 'false'}`,
    `-e MCP_API_KEY_TIER=${envVars.MCP_API_KEY_TIER || 'standard'}`,
    `-e MCP_API_KEY_SCOPES=${envVars.MCP_API_KEY_SCOPES || '*'}`,

    // Rate limiting
    `-e RATE_LIMIT_DEFAULT_TIER=${envVars.RATE_LIMIT_DEFAULT_TIER || 'standard'}`,
    `-e RATE_LIMIT_FAIL_OPEN=${envVars.RATE_LIMIT_FAIL_OPEN || 'false'}`,
  ];

  // Add password environment variables only if they're set (don't expose empty passwords)
  if (envVars.REDIS_PASSWORD) {
    envFlags.push(`-e REDIS_PASSWORD=${envVars.REDIS_PASSWORD}`);
  }
  if (envVars.QDRANT_API_KEY) {
    envFlags.push(`-e QDRANT_API_KEY=${envVars.QDRANT_API_KEY}`);
  }
  if (envVars.POSTGRES_PASSWORD) {
    envFlags.push(`-e POSTGRES_PASSWORD=${envVars.POSTGRES_PASSWORD}`);
  }
  if (envVars.MCP_API_KEY_HASH) {
    envFlags.push(`-e MCP_API_KEY_HASH=${envVars.MCP_API_KEY_HASH}`);
  }
  if (envVars.MCP_API_KEY_USER_ID) {
    envFlags.push(`-e MCP_API_KEY_USER_ID=${envVars.MCP_API_KEY_USER_ID}`);
  }

  // Add Vesper using the proper claude mcp add command
  // Note: server name must come FIRST, then options
  const command = `claude mcp add vesper --transport stdio --scope user ${envFlags.join(' ')} -- node "${serverPath}"`;

  try {
    execSync(command, { stdio: 'inherit' });
    success('MCP server configured successfully');
  } catch (err) {
    error('Failed to configure Vesper MCP server');
    error(`You can manually configure it later with:`);
    error(command);
    throw err;
  }

  log(`\n📍 Server path: ${serverPath}`);
  log(`📁 Package root: ${packageRoot}`);
  info('Permissions are handled automatically by claude mcp add');

  success('✨ Vesper MCP server configured!');
  log('\n🎯 Next steps:', colors.bright);
  log('   1. Ensure Docker services are running:');
  log(`      cd ${packageRoot} && docker-compose up -d`);
  log('   2. Restart Claude Code to load Vesper');
  log('   3. Test: Ask Claude "What MCP servers are available?"\n');
}

// Enable Vesper
async function enableVesper() {
  header('✅ Enabling Vesper Memory System');

  if (!existsSync(INSTALL_DIR)) {
    error('Vesper not installed');
    log('\nRun: vesper install');
    return;
  }

  // Re-run configure to enable (this will add the MCP server)
  info('Reconfiguring Vesper to enable...');
  await configure();

  log('\n💡 Restart Claude Code for changes to take effect\n');
}

// Disable Vesper
async function disableVesper() {
  header('⏸️  Disabling Vesper Memory System');

  // Remove the MCP server to disable it
  info('Removing Vesper MCP server...');
  try {
    execSync('claude mcp remove vesper', { stdio: 'inherit' });
    success('Vesper memory system disabled');
  } catch {
    warning('Vesper not configured or already disabled');
  }

  log('\n📊 Useful for benchmarking or debugging');
  log('💡 Run "vesper enable" to re-enable');
  log('💡 Restart Claude Code for changes to take effect\n');
}

// Show status
function status() {
  header('📊 Vesper Status');

  // Check installation
  log(`\n📁 Installation: ${INSTALL_DIR}`);
  if (existsSync(INSTALL_DIR)) {
    success('Installed');
  } else {
    error('Not installed');
    log('\nRun: vesper install');
    return;
  }

  // Check MCP config using claude CLI
  log('\n🤖 MCP Configuration:');
  try {
    const output = execSync('claude mcp get vesper', { encoding: 'utf-8', stdio: 'pipe' });
    if (output.includes('"vesper"') || output.toLowerCase().includes('vesper')) {
      success('Configured in Claude Code ✅');
      success('Memory system: ENABLED');
    } else {
      warning('Not configured in Claude Code');
      log('   Run "vesper configure" to set up');
    }
  } catch {
    warning('Not configured in Claude Code');
    log('   Run "vesper configure" to set up');
  }

  // Check services
  log('\n🐳 Docker Services:');
  if (checkDocker()) {
    try {
      const output = execSync('docker-compose ps --format json', {
        cwd: INSTALL_DIR,
        encoding: 'utf-8',
      });

      const services = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

      for (const service of services) {
        if (service.State === 'running') {
          success(`${service.Service}: running`);
        } else {
          warning(`${service.Service}: ${service.State}`);
        }
      }
    } catch {
      warning('Could not check service status');
    }
  } else {
    error('Docker not running');
  }

  log('');
}

// Main CLI
const command = process.argv[2];

switch (command) {
  case 'install':
    install().catch((err) => {
      error(`Installation failed: ${err.message}`);
      process.exit(1);
    });
    break;

  case 'uninstall':
    uninstall().catch((err) => {
      error(`Uninstallation failed: ${err.message}`);
      process.exit(1);
    });
    break;

  case 'configure':
    configure().catch((err) => {
      error(`Configuration failed: ${err.message}`);
      process.exit(1);
    });
    break;

  case 'status':
    status();
    break;

  case 'enable':
    enableVesper().catch((err) => {
      error(`Enable failed: ${err.message}`);
      process.exit(1);
    });
    break;

  case 'disable':
    disableVesper().catch((err) => {
      error(`Disable failed: ${err.message}`);
      process.exit(1);
    });
    break;

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    log(`
${colors.bright}Vesper - AI Memory System for Claude Code${colors.reset}

${colors.bright}USAGE:${colors.reset}
  vesper <command>

${colors.bright}COMMANDS:${colors.reset}
  install      Install Vesper and configure Claude Code (full setup)
  configure    Configure MCP server only (no Docker setup)
  uninstall    Remove Vesper completely
  status       Show installation and service status
  enable       Enable Vesper memory system
  disable      Disable Vesper memory system (pass-through mode)
  help         Show this help message

${colors.bright}EXAMPLES:${colors.reset}
  vesper install       # Full installation with Docker setup
  vesper configure     # Configure MCP only (lightweight)
  vesper status        # Check if running
  vesper enable        # Enable memory system
  vesper disable       # Disable for benchmarking
  vesper uninstall     # Remove Vesper

${colors.bright}DOCUMENTATION:${colors.reset}
  https://github.com/fitz2882/vesper

${colors.bright}SUPPORT:${colors.reset}
  https://github.com/fitz2882/vesper/issues
`);
    break;

  default:
    error(`Unknown command: ${command}`);
    log('Run "vesper help" for usage');
    process.exit(1);
}
