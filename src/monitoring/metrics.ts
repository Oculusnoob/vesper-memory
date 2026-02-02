/**
 * Prometheus Metrics Collector
 *
 * Provides comprehensive metrics collection for the Vesper server:
 * - Request counters (per tool, per status)
 * - Latency histograms (P50, P95, P99)
 * - Error rate gauges
 * - Active connections gauge
 * - Auth success/failure counters
 * - Cache hit rate tracking
 *
 * Performance target: <5ms overhead per metric collection
 */

import {
  Counter,
  Histogram,
  Gauge,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

/**
 * Configuration for the metrics collector
 */
export interface MetricsConfig {
  /** Prefix for all metric names (default: "mcp") */
  prefix?: string;
  /** Default labels applied to all metrics */
  defaultLabels?: Record<string, string>;
  /** Whether to collect default Node.js metrics */
  collectDefaultMetrics?: boolean;
  /** Whether authentication is required for metrics endpoint */
  requireAuth?: boolean;
  /** Authentication token for metrics endpoint (when requireAuth is true) */
  authToken?: string;
}

/**
 * Options for retrieving metrics
 */
export interface GetMetricsOptions {
  /** Authentication token (required when requireAuth is true) */
  authToken?: string;
}

/**
 * MetricsCollector class for Prometheus metrics
 */
export class MetricsCollector {
  private registry: Registry;
  private config: MetricsConfig;

  // Counter metrics
  private requestsTotal: Counter<string>;
  private errorsTotal: Counter<string>;
  private authAttemptsTotal: Counter<string>;
  private rateLimitHitsTotal: Counter<string>;
  private consolidationFailuresTotal: Counter<string>;

  // Histogram metrics
  private requestDuration: Histogram<string>;
  private dbQueryDuration: Histogram<string>;

  // Gauge metrics
  private activeConnections: Gauge<string>;
  private cacheHitRate: Gauge<string>;
  private certExpiryDays: Gauge<string>;

  constructor(config: MetricsConfig = {}) {
    this.config = {
      prefix: config.prefix || "mcp",
      defaultLabels: config.defaultLabels || {},
      collectDefaultMetrics: config.collectDefaultMetrics ?? false,
      requireAuth: config.requireAuth ?? false,
      authToken: config.authToken,
    };

    // Create a new registry for this collector
    this.registry = new Registry();

    // Set default labels
    if (Object.keys(this.config.defaultLabels!).length > 0) {
      this.registry.setDefaultLabels(this.config.defaultLabels!);
    }

    // Initialize counter metrics
    this.requestsTotal = new Counter({
      name: `${this.config.prefix}_requests_total`,
      help: "Total number of MCP tool requests",
      labelNames: ["tool", "status"],
      registers: [this.registry],
    });

    this.errorsTotal = new Counter({
      name: `${this.config.prefix}_errors_total`,
      help: "Total number of errors by type",
      labelNames: ["type"],
      registers: [this.registry],
    });

    this.authAttemptsTotal = new Counter({
      name: `${this.config.prefix}_auth_attempts_total`,
      help: "Total authentication attempts",
      labelNames: ["status"],
      registers: [this.registry],
    });

    this.rateLimitHitsTotal = new Counter({
      name: `${this.config.prefix}_rate_limit_hits_total`,
      help: "Total rate limit violations",
      labelNames: ["user_id", "operation"],
      registers: [this.registry],
    });

    this.consolidationFailuresTotal = new Counter({
      name: `${this.config.prefix}_consolidation_failures_total`,
      help: "Total consolidation pipeline failures",
      registers: [this.registry],
    });

    // Initialize histogram metrics with appropriate buckets
    this.requestDuration = new Histogram({
      name: `${this.config.prefix}_request_duration_seconds`,
      help: "Request duration in seconds",
      labelNames: ["tool"],
      // Buckets optimized for <200ms P95 latency target
      buckets: [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.dbQueryDuration = new Histogram({
      name: `${this.config.prefix}_db_query_duration_seconds`,
      help: "Database query duration in seconds",
      labelNames: ["db", "operation"],
      buckets: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5],
      registers: [this.registry],
    });

    // Initialize gauge metrics
    this.activeConnections = new Gauge({
      name: `${this.config.prefix}_active_connections`,
      help: "Number of active connections",
      registers: [this.registry],
    });

    this.cacheHitRate = new Gauge({
      name: `${this.config.prefix}_cache_hit_rate`,
      help: "Cache hit rate (0.0 to 1.0)",
      registers: [this.registry],
    });

    this.certExpiryDays = new Gauge({
      name: `${this.config.prefix}_cert_expiry_days`,
      help: "Days until certificate expiration",
      registers: [this.registry],
    });

    // Optionally collect default Node.js metrics
    if (this.config.collectDefaultMetrics) {
      collectDefaultMetrics({ register: this.registry });
    }
  }

  /**
   * Get the Prometheus registry
   */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * Increment request counter
   */
  incrementRequests(tool: string, status: "success" | "error"): void {
    this.requestsTotal.inc({ tool, status });
  }

  /**
   * Increment error counter
   */
  incrementErrors(type: string): void {
    this.errorsTotal.inc({ type });
  }

  /**
   * Increment authentication attempts counter
   */
  incrementAuthAttempts(status: "success" | "failed"): void {
    this.authAttemptsTotal.inc({ status });
  }

  /**
   * Increment rate limit hits counter
   */
  incrementRateLimitHits(userId: string, operation: string): void {
    // Sanitize user_id to avoid high cardinality issues
    const sanitizedUserId = userId.substring(0, 32);
    this.rateLimitHitsTotal.inc({ user_id: sanitizedUserId, operation });
  }

  /**
   * Increment consolidation failures counter
   */
  incrementConsolidationFailures(): void {
    this.consolidationFailuresTotal.inc();
  }

  /**
   * Record request latency
   */
  recordLatency(tool: string, durationSeconds: number): void {
    this.requestDuration.observe({ tool }, durationSeconds);
  }

  /**
   * Record database query latency
   */
  recordDbLatency(db: string, operation: string, durationSeconds: number): void {
    this.dbQueryDuration.observe({ db, operation }, durationSeconds);
  }

  /**
   * Set active connections gauge
   */
  setActiveConnections(count: number): void {
    this.activeConnections.set(count);
  }

  /**
   * Set cache hit rate gauge
   */
  setCacheHitRate(rate: number): void {
    this.cacheHitRate.set(rate);
  }

  /**
   * Set certificate expiry days gauge
   */
  setCertExpiryDays(days: number): void {
    this.certExpiryDays.set(days);
  }

  /**
   * Get metrics in Prometheus text format
   */
  async getMetricsText(options: GetMetricsOptions = {}): Promise<string> {
    this.validateAuth(options.authToken);
    return await this.registry.metrics();
  }

  /**
   * Get metrics as JSON array
   */
  async getMetricsJson(options: GetMetricsOptions = {}): Promise<unknown[]> {
    this.validateAuth(options.authToken);
    return await this.registry.getMetricsAsJSON();
  }

  /**
   * Get current error rate (errors / total requests)
   */
  async getErrorRate(): Promise<number> {
    const metrics = await this.registry.getMetricsAsJSON();

    // Find request metrics
    const requestMetric = metrics.find(
      (m) => m.name === `${this.config.prefix}_requests_total`
    );

    if (!requestMetric || !("values" in requestMetric)) {
      return 0;
    }

    const values = requestMetric.values as Array<{ labels: Record<string, string>; value: number }>;
    let successCount = 0;
    let errorCount = 0;

    for (const v of values) {
      if (v.labels.status === "success") {
        successCount += v.value;
      } else if (v.labels.status === "error") {
        errorCount += v.value;
      }
    }

    const total = successCount + errorCount;
    return total > 0 ? errorCount / total : 0;
  }

  /**
   * Get authentication failure count
   */
  async getAuthFailureCount(): Promise<number> {
    const metrics = await this.registry.getMetricsAsJSON();

    const authMetric = metrics.find(
      (m) => m.name === `${this.config.prefix}_auth_attempts_total`
    );

    if (!authMetric || !("values" in authMetric)) {
      return 0;
    }

    const values = authMetric.values as Array<{ labels: Record<string, string>; value: number }>;
    let failureCount = 0;

    for (const v of values) {
      if (v.labels.status === "failed") {
        failureCount += v.value;
      }
    }

    return failureCount;
  }

  /**
   * Get P95 latency for a specific tool
   * Note: This is an approximation based on histogram buckets
   */
  async getP95Latency(tool: string): Promise<number> {
    const metrics = await this.registry.getMetricsAsJSON();

    const durationMetric = metrics.find(
      (m) => m.name === `${this.config.prefix}_request_duration_seconds`
    );

    if (!durationMetric || !("values" in durationMetric)) {
      return 0;
    }

    // prom-client returns histogram values in a specific format
    // Each bucket has a 'le' label (less than or equal to)
    interface HistogramValue {
      labels: Record<string, string>;
      value: number;
      metricName?: string;
    }

    const values = (durationMetric as { values: HistogramValue[] }).values;

    // Filter to this tool's histogram buckets (buckets have 'le' label)
    const toolBuckets = values.filter(
      (v) => v.labels.tool === tool && v.labels.le !== undefined
    );

    if (toolBuckets.length === 0) {
      return 0;
    }

    // Get total count from +Inf bucket (contains all observations)
    const infBucket = toolBuckets.find((b) => b.labels.le === "+Inf");
    const totalCount = infBucket?.value || 0;

    if (totalCount === 0) {
      return 0;
    }

    // Find P95 bucket (95th percentile)
    const p95Target = totalCount * 0.95;

    // Sort buckets by le (upper bound), excluding +Inf
    const sortedBuckets = toolBuckets
      .filter((b) => b.labels.le !== "+Inf")
      .sort((a, b) => parseFloat(a.labels.le) - parseFloat(b.labels.le));

    for (const bucket of sortedBuckets) {
      if (bucket.value >= p95Target) {
        return parseFloat(bucket.labels.le);
      }
    }

    // If no bucket found, return the highest bucket boundary
    if (sortedBuckets.length > 0) {
      return parseFloat(sortedBuckets[sortedBuckets.length - 1].labels.le);
    }

    return 0;
  }

  /**
   * Reset all metrics (useful for testing)
   */
  async reset(): Promise<void> {
    this.registry.resetMetrics();
  }

  /**
   * Validate authentication for metrics access
   */
  private validateAuth(providedToken: string | undefined): void {
    if (!this.config.requireAuth) {
      return;
    }

    if (!providedToken) {
      throw new Error("Authentication required for metrics endpoint");
    }

    if (!this.config.authToken) {
      throw new Error("Metrics authentication not configured");
    }

    if (providedToken !== this.config.authToken) {
      throw new Error("Invalid authentication token");
    }
  }
}

/**
 * Create a new MetricsCollector instance
 */
export function createMetricsCollector(config: MetricsConfig = {}): MetricsCollector {
  return new MetricsCollector(config);
}

/**
 * Singleton instance for global metrics collection
 */
let globalCollector: MetricsCollector | null = null;

/**
 * Get or create the global metrics collector
 */
export function getGlobalMetrics(config?: MetricsConfig): MetricsCollector {
  if (!globalCollector) {
    globalCollector = createMetricsCollector(config);
  }
  return globalCollector;
}

/**
 * Timer helper for measuring operation duration
 */
export class MetricsTimer {
  private startTime: number;
  private collector: MetricsCollector;
  private tool: string;

  constructor(collector: MetricsCollector, tool: string) {
    this.collector = collector;
    this.tool = tool;
    this.startTime = performance.now();
  }

  /**
   * End the timer and record the duration
   */
  end(status: "success" | "error" = "success"): number {
    const duration = (performance.now() - this.startTime) / 1000;
    this.collector.recordLatency(this.tool, duration);
    this.collector.incrementRequests(this.tool, status);
    return duration;
  }
}

/**
 * Create a timer for measuring operation duration
 */
export function startTimer(collector: MetricsCollector, tool: string): MetricsTimer {
  return new MetricsTimer(collector, tool);
}
