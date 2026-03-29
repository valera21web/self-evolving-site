#!/bin/sh
set -e

SRC="/app/src"
WORKDIR="/app/workdir"
GIT_BRANCH="${GIT_BRANCH:-main}"

usage() {
    echo "Usage: git-worktree.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  create <session-id>   Create or reuse session worktree"
    echo "  deploy                Merge to main, rebuild, keep worktree"
    echo "  discard               Remove active session worktree"
    echo "  activate <session-id> Switch symlink to session worktree"
    echo "  status                Show current worktree state"
    exit 1
}

# Get the actual worktree path for a session
session_dir() {
    echo "/app/workdir-${1}"
}

# Get active session ID from marker file
active_session() {
    cat /app/.active-session 2>/dev/null || echo ""
}

# Update symlink /app/workdir → /app/workdir-<session>
update_symlink() {
    SDIR="$1"
    rm -f "$WORKDIR"
    ln -sf "$SDIR" "$WORKDIR"
}

cmd_create() {
    SESSION_ID="$1"
    if [ -z "$SESSION_ID" ]; then
        # Fall back to active session or generate new ID
        SESSION_ID=$(active_session)
        if [ -z "$SESSION_ID" ]; then
            SESSION_ID="$(date +%s)"
        fi
    fi

    SDIR=$(session_dir "$SESSION_ID")
    cd "$SRC"

    if [ -d "$SDIR" ]; then
        # Worktree already exists for this session — sync with main
        echo "[worktree] Session worktree exists at $SDIR, syncing with $GIT_BRANCH..."
        cd "$SDIR"
        git merge "$GIT_BRANCH" --no-edit -m "Sync with $GIT_BRANCH" 2>/dev/null || true
        cd "$SRC"
        update_symlink "$SDIR"
        echo "$SESSION_ID" > /app/.active-session
        echo "[worktree] Synced and ready at $WORKDIR (session: $SESSION_ID)."
        return
    fi

    # Create new worktree
    BRANCH="feature/${SESSION_ID}"
    if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
        # Branch exists from a previous run, reuse it
        git branch -f "$BRANCH" "$GIT_BRANCH"
        git worktree add "$SDIR" "$BRANCH"
        echo "[worktree] Reusing branch '$BRANCH'."
    else
        git worktree add -b "$BRANCH" "$SDIR" "$GIT_BRANCH"
        echo "[worktree] Created new branch '$BRANCH'."
    fi

    # Save base commit for cumulative diffs
    git rev-parse HEAD > "/app/.branch-base-${SESSION_ID}"

    update_symlink "$SDIR"
    echo "$SESSION_ID" > /app/.active-session
    echo "[worktree] Worktree ready at $WORKDIR (session: $SESSION_ID)."
}

cmd_deploy() {
    ACTIVE=$(active_session)
    if [ -z "$ACTIVE" ]; then
        echo "[worktree] ERROR: No active session"
        exit 1
    fi

    SDIR=$(session_dir "$ACTIVE")
    if [ ! -d "$SDIR" ]; then
        echo "[worktree] ERROR: No worktree at $SDIR"
        exit 1
    fi

    BRANCH=$(git -C "$SDIR" branch --show-current)
    echo "[worktree] Deploying session '$ACTIVE' (branch: $BRANCH)..."

    # Commit any uncommitted changes in the worktree
    cd "$SDIR"
    git add -A
    if git diff --cached --quiet; then
        echo "[worktree] No new changes to commit."
    else
        git commit -m "Dev agent changes ($BRANCH)"
        echo "[worktree] Committed worktree changes."
    fi

    # Switch to main and auto-commit pending news.json
    cd "$SRC"
    if ! git diff --quiet -- data/news.json 2>/dev/null; then
        echo "[worktree] Auto-committing pending news.json..."
        git add data/news.json
        git commit -m "Auto-commit: news agent updates"
    fi

    # Merge feature branch into main
    echo "[worktree] Merging '$BRANCH' into '$GIT_BRANCH'..."
    if ! git merge "$BRANCH" --no-edit -m "Merge $BRANCH"; then
        echo "[worktree] ERROR: Merge conflict! Aborting."
        git merge --abort
        exit 1
    fi

    # Sync worktree with main (so it has the merged state)
    cd "$SDIR"
    git merge "$GIT_BRANCH" --no-edit 2>/dev/null || true

    # Rebuild the site
    echo "[worktree] Rebuilding site..."
    bash /app/src/build/build.sh

    echo "[worktree] Deploy complete. Worktree kept for session '$ACTIVE'."
}

cmd_discard() {
    ACTIVE=$(active_session)
    if [ -z "$ACTIVE" ]; then
        echo "[worktree] No active session to discard."
        exit 0
    fi

    SDIR=$(session_dir "$ACTIVE")
    if [ ! -d "$SDIR" ]; then
        echo "[worktree] No worktree to discard."
        rm -f /app/.active-session "/app/.branch-base-${ACTIVE}"
        rm -f "$WORKDIR"
        exit 0
    fi

    BRANCH=$(git -C "$SDIR" branch --show-current)
    echo "[worktree] Discarding session '$ACTIVE' (branch: $BRANCH)..."

    cd "$SRC"
    git worktree remove "$SDIR" --force
    git branch -D "$BRANCH" 2>/dev/null || true
    rm -f /app/.active-session "/app/.branch-base-${ACTIVE}"
    rm -f "$WORKDIR"

    echo "[worktree] Discarded session '$ACTIVE'."
}

cmd_activate() {
    SESSION_ID="$1"
    if [ -z "$SESSION_ID" ]; then
        echo "[worktree] ERROR: session-id required"
        exit 1
    fi

    SDIR=$(session_dir "$SESSION_ID")
    if [ -d "$SDIR" ]; then
        update_symlink "$SDIR"
        echo "$SESSION_ID" > /app/.active-session
        echo "[worktree] Activated session '$SESSION_ID'."
    else
        # No worktree for this session — clear symlink
        rm -f "$WORKDIR" /app/.active-session
        echo "[worktree] No worktree for session '$SESSION_ID'."
    fi
}

cmd_status() {
    ACTIVE=$(active_session)
    echo "=== Active session: ${ACTIVE:-none} ==="
    cd "$SRC"
    echo "=== Git Worktrees ==="
    git worktree list
    echo ""
    if [ -n "$ACTIVE" ] && [ -d "$(session_dir "$ACTIVE")" ]; then
        SDIR=$(session_dir "$ACTIVE")
        BRANCH=$(git -C "$SDIR" branch --show-current)
        echo "=== Worktree: $SDIR (branch: $BRANCH) ==="
        echo "--- Changed files ---"
        git -C "$SDIR" diff --stat
        git -C "$SDIR" diff --cached --stat
    else
        echo "No active worktree."
    fi
}

# Main dispatch
COMMAND="${1:-}"
shift 2>/dev/null || true

case "$COMMAND" in
    create)   cmd_create "$@" ;;
    deploy)   cmd_deploy ;;
    discard)  cmd_discard ;;
    activate) cmd_activate "$@" ;;
    status)   cmd_status ;;
    *)        usage ;;
esac
