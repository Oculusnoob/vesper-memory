/**
 * Health Monitoring Module
 *
 * Provides health checks for system components including:
 * - Certificate expiration monitoring
 * - Service health checks
 * - Resource utilization monitoring
 *
 * @module src/monitoring/health
 */

import * as fs from 'fs';
import * as tls from 'tls';

/**
 * Certificate status levels
 */
export type CertificateStatusLevel = 'valid' | 'warning' | 'critical' | 'expired' | 'error';

/**
 * Certificate expiration check result
 */
export interface CertificateStatus {
  status: CertificateStatusLevel;
  daysUntilExpiration: number;
  expirationDate: Date | null;
  shouldAlert: boolean;
  error?: string;
}

/**
 * Health check result interface
 */
export interface HealthCheckResult {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  details?: Record<string, unknown>;
  timestamp: Date;
}

/**
 * Options for certificate expiration check
 */
export interface CertificateCheckOptions {
  /** Path to the certificate file */
  certPath: string;
  /** Warning threshold in days (default: 14) */
  warningThresholdDays?: number;
  /** Critical threshold in days (default: 7) */
  criticalThresholdDays?: number;
  /** Mock expiration date for testing */
  mockExpirationDate?: Date;
}

/**
 * Options for remote certificate check
 */
export interface RemoteCertificateCheckOptions {
  /** Hostname to check */
  host: string;
  /** Port (default: 443) */
  port?: number;
  /** Warning threshold in days (default: 14) */
  warningThresholdDays?: number;
  /** Critical threshold in days (default: 7) */
  criticalThresholdDays?: number;
  /** Timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
}

/**
 * Parse PEM certificate and extract expiration date
 */
function parseCertificateExpiration(certPem: string): Date | null {
  try {
    // Use Node.js TLS to parse the certificate
    const _secureContext = tls.createSecureContext({ cert: certPem });
    // Get certificate details - this is a simplified approach
    // In production, use a library like node-forge for proper parsing

    // For now, try to extract the notAfter field using regex
    // This is a simplified implementation
    const notAfterMatch = certPem.match(/Not After\s*:\s*(.+)/i);
    if (notAfterMatch) {
      return new Date(notAfterMatch[1]);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check certificate expiration from file
 *
 * @param options - Check options including cert path and thresholds
 * @returns Certificate status with expiration information
 */
export async function checkCertificateExpiration(
  options: CertificateCheckOptions
): Promise<CertificateStatus> {
  const {
    certPath,
    warningThresholdDays = 14,
    criticalThresholdDays = 7,
    mockExpirationDate,
  } = options;

  // If mock date is provided (for testing), use it directly
  if (mockExpirationDate) {
    return calculateCertificateStatus(
      mockExpirationDate,
      warningThresholdDays,
      criticalThresholdDays
    );
  }

  // Try to read the certificate file
  try {
    if (!fs.existsSync(certPath)) {
      return {
        status: 'error',
        daysUntilExpiration: 0,
        expirationDate: null,
        shouldAlert: true,
        error: `Certificate file not found: ${certPath}`,
      };
    }

    const certPem = fs.readFileSync(certPath, 'utf-8');
    const expirationDate = parseCertificateExpiration(certPem);

    if (!expirationDate) {
      return {
        status: 'error',
        daysUntilExpiration: 0,
        expirationDate: null,
        shouldAlert: true,
        error: 'Could not parse certificate expiration date',
      };
    }

    return calculateCertificateStatus(
      expirationDate,
      warningThresholdDays,
      criticalThresholdDays
    );
  } catch (error) {
    return {
      status: 'error',
      daysUntilExpiration: 0,
      expirationDate: null,
      shouldAlert: true,
      error: error instanceof Error ? error.message : 'Unknown error reading certificate',
    };
  }
}

/**
 * Check certificate expiration from remote host
 *
 * @param options - Check options including host and thresholds
 * @returns Certificate status with expiration information
 */
export async function checkRemoteCertificateExpiration(
  options: RemoteCertificateCheckOptions
): Promise<CertificateStatus> {
  const {
    host,
    port = 443,
    warningThresholdDays = 14,
    criticalThresholdDays = 7,
    timeoutMs = 5000,
  } = options;

  return new Promise((resolve) => {
    const socket = tls.connect(
      port,
      host,
      { rejectUnauthorized: false, servername: host },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();

        if (!cert || !cert.valid_to) {
          resolve({
            status: 'error',
            daysUntilExpiration: 0,
            expirationDate: null,
            shouldAlert: true,
            error: 'Could not retrieve certificate from server',
          });
          return;
        }

        const expirationDate = new Date(cert.valid_to);
        resolve(
          calculateCertificateStatus(
            expirationDate,
            warningThresholdDays,
            criticalThresholdDays
          )
        );
      }
    );

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve({
        status: 'error',
        daysUntilExpiration: 0,
        expirationDate: null,
        shouldAlert: true,
        error: `Connection timeout after ${timeoutMs}ms`,
      });
    });

    socket.on('error', (error) => {
      resolve({
        status: 'error',
        daysUntilExpiration: 0,
        expirationDate: null,
        shouldAlert: true,
        error: error.message,
      });
    });
  });
}

/**
 * Calculate certificate status based on expiration date and thresholds
 */
function calculateCertificateStatus(
  expirationDate: Date,
  warningThresholdDays: number,
  criticalThresholdDays: number
): CertificateStatus {
  const now = new Date();
  const diffMs = expirationDate.getTime() - now.getTime();
  const daysUntilExpiration = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  let status: CertificateStatusLevel;
  let shouldAlert: boolean;

  if (daysUntilExpiration < 0) {
    status = 'expired';
    shouldAlert = true;
  } else if (daysUntilExpiration <= criticalThresholdDays) {
    status = 'critical';
    shouldAlert = true;
  } else if (daysUntilExpiration <= warningThresholdDays) {
    status = 'warning';
    shouldAlert = true;
  } else {
    status = 'valid';
    shouldAlert = false;
  }

  return {
    status,
    daysUntilExpiration,
    expirationDate,
    shouldAlert,
  };
}

/**
 * Comprehensive health check for all services
 */
export async function runHealthChecks(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  // Check certificate expiration if configured
  const certPath = process.env.SSL_CERT_PATH;
  if (certPath) {
    const certStatus = await checkCertificateExpiration({ certPath });
    results.push({
      name: 'ssl_certificate',
      status: certStatus.status === 'valid' ? 'healthy' :
              certStatus.status === 'warning' ? 'degraded' : 'unhealthy',
      message: `Certificate ${certStatus.status}. Days until expiration: ${certStatus.daysUntilExpiration}`,
      details: {
        expirationDate: certStatus.expirationDate?.toISOString(),
        daysUntilExpiration: certStatus.daysUntilExpiration,
        shouldAlert: certStatus.shouldAlert,
      },
      timestamp: new Date(),
    });
  }

  return results;
}

/**
 * Alert configuration for certificate monitoring
 */
export interface AlertConfig {
  /** Slack webhook URL for alerts */
  slackWebhook?: string;
  /** Email recipients for alerts */
  emailRecipients?: string[];
  /** PagerDuty service key for critical alerts */
  pagerDutyKey?: string;
}

/**
 * Send alert for certificate expiration
 */
export async function sendCertificateAlert(
  status: CertificateStatus,
  config: AlertConfig
): Promise<void> {
  const message = formatAlertMessage(status);

  // Log to stderr for monitoring
  console.error(JSON.stringify({
    type: 'certificate_alert',
    level: status.status,
    message,
    expirationDate: status.expirationDate?.toISOString(),
    daysUntilExpiration: status.daysUntilExpiration,
    timestamp: new Date().toISOString(),
  }));

  // Slack notification
  if (config.slackWebhook && status.shouldAlert) {
    try {
      await fetch(config.slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: message,
          attachments: [{
            color: status.status === 'critical' || status.status === 'expired' ? 'danger' : 'warning',
            fields: [
              { title: 'Status', value: status.status, short: true },
              { title: 'Days Remaining', value: status.daysUntilExpiration.toString(), short: true },
              { title: 'Expiration Date', value: status.expirationDate?.toISOString() || 'Unknown' },
            ],
          }],
        }),
      });
    } catch (error) {
      console.error('Failed to send Slack alert:', error);
    }
  }
}

/**
 * Format alert message based on status
 */
function formatAlertMessage(status: CertificateStatus): string {
  switch (status.status) {
    case 'expired':
      return `[CRITICAL] SSL Certificate has EXPIRED! Immediate action required.`;
    case 'critical':
      return `[CRITICAL] SSL Certificate expires in ${status.daysUntilExpiration} days! Renew immediately.`;
    case 'warning':
      return `[WARNING] SSL Certificate expires in ${status.daysUntilExpiration} days. Plan renewal soon.`;
    case 'error':
      return `[ERROR] Could not check SSL certificate: ${status.error}`;
    default:
      return `SSL Certificate is valid for ${status.daysUntilExpiration} more days.`;
  }
}

/**
 * Start periodic certificate monitoring
 */
export function startCertificateMonitoring(
  options: CertificateCheckOptions & { intervalMs?: number; alertConfig?: AlertConfig }
): NodeJS.Timeout {
  const { intervalMs = 3600000, alertConfig = {}, ...checkOptions } = options; // Default: 1 hour

  const check = async () => {
    const status = await checkCertificateExpiration(checkOptions);
    if (status.shouldAlert) {
      await sendCertificateAlert(status, alertConfig);
    }
  };

  // Run initial check
  check();

  // Schedule periodic checks
  return setInterval(check, intervalMs);
}

// ============================================================================
// NEW: Comprehensive Health Checker for Service Monitoring
// ============================================================================

import { createRequire } from "module";
import Redis from "ioredis";

const require = createRequire(import.meta.url);

/**
 * Component health status
 */
export type ComponentStatus = "healthy" | "unhealthy" | "degraded";

/**
 * Certificate status for health endpoint
 */
export type CertStatus = "healthy" | "warning" | "critical";

/**
 * Overall system health status
 */
export type SystemStatus = "healthy" | "degraded" | "unhealthy";

/**
 * Health check result for a single component
 */
export interface ComponentHealth {
  status: ComponentStatus;
  latency_ms: number;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * Certificate health information for health endpoint
 */
export interface CertificateHealthInfo {
  expiry_days: number;
  status: CertStatus;
}

/**
 * Complete health check result (new format for monitoring endpoint)
 */
export interface FullHealthCheckResult {
  status: SystemStatus;
  timestamp: string;
  components: Record<string, ComponentHealth>;
  certificates: CertificateHealthInfo;
}

/**
 * Configuration for individual service connections
 */
export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
}

export interface PostgresConfig {
  host: string;
  port: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface SqliteConfig {
  path: string;
}

export interface QdrantConfig {
  url: string;
  apiKey?: string;
}

export interface EmbeddingConfig {
  url: string;
}

/**
 * Health checker configuration
 */
export interface HealthCheckerConfig {
  redis?: RedisConfig;
  postgres?: PostgresConfig;
  sqlite?: SqliteConfig;
  qdrant?: QdrantConfig;
  embedding?: EmbeddingConfig;
}

/**
 * Health checker options
 */
export interface HealthCheckerOptions {
  /** Timeout for health checks in milliseconds (default: 5000) */
  timeout?: number;
}

/**
 * HealthChecker class for comprehensive system health monitoring
 */
export class HealthChecker {
  private config: HealthCheckerConfig;
  private options: HealthCheckerOptions;
  private certExpiryDays: number = 90; // Default: 90 days
  private redisClient?: Redis;
  private sqliteDb?: unknown;

  constructor(config: HealthCheckerConfig, options: HealthCheckerOptions = {}) {
    this.config = config;
    this.options = {
      timeout: options.timeout ?? 5000,
    };
  }

  /**
   * Set certificate expiry days (for testing or manual updates)
   */
  setCertExpiryDays(days: number): void {
    this.certExpiryDays = days;
  }

  /**
   * Perform comprehensive health check
   */
  async check(): Promise<FullHealthCheckResult> {
    const components: Record<string, ComponentHealth> = {};

    // Check all configured components in parallel
    const checks: Array<Promise<void>> = [];

    if (this.config.redis) {
      checks.push(
        this.checkRedis().then((result) => {
          components.redis = result;
        })
      );
    }

    if (this.config.postgres) {
      checks.push(
        this.checkPostgres().then((result) => {
          components.postgres = result;
        })
      );
    }

    if (this.config.sqlite) {
      checks.push(
        this.checkSqlite().then((result) => {
          components.sqlite = result;
        })
      );
    }

    if (this.config.qdrant) {
      checks.push(
        this.checkQdrant().then((result) => {
          components.qdrant = result;
        })
      );
    }

    if (this.config.embedding) {
      checks.push(
        this.checkEmbedding().then((result) => {
          components.embedding = result;
        })
      );
    }

    // Wait for all checks to complete
    await Promise.all(checks);

    // Determine overall status
    const status = this.determineOverallStatus(components);

    // Get certificate status
    const certificates = this.getCertificateHealthInfo();

    return {
      status,
      timestamp: new Date().toISOString(),
      components,
      certificates,
    };
  }

  /**
   * Check Redis connectivity
   */
  async checkRedis(): Promise<ComponentHealth> {
    if (!this.config.redis) {
      return { status: "unhealthy", latency_ms: 0, error: "Redis not configured" };
    }

    const startTime = performance.now();

    try {
      // Create a new connection with timeout
      const client = new Redis({
        host: this.config.redis.host,
        port: this.config.redis.port,
        password: this.config.redis.password,
        connectTimeout: this.options.timeout,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });

      // Set up a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Connection timeout")), this.options.timeout);
      });

      // Race between connection and timeout
      await Promise.race([
        client.connect().then(() => client.ping()),
        timeoutPromise,
      ]);

      const latency = performance.now() - startTime;

      // Clean up connection
      await client.quit();

      return {
        status: "healthy",
        latency_ms: Math.round(latency),
      };
    } catch (error) {
      const latency = performance.now() - startTime;
      return {
        status: "unhealthy",
        latency_ms: Math.round(latency),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check PostgreSQL connectivity
   */
  async checkPostgres(): Promise<ComponentHealth> {
    if (!this.config.postgres) {
      return { status: "unhealthy", latency_ms: 0, error: "PostgreSQL not configured" };
    }

    const startTime = performance.now();

    try {
      // Use TCP socket check for PostgreSQL
      const net = await import("net");

      const connected = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();

        socket.setTimeout(this.options.timeout!);

        socket.on("connect", () => {
          socket.destroy();
          resolve(true);
        });

        socket.on("timeout", () => {
          socket.destroy();
          resolve(false);
        });

        socket.on("error", () => {
          socket.destroy();
          resolve(false);
        });

        socket.connect(this.config.postgres!.port, this.config.postgres!.host);
      });

      const latency = performance.now() - startTime;

      if (connected) {
        return {
          status: "healthy",
          latency_ms: Math.round(latency),
        };
      } else {
        return {
          status: "unhealthy",
          latency_ms: Math.round(latency),
          error: "Connection failed",
        };
      }
    } catch (error) {
      const latency = performance.now() - startTime;
      return {
        status: "unhealthy",
        latency_ms: Math.round(latency),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check SQLite connectivity
   */
  async checkSqlite(): Promise<ComponentHealth> {
    if (!this.config.sqlite) {
      return { status: "unhealthy", latency_ms: 0, error: "SQLite not configured" };
    }

    const startTime = performance.now();

    try {
      // For :memory: database, just create a test connection
      const DatabaseConstructor = require("better-sqlite3");
      const db = new DatabaseConstructor(this.config.sqlite.path);

      // Run a simple query
      const result = db.prepare("SELECT 1 as test").get() as { test: number };
      db.close();

      const latency = performance.now() - startTime;

      if (result && result.test === 1) {
        return {
          status: "healthy",
          latency_ms: Math.round(latency),
        };
      } else {
        return {
          status: "unhealthy",
          latency_ms: Math.round(latency),
          error: "Query failed",
        };
      }
    } catch (error) {
      const latency = performance.now() - startTime;
      return {
        status: "unhealthy",
        latency_ms: Math.round(latency),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check Qdrant connectivity
   */
  async checkQdrant(): Promise<ComponentHealth> {
    if (!this.config.qdrant) {
      return { status: "unhealthy", latency_ms: 0, error: "Qdrant not configured" };
    }

    const startTime = performance.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.options.timeout);

      const headers: Record<string, string> = {};
      if (this.config.qdrant.apiKey) {
        headers["api-key"] = this.config.qdrant.apiKey;
      }

      const response = await fetch(`${this.config.qdrant.url}/healthz`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const latency = performance.now() - startTime;

      if (response.ok) {
        return {
          status: "healthy",
          latency_ms: Math.round(latency),
        };
      } else {
        return {
          status: "unhealthy",
          latency_ms: Math.round(latency),
          error: `HTTP ${response.status}`,
        };
      }
    } catch (error) {
      const latency = performance.now() - startTime;
      return {
        status: "unhealthy",
        latency_ms: Math.round(latency),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check Embedding service connectivity
   */
  async checkEmbedding(): Promise<ComponentHealth> {
    if (!this.config.embedding) {
      return { status: "unhealthy", latency_ms: 0, error: "Embedding service not configured" };
    }

    const startTime = performance.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.options.timeout);

      const response = await fetch(`${this.config.embedding.url}/health`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const latency = performance.now() - startTime;

      if (response.ok) {
        return {
          status: "healthy",
          latency_ms: Math.round(latency),
        };
      } else {
        return {
          status: "unhealthy",
          latency_ms: Math.round(latency),
          error: `HTTP ${response.status}`,
        };
      }
    } catch (error) {
      const latency = performance.now() - startTime;
      return {
        status: "unhealthy",
        latency_ms: Math.round(latency),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get certificate health status for health endpoint
   */
  private getCertificateHealthInfo(): CertificateHealthInfo {
    let status: CertStatus;

    if (this.certExpiryDays < 0) {
      status = "critical";
    } else if (this.certExpiryDays < 14) {
      status = "warning";
    } else {
      status = "healthy";
    }

    return {
      expiry_days: this.certExpiryDays,
      status,
    };
  }

  /**
   * Determine overall system status based on component health
   */
  private determineOverallStatus(components: Record<string, ComponentHealth>): SystemStatus {
    const statuses = Object.values(components);

    if (statuses.length === 0) {
      return "healthy";
    }

    const unhealthyCount = statuses.filter((c) => c.status === "unhealthy").length;
    const degradedCount = statuses.filter((c) => c.status === "degraded").length;

    // Critical components that must be healthy
    const criticalComponents = ["redis", "sqlite"];
    const criticalUnhealthy = criticalComponents.some(
      (name) => components[name]?.status === "unhealthy"
    );

    if (criticalUnhealthy || unhealthyCount > statuses.length / 2) {
      return "unhealthy";
    }

    if (unhealthyCount > 0 || degradedCount > 0) {
      return "degraded";
    }

    return "healthy";
  }

  /**
   * Close any open connections
   */
  async close(): Promise<void> {
    if (this.redisClient) {
      await this.redisClient.quit();
      this.redisClient = undefined;
    }

    if (this.sqliteDb) {
      (this.sqliteDb as { close: () => void }).close();
      this.sqliteDb = undefined;
    }
  }
}

/**
 * Create a new HealthChecker instance
 */
export function createHealthChecker(
  config: HealthCheckerConfig,
  options?: HealthCheckerOptions
): HealthChecker {
  return new HealthChecker(config, options);
}

/**
 * Create health checker from environment variables
 */
export function createHealthCheckerFromEnv(options?: HealthCheckerOptions): HealthChecker {
  const config: HealthCheckerConfig = {};

  // Redis configuration
  if (process.env.REDIS_HOST) {
    config.redis = {
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT || "6379"),
      password: process.env.REDIS_PASSWORD,
    };
  }

  // PostgreSQL configuration
  if (process.env.POSTGRES_HOST) {
    config.postgres = {
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || "5432"),
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
    };
  }

  // SQLite configuration
  if (process.env.SQLITE_DB) {
    config.sqlite = {
      path: process.env.SQLITE_DB,
    };
  }

  // Qdrant configuration
  if (process.env.QDRANT_URL) {
    config.qdrant = {
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
    };
  }

  // Embedding service configuration
  if (process.env.EMBEDDING_SERVICE_URL) {
    config.embedding = {
      url: process.env.EMBEDDING_SERVICE_URL,
    };
  }

  return createHealthChecker(config, options);
}
