#!/bin/sh
set -e
mkdir -p /home/node/.n8n
chown -R node:node /home/node/.n8n
chmod 755 /home/node/.n8n
su node -s /bin/sh -c "n8n import:workflow --input=/opt/tara-viora/workflows.json" || true
for id in \
11111111-1111-4111-8111-111111111111 \
22222222-2222-4222-8222-222222222222 \
33333333-3333-4333-8333-333333333333 \
44444444-4444-4444-8444-444444444444 \
55555555-5555-4555-8555-555555555555 \
66666666-6666-4666-8666-666666666666 \
77777777-7777-4777-8777-777777777777 \
88888888-8888-4888-8888-888888888888
do
  su node -s /bin/sh -c "n8n publish:workflow --id=$id" || true
done
exec su node -s /bin/sh -c "n8n start"
