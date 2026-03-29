#!/bin/sh
set -e

echo "=== SelfProgramingDockerAgent starting ==="

# Generate .htpasswd for admin Basic Auth
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
echo "admin:$(echo "$ADMIN_PASSWORD" | openssl passwd -apr1 -stdin)" > /app/.htpasswd
echo "[entrypoint] Admin auth configured (user: admin)"

# Save environment variables for cron jobs (cron doesn't inherit container env)
env | grep -E '^(AZURE_|TELEMETRY_|RSS_|ADMIN_|NEWS_|OTEL_|GIT_|ANTHROPIC_)' > /app/.env.runtime
echo "[entrypoint] Saved runtime env vars for cron"

# Create log files for Promtail to tail
touch /var/log/dev-agent-debug.log /var/log/news-agent.log /var/log/news-agent-debug.log /var/log/news-agent-cron.log

# Set up cron for news agent
RSS_INTERVAL="${RSS_INTERVAL_MINUTES:-60}"
CRON_SCHEDULE="*/${RSS_INTERVAL} * * * *"

# Create cron job script that loads env vars
cat > /app/scripts/run-news-agent.sh << 'CRONSCRIPT'
#!/bin/sh
# Load environment variables saved at container start
set -a
. /app/.env.runtime
set +a

echo "[news-agent] Starting news fetch at $(date)..."
cd /app
cagent run /app/agents/news-agent.yaml --exec --yolo --otel --debug --log-file /var/log/news-agent-debug.log --working-dir /app "Fetch feeds, pick the best story, publish it." >> /var/log/news-agent.log 2>&1
echo "[news-agent] Done at $(date)."
CRONSCRIPT
chmod +x /app/scripts/run-news-agent.sh

# Create crontab
cat > /etc/crontabs/root << EOF
${CRON_SCHEDULE} /app/scripts/run-news-agent.sh >> /var/log/news-agent-cron.log 2>&1
EOF

echo "[entrypoint] News agent cron set to every ${RSS_INTERVAL} minutes"

# Initialize git repository
echo "[entrypoint] Initializing git repository..."
bash /app/scripts/git-init.sh

# Run initial build
echo "[entrypoint] Running initial build..."
bash /app/src/build/build.sh

echo "[entrypoint] Starting services via supervisord..."
exec supervisord -c /app/supervisord.conf
