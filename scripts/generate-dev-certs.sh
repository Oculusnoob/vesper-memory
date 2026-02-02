#!/bin/bash
#
# Generate Self-Signed SSL Certificates for Development
#
# Usage: ./scripts/generate-dev-certs.sh
#
# This script generates self-signed certificates suitable for local development.
# DO NOT use these certificates in production - use Let's Encrypt instead.
#

set -e

# Configuration
SSL_DIR="config/ssl"
DAYS_VALID=365
KEY_SIZE=4096
HOSTNAME="localhost"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Development SSL Certificate Generator ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Check if OpenSSL is installed
if ! command -v openssl &> /dev/null; then
    echo -e "${RED}Error: OpenSSL is not installed${NC}"
    echo "Please install OpenSSL first:"
    echo "  macOS: brew install openssl"
    echo "  Ubuntu/Debian: sudo apt-get install openssl"
    exit 1
fi

# Create SSL directory
echo -e "${YELLOW}Creating SSL directory...${NC}"
mkdir -p "$SSL_DIR"
mkdir -p "$SSL_DIR/letsencrypt"
mkdir -p "$SSL_DIR/certbot-webroot"

# Check if certificates already exist
if [ -f "$SSL_DIR/privkey.pem" ] && [ -f "$SSL_DIR/fullchain.pem" ]; then
    echo -e "${YELLOW}Existing certificates found.${NC}"
    read -p "Do you want to regenerate them? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing certificates."
        exit 0
    fi
fi

# Generate private key
echo -e "${YELLOW}Generating ${KEY_SIZE}-bit RSA private key...${NC}"
openssl genrsa -out "$SSL_DIR/privkey.pem" $KEY_SIZE 2>/dev/null

# Generate self-signed certificate
echo -e "${YELLOW}Generating self-signed certificate (valid for ${DAYS_VALID} days)...${NC}"
openssl req -new -x509 -sha256 -days $DAYS_VALID \
    -key "$SSL_DIR/privkey.pem" \
    -out "$SSL_DIR/fullchain.pem" \
    -subj "/C=US/ST=Development/L=Local/O=Memory MCP/OU=Development/CN=${HOSTNAME}" \
    -addext "subjectAltName=DNS:${HOSTNAME},DNS:*.${HOSTNAME},IP:127.0.0.1,IP:::1"

# Create chain.pem (same as fullchain for self-signed)
echo -e "${YELLOW}Creating certificate chain...${NC}"
cp "$SSL_DIR/fullchain.pem" "$SSL_DIR/chain.pem"

# Set proper permissions
echo -e "${YELLOW}Setting file permissions...${NC}"
chmod 600 "$SSL_DIR/privkey.pem"
chmod 644 "$SSL_DIR/fullchain.pem"
chmod 644 "$SSL_DIR/chain.pem"

# Verify the certificate
echo -e "${YELLOW}Verifying certificate...${NC}"
openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -dates

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Certificate Generation Complete!      ${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Generated files:"
echo "  - $SSL_DIR/privkey.pem   (private key - keep secret!)"
echo "  - $SSL_DIR/fullchain.pem (certificate)"
echo "  - $SSL_DIR/chain.pem     (certificate chain)"
echo ""
echo -e "${YELLOW}Certificate Details:${NC}"
openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -subject -dates | sed 's/^/  /'
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "  1. Start the services: docker-compose up -d"
echo "  2. Test HTTPS: curl -k https://localhost/health"
echo ""
echo -e "${RED}WARNING: These are self-signed certificates for DEVELOPMENT ONLY.${NC}"
echo -e "${RED}For production, use Let's Encrypt certificates.${NC}"
echo ""
