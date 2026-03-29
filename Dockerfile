FROM alpine:3.20

# Install system dependencies
RUN apk add --no-cache \
    nginx \
    supervisor \
    curl \
    jq \
    bash \
    openssl \
    nodejs \
    npm \
    python3 \
    git \
    openssh-client

# Install cagent (Docker Agent CLI)
ARG CAGENT_VERSION=v1.39.0
ARG TARGETARCH=amd64
RUN curl -fSL "https://github.com/docker/docker-agent/releases/download/${CAGENT_VERSION}/docker-agent-linux-${TARGETARCH}" \
    -o /usr/local/bin/cagent && \
    chmod +x /usr/local/bin/cagent

# Pre-install MCP servers so they're available offline at runtime
RUN npm install -g rss-reader-mcp

# Create app directory
WORKDIR /app

# Copy project files
COPY . /app/

# Make scripts executable
RUN chmod +x /app/src/build/build.sh /app/src/build/deploy.sh /app/scripts/entrypoint.sh /app/scripts/git-init.sh /app/scripts/git-worktree.sh

# Create necessary directories
RUN mkdir -p /app/dist /app/sessions /var/log/nginx /var/run/nginx

# Copy nginx config
RUN cp /app/nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
