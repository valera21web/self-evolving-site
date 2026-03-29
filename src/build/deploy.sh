#!/bin/bash
set -e
# Deploy changes from git worktree to main branch and rebuild
# Usage: deploy.sh

exec bash /app/scripts/git-worktree.sh deploy
