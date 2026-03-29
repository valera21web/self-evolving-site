#!/bin/sh
set -e

SRC="/app/src"
GIT_BRANCH="${GIT_BRANCH:-main}"
GIT_USER_NAME="${GIT_USER_NAME:-Tech Pulse Agent}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-agent@techpulse.local}"

# Skip if already initialized
if [ -d "$SRC/.git" ]; then
    echo "[git-init] Repository already initialized, skipping."
    exit 0
fi

echo "[git-init] Configuring git identity: $GIT_USER_NAME <$GIT_USER_EMAIL>"
git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"
git config --global init.defaultBranch "$GIT_BRANCH"

if [ -n "$GIT_REPO_URL" ]; then
    echo "[git-init] Remote repo configured: $GIT_REPO_URL"

    # Setup SSH key auth (from env var content)
    if [ -n "$GIT_SSH_KEY" ]; then
        echo "[git-init] Configuring SSH key authentication..."
        mkdir -p /root/.ssh
        echo "$GIT_SSH_KEY" > /root/.ssh/id_rsa
        chmod 600 /root/.ssh/id_rsa
        ssh-keyscan github.com gitlab.com bitbucket.org >> /root/.ssh/known_hosts 2>/dev/null
    fi

    # Setup SSH key auth (from mounted file path)
    if [ -n "$GIT_SSH_KEY_PATH" ] && [ -f "$GIT_SSH_KEY_PATH" ]; then
        echo "[git-init] Configuring SSH key from path: $GIT_SSH_KEY_PATH"
        mkdir -p /root/.ssh
        cp "$GIT_SSH_KEY_PATH" /root/.ssh/id_rsa
        chmod 600 /root/.ssh/id_rsa
        ssh-keyscan github.com gitlab.com bitbucket.org >> /root/.ssh/known_hosts 2>/dev/null
    fi

    # Setup HTTPS token auth
    if [ -n "$GIT_TOKEN" ]; then
        echo "[git-init] Configuring HTTPS token authentication..."
        GIT_HOST=$(echo "$GIT_REPO_URL" | sed 's|https://||;s|/.*||')
        git config --global credential.helper store
        echo "https://oauth2:${GIT_TOKEN}@${GIT_HOST}" > /root/.git-credentials
    fi

    # Initialize and fetch from remote
    cd "$SRC"
    git init
    git remote add origin "$GIT_REPO_URL"
    echo "[git-init] Fetching from origin..."
    git fetch origin
    git checkout -B "$GIT_BRANCH" "origin/$GIT_BRANCH"
    echo "[git-init] Checked out branch '$GIT_BRANCH' from remote."
else
    echo "[git-init] No GIT_REPO_URL set, initializing local repository."
    cd "$SRC"
    git init
    git checkout -b "$GIT_BRANCH"
    git add -A
    git commit -m "Initial state"
    echo "[git-init] Local repository initialized on branch '$GIT_BRANCH'."
fi
