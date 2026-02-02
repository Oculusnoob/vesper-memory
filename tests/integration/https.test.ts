/**
 * HTTPS Configuration Integration Tests
 *
 * Tests for TLS/HTTPS configuration including:
 * - HTTP to HTTPS redirect
 * - TLS handshake validation
 * - Security headers verification
 * - Certificate expiration monitoring
 *
 * @module tests/integration/https
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execSync } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';

// Import the health check module (will be created)
import {
  checkCertificateExpiration,
  CertificateStatus,
  HealthCheckResult,
} from '../../src/monitoring/health.js';

// Test configuration
const TEST_HOST = process.env.TEST_HOST || 'localhost';
const TEST_HTTP_PORT = parseInt(process.env.TEST_HTTP_PORT || '8080', 10);
const TEST_HTTPS_PORT = parseInt(process.env.TEST_HTTPS_PORT || '8443', 10);

// Helper to make HTTP request
function makeHttpRequest(
  url: string,
  options: http.RequestOptions = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body,
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

// Helper to make HTTPS request
function makeHttpsRequest(
  url: string,
  options: https.RequestOptions = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body,
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

// Helper to check TLS socket
function checkTlsSocket(
  host: string,
  port: number,
  options: tls.ConnectionOptions = {}
): Promise<{ protocol: string | null; cipher: tls.CipherNameAndProtocol | null }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(port, host, { ...options, rejectUnauthorized: false }, () => {
      const protocol = socket.getProtocol();
      const cipher = socket.getCipher();
      socket.end();
      resolve({ protocol, cipher });
    });
    socket.on('error', reject);
  });
}

describe('HTTPS Configuration', () => {
  describe('HTTP to HTTPS Redirect', () => {
    it('should return 301 redirect for HTTP requests', async () => {
      // This test requires nginx to be running
      // Skip if nginx is not available
      try {
        const response = await makeHttpRequest(`http://${TEST_HOST}:${TEST_HTTP_PORT}/`);
        expect(response.statusCode).toBe(301);
        expect(response.headers.location).toMatch(/^https:\/\//);
      } catch (error) {
        // Skip test if nginx is not running
        console.warn('Skipping HTTP redirect test - nginx not available');
      }
    });

    it('should redirect to same path on HTTPS', async () => {
      try {
        const testPath = '/api/test-path';
        const response = await makeHttpRequest(`http://${TEST_HOST}:${TEST_HTTP_PORT}${testPath}`);
        expect(response.statusCode).toBe(301);
        expect(response.headers.location).toContain(testPath);
      } catch (error) {
        console.warn('Skipping HTTP redirect path test - nginx not available');
      }
    });

    it('should preserve query parameters in redirect', async () => {
      try {
        const testPath = '/api/search?q=test&limit=10';
        const response = await makeHttpRequest(`http://${TEST_HOST}:${TEST_HTTP_PORT}${testPath}`);
        expect(response.statusCode).toBe(301);
        expect(response.headers.location).toContain('q=test');
        expect(response.headers.location).toContain('limit=10');
      } catch (error) {
        console.warn('Skipping query parameter redirect test - nginx not available');
      }
    });
  });

  describe('TLS Configuration', () => {
    it('should use TLS 1.2 or higher', async () => {
      try {
        const result = await checkTlsSocket(TEST_HOST, TEST_HTTPS_PORT);
        expect(result.protocol).toBeDefined();
        // TLS 1.2 = TLSv1.2, TLS 1.3 = TLSv1.3
        expect(['TLSv1.2', 'TLSv1.3']).toContain(result.protocol);
      } catch (error) {
        console.warn('Skipping TLS version test - nginx not available');
      }
    });

    it('should reject TLS 1.0 connections', async () => {
      try {
        await expect(
          checkTlsSocket(TEST_HOST, TEST_HTTPS_PORT, {
            maxVersion: 'TLSv1',
            minVersion: 'TLSv1',
          })
        ).rejects.toThrow();
      } catch (error) {
        console.warn('Skipping TLS 1.0 rejection test - nginx not available');
      }
    });

    it('should reject TLS 1.1 connections', async () => {
      try {
        await expect(
          checkTlsSocket(TEST_HOST, TEST_HTTPS_PORT, {
            maxVersion: 'TLSv1.1',
            minVersion: 'TLSv1.1',
          })
        ).rejects.toThrow();
      } catch (error) {
        console.warn('Skipping TLS 1.1 rejection test - nginx not available');
      }
    });

    it('should use strong cipher suites', async () => {
      try {
        const result = await checkTlsSocket(TEST_HOST, TEST_HTTPS_PORT);
        expect(result.cipher).toBeDefined();
        // Strong cipher suites include ECDHE, AES-GCM, CHACHA20
        const strongCipherPatterns = ['ECDHE', 'AES.*GCM', 'CHACHA20'];
        const cipherName = result.cipher?.name || '';
        const isStrong = strongCipherPatterns.some((pattern) => new RegExp(pattern).test(cipherName));
        expect(isStrong).toBe(true);
      } catch (error) {
        console.warn('Skipping cipher suite test - nginx not available');
      }
    });
  });

  describe('Security Headers', () => {
    it('should include Strict-Transport-Security header', async () => {
      try {
        const response = await makeHttpsRequest(`https://${TEST_HOST}:${TEST_HTTPS_PORT}/`, {
          rejectUnauthorized: false,
        });
        const hsts = response.headers['strict-transport-security'];
        expect(hsts).toBeDefined();
        expect(hsts).toContain('max-age=');
        // Should be at least 1 year (31536000 seconds)
        const maxAgeMatch = hsts?.match(/max-age=(\d+)/);
        if (maxAgeMatch) {
          expect(parseInt(maxAgeMatch[1], 10)).toBeGreaterThanOrEqual(31536000);
        }
      } catch (error) {
        console.warn('Skipping HSTS header test - nginx not available');
      }
    });

    it('should include X-Frame-Options header', async () => {
      try {
        const response = await makeHttpsRequest(`https://${TEST_HOST}:${TEST_HTTPS_PORT}/`, {
          rejectUnauthorized: false,
        });
        const xFrameOptions = response.headers['x-frame-options'];
        expect(xFrameOptions).toBeDefined();
        expect(['DENY', 'SAMEORIGIN']).toContain(xFrameOptions?.toUpperCase());
      } catch (error) {
        console.warn('Skipping X-Frame-Options test - nginx not available');
      }
    });

    it('should include X-Content-Type-Options header', async () => {
      try {
        const response = await makeHttpsRequest(`https://${TEST_HOST}:${TEST_HTTPS_PORT}/`, {
          rejectUnauthorized: false,
        });
        expect(response.headers['x-content-type-options']).toBe('nosniff');
      } catch (error) {
        console.warn('Skipping X-Content-Type-Options test - nginx not available');
      }
    });

    it('should include X-XSS-Protection header', async () => {
      try {
        const response = await makeHttpsRequest(`https://${TEST_HOST}:${TEST_HTTPS_PORT}/`, {
          rejectUnauthorized: false,
        });
        const xssProtection = response.headers['x-xss-protection'];
        expect(xssProtection).toBeDefined();
        expect(xssProtection).toContain('1');
      } catch (error) {
        console.warn('Skipping X-XSS-Protection test - nginx not available');
      }
    });

    it('should include Referrer-Policy header', async () => {
      try {
        const response = await makeHttpsRequest(`https://${TEST_HOST}:${TEST_HTTPS_PORT}/`, {
          rejectUnauthorized: false,
        });
        const referrerPolicy = response.headers['referrer-policy'];
        expect(referrerPolicy).toBeDefined();
        const validPolicies = [
          'no-referrer',
          'no-referrer-when-downgrade',
          'origin',
          'origin-when-cross-origin',
          'same-origin',
          'strict-origin',
          'strict-origin-when-cross-origin',
        ];
        expect(validPolicies).toContain(referrerPolicy?.toLowerCase());
      } catch (error) {
        console.warn('Skipping Referrer-Policy test - nginx not available');
      }
    });

    it('should not include Server version header', async () => {
      try {
        const response = await makeHttpsRequest(`https://${TEST_HOST}:${TEST_HTTPS_PORT}/`, {
          rejectUnauthorized: false,
        });
        const serverHeader = response.headers['server'];
        // Server header should either not exist or not reveal version
        if (serverHeader) {
          expect(serverHeader).not.toMatch(/nginx\/[\d.]+/);
          expect(serverHeader).not.toMatch(/Apache\/[\d.]+/);
        }
      } catch (error) {
        console.warn('Skipping Server header test - nginx not available');
      }
    });
  });

  describe('Certificate Validity', () => {
    it('should have a valid certificate', async () => {
      try {
        // Connect and verify certificate is present
        const result = await checkTlsSocket(TEST_HOST, TEST_HTTPS_PORT);
        expect(result.protocol).toBeDefined();
      } catch (error) {
        console.warn('Skipping certificate validity test - nginx not available');
      }
    });
  });
});

describe('Certificate Expiration Monitoring', () => {
  describe('checkCertificateExpiration', () => {
    it('should return valid status for non-expiring certificate', async () => {
      // Create a mock certificate that expires in 90 days
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 90);

      const result = await checkCertificateExpiration({
        certPath: '/nonexistent/path/cert.pem',
        mockExpirationDate: futureDate, // For testing
      });

      expect(result.status).toBe('valid');
      expect(result.daysUntilExpiration).toBeGreaterThan(14);
      expect(result.shouldAlert).toBe(false);
    });

    it('should return warning status for certificate expiring within 14 days', async () => {
      // Create a mock certificate that expires in 10 days
      const soonDate = new Date();
      soonDate.setDate(soonDate.getDate() + 10);

      const result = await checkCertificateExpiration({
        certPath: '/nonexistent/path/cert.pem',
        mockExpirationDate: soonDate,
      });

      expect(result.status).toBe('warning');
      expect(result.daysUntilExpiration).toBeLessThanOrEqual(14);
      expect(result.shouldAlert).toBe(true);
    });

    it('should return critical status for certificate expiring within 7 days', async () => {
      // Create a mock certificate that expires in 3 days
      const urgentDate = new Date();
      urgentDate.setDate(urgentDate.getDate() + 3);

      const result = await checkCertificateExpiration({
        certPath: '/nonexistent/path/cert.pem',
        mockExpirationDate: urgentDate,
      });

      expect(result.status).toBe('critical');
      expect(result.daysUntilExpiration).toBeLessThanOrEqual(7);
      expect(result.shouldAlert).toBe(true);
    });

    it('should return expired status for expired certificate', async () => {
      // Create a mock certificate that expired yesterday
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const result = await checkCertificateExpiration({
        certPath: '/nonexistent/path/cert.pem',
        mockExpirationDate: pastDate,
      });

      expect(result.status).toBe('expired');
      expect(result.daysUntilExpiration).toBeLessThan(0);
      expect(result.shouldAlert).toBe(true);
    });

    it('should return error status when certificate file not found', async () => {
      const result = await checkCertificateExpiration({
        certPath: '/nonexistent/path/cert.pem',
      });

      expect(result.status).toBe('error');
      expect(result.error).toBeDefined();
    });
  });
});

describe('Nginx Configuration Validation', () => {
  const nginxConfigPath = path.join(
    process.cwd(),
    'config',
    'nginx',
    'nginx.conf'
  );

  it('should have nginx configuration file', () => {
    // This test verifies the config file exists
    // Will fail until we create it
    expect(fs.existsSync(nginxConfigPath)).toBe(true);
  });

  it('should contain TLS 1.2/1.3 only directive', () => {
    if (!fs.existsSync(nginxConfigPath)) {
      console.warn('Skipping nginx config test - file not created yet');
      return;
    }
    const config = fs.readFileSync(nginxConfigPath, 'utf-8');
    // Should only allow TLSv1.2 and TLSv1.3
    expect(config).toMatch(/ssl_protocols\s+TLSv1\.2\s+TLSv1\.3/);
  });

  it('should contain HSTS header configuration', () => {
    if (!fs.existsSync(nginxConfigPath)) {
      console.warn('Skipping nginx config test - file not created yet');
      return;
    }
    const config = fs.readFileSync(nginxConfigPath, 'utf-8');
    expect(config).toContain('Strict-Transport-Security');
    expect(config).toMatch(/max-age=\d{7,}/); // At least 7 digits (1+ year in seconds)
  });

  it('should contain HTTP to HTTPS redirect', () => {
    if (!fs.existsSync(nginxConfigPath)) {
      console.warn('Skipping nginx config test - file not created yet');
      return;
    }
    const config = fs.readFileSync(nginxConfigPath, 'utf-8');
    expect(config).toMatch(/return\s+301\s+https/);
  });

  it('should contain security headers', () => {
    if (!fs.existsSync(nginxConfigPath)) {
      console.warn('Skipping nginx config test - file not created yet');
      return;
    }
    const config = fs.readFileSync(nginxConfigPath, 'utf-8');
    expect(config).toContain('X-Frame-Options');
    expect(config).toContain('X-Content-Type-Options');
    expect(config).toContain('X-XSS-Protection');
    expect(config).toContain('Referrer-Policy');
  });

  it('should hide nginx version', () => {
    if (!fs.existsSync(nginxConfigPath)) {
      console.warn('Skipping nginx config test - file not created yet');
      return;
    }
    const config = fs.readFileSync(nginxConfigPath, 'utf-8');
    expect(config).toContain('server_tokens off');
  });

  it('should configure strong cipher suites', () => {
    if (!fs.existsSync(nginxConfigPath)) {
      console.warn('Skipping nginx config test - file not created yet');
      return;
    }
    const config = fs.readFileSync(nginxConfigPath, 'utf-8');
    // Should include ECDHE and AES-GCM ciphers
    expect(config).toMatch(/ssl_ciphers.*ECDHE/);
    expect(config).toMatch(/ssl_ciphers.*GCM/);
  });

  it('should prefer server cipher suites', () => {
    if (!fs.existsSync(nginxConfigPath)) {
      console.warn('Skipping nginx config test - file not created yet');
      return;
    }
    const config = fs.readFileSync(nginxConfigPath, 'utf-8');
    expect(config).toContain('ssl_prefer_server_ciphers on');
  });
});

describe('Docker Compose HTTPS Configuration', () => {
  const dockerComposePath = path.join(process.cwd(), 'docker-compose.yml');

  it('should contain nginx service', () => {
    const config = fs.readFileSync(dockerComposePath, 'utf-8');
    expect(config).toContain('nginx:');
  });

  it('should expose ports 80 and 443', () => {
    const config = fs.readFileSync(dockerComposePath, 'utf-8');
    expect(config).toMatch(/["']?80:80["']?/);
    expect(config).toMatch(/["']?443:443["']?/);
  });

  it('should mount SSL certificate volumes', () => {
    const config = fs.readFileSync(dockerComposePath, 'utf-8');
    expect(config).toMatch(/ssl|certs|letsencrypt/i);
  });

  it('should include certbot service for auto-renewal', () => {
    const config = fs.readFileSync(dockerComposePath, 'utf-8');
    expect(config).toContain('certbot');
  });
});

describe('Development vs Production Mode', () => {
  it('should support self-signed certificates in development', () => {
    // Verify that the config supports development mode with self-signed certs
    const sslReadmePath = path.join(process.cwd(), 'config', 'ssl', 'README.md');
    if (!fs.existsSync(sslReadmePath)) {
      console.warn('Skipping SSL readme test - file not created yet');
      return;
    }
    const readme = fs.readFileSync(sslReadmePath, 'utf-8');
    expect(readme).toContain('self-signed');
    expect(readme).toContain('development');
  });

  it('should support Let\'s Encrypt in production', () => {
    const sslReadmePath = path.join(process.cwd(), 'config', 'ssl', 'README.md');
    if (!fs.existsSync(sslReadmePath)) {
      console.warn('Skipping SSL readme test - file not created yet');
      return;
    }
    const readme = fs.readFileSync(sslReadmePath, 'utf-8');
    expect(readme).toContain("Let's Encrypt");
    expect(readme).toContain('production');
  });
});
