#!/usr/bin/env bash
# ── Test Linear Webhook ─────────────────────────────────────────
# Sends a simulated Linear webhook payload to the extension listener.
#
# Usage:
#   Local (inside Docker network):
#     ./test-linear-webhook.sh
#
#   Via localhost (host port):
#     ./test-linear-webhook.sh http://localhost:3099
#
#   Via ngrok tunnel:
#     ./test-linear-webhook.sh https://<id>.ngrok-free.app
#
#   Via Tailscale Funnel:
#     ./test-linear-webhook.sh https://<machine>.<tailnet>.ts.net

set -euo pipefail

BASE_URL="${1:-http://localhost:3099}"
WEBHOOK_PATH="/linear/webhook"
SECRET="${LINEAR_WEBHOOK_SECRET:-}"
if [ -z "$SECRET" ]; then
  echo "Error: Set LINEAR_WEBHOOK_SECRET env var with your webhook signing secret."
  echo "  export LINEAR_WEBHOOK_SECRET=lin_wh_..."
  exit 1
fi

# ── Fake Linear webhook payload ─────────────────────────────────
# Mimics Linear's "Comment created" webhook where someone @mentions the bot.

PAYLOAD=$(cat <<'EOF'
{
  "action": "create",
  "type": "Comment",
  "data": {
    "id": "test-comment-001",
    "body": "@Beluga can you check on this issue?",
    "issueId": "test-issue-uuid-1234",
    "issue": {
      "id": "test-issue-uuid-1234",
      "identifier": "TEST-42"
    }
  },
  "actor": {
    "id": "test-user-001",
    "name": "Test User",
    "displayName": "Test User"
  },
  "url": "https://linear.app/test/issue/TEST-42",
  "createdAt": "2025-01-01T00:00:00.000Z"
}
EOF
)

# ── Compute HMAC signature ──────────────────────────────────────
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')

echo "─── Linear Webhook Test ───"
echo "Target:   ${BASE_URL}${WEBHOOK_PATH}"
echo "Secret:   ${SECRET:0:10}..."
echo "Signature: ${SIGNATURE:0:16}..."
echo ""

# ── Send webhook ────────────────────────────────────────────────
RESPONSE=$(curl -s -w "\n---HTTP_STATUS:%{http_code}---" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "linear-signature: ${SIGNATURE}" \
  -d "$PAYLOAD" \
  "${BASE_URL}${WEBHOOK_PATH}" 2>&1)

HTTP_STATUS=$(echo "$RESPONSE" | grep -o '---HTTP_STATUS:[0-9]*---' | grep -o '[0-9]*')
BODY=$(echo "$RESPONSE" | sed '/---HTTP_STATUS:/d')

echo "Response (${HTTP_STATUS}): ${BODY}"
echo ""

if [ "$HTTP_STATUS" = "200" ]; then
  echo "✅ Webhook accepted! Check daemon logs for session creation."
else
  echo "❌ Webhook rejected or error."
  echo ""
  echo "Troubleshooting:"
  echo "  1. Is the daemon running?    docker compose ps"
  echo "  2. Is port 3099 exposed?     docker compose port daemon 3099"
  echo "  3. Is Tailscale Funnel on?   tailscale status"
  echo ""
  echo "Full response:"
  echo "$RESPONSE"
fi
