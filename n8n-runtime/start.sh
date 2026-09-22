#!/bin/sh
set -e
mkdir -p /home/node/.n8n
chown -R node:node /home/node/.n8n
chmod 755 /home/node/.n8n
su node -s /bin/sh -c "n8n import:workflow --input=/opt/tara-viora/workflows.json" || true
su node -s /bin/sh -c "n8n update:workflow --all --active=true" || true
exec su node -s /bin/sh -c "n8n start"
