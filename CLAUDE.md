# SelfProgramingDockerAgent

A single Docker image containing a self-modifying news website powered by Docker Agent (cagent).

## Architecture

Two AI agents run inside the container alongside a static site served by nginx:

1. **News Agent** (`agents/news-agent.yaml`) — multi-agent pipeline running every N minutes via cron. An orchestrator (root) coordinates 4 sub-agents: **fetcher** (RSS via MCP), **selector** (picks best article by persona interests), **writer** (creates descriptions from author persona), **reviewer** (quality/style check with up to 3 revision iterations). Writes results to `src/data/news.json` and rebuilds the static site. Persona configuration via `NEWS_AUTHOR_PERSONA` and `NEWS_SELECTOR_PERSONA` env vars.

2. **Dev Agent** (`agents/dev-agent.yaml`) — exposed via `cagent serve api` on internal port 8080, accessible through the admin chat UI at `/admin.html` (Basic Auth protected). Accepts instructions to modify the website source code, rebuilds and deploys changes live without Docker restart. Uses **git worktrees** for isolation: each session creates a feature branch + worktree at `/app/sessions/{session-id}/`, and merges back to main on deploy. Includes a **git_agent** sub-agent for git operations and error recovery (merge conflicts, broken worktrees).

## Processes (supervisord)

- **nginx** (:80) — serves `dist/`, proxies `/api/*` to cagent API
- **cagent serve api** (:8080) — dev-agent HTTP API
- **crond** — runs news-agent periodically

## Build & Run

```bash
docker compose up --build
```

Open `http://localhost:8080` for the news site, `http://localhost:8080/admin.html` for admin chat.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `AZURE_RESOURCE_NAME` | Azure OpenAI resource name | (required) |
| `AZURE_API_KEY` | Azure OpenAI API key | (required) |
| `ANTHROPIC_API_KEY` | Anthropic API key (for dev-agent implementer) | (required) |
| `ADMIN_PASSWORD` | Basic Auth password for admin UI | `admin` |
| `RSS_INTERVAL_MINUTES` | How often news agent runs | `60` |
| `NEWS_AUTHOR_PERSONA` | Writing perspective for news descriptions (e.g. "Cloud Architect specializing in Azure, AI/ML") | `Cloud Solutions Architect and AI Evangelist` |
| `NEWS_SELECTOR_PERSONA` | Interest filter for news prioritization (e.g. "cloud architecture, AI/ML, .NET") | `cloud architecture, AI/ML, DevOps, security` |
| `GIT_REPO_URL` | Git repo to clone on startup (optional) | (local init) |
| `GIT_BRANCH` | Base branch name | `main` |
| `GIT_TOKEN` | HTTPS token for private repos (GitHub PAT, GitLab token, etc.) | (none) |
| `GIT_SSH_KEY` | Raw SSH private key content for private repos | (none) |
| `GIT_SSH_KEY_PATH` | Path to mounted SSH key file | (none) |
| `GIT_USER_NAME` | Git commit author name | `Tech Pulse Agent` |
| `GIT_USER_EMAIL` | Git commit author email | `agent@techpulse.local` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector endpoint | `http://tempo:4317` |
| `OTEL_SERVICE_NAME` | Service name for traces | `tech-pulse-agent` |

## Observability

Both agents run with `--otel` flag, exporting OpenTelemetry traces to Grafana Tempo.

- **Grafana** (`http://localhost:3000`) — trace visualization, no login required
- **Tempo** (`http://localhost:3200`) — trace storage, receives OTLP on ports 4317 (gRPC) / 4318 (HTTP)

Traces include: agent sessions, sub-agent delegations (transfer_task), tool calls with timing, token usage per model, errors. Message content is NOT included in traces (privacy) — use `--debug --log-file` for full conversation logs.

Config files: `observability/tempo.yaml`, `observability/grafana/provisioning/`

## File Structure

- `agents/` — Docker Agent YAML configs (news-agent, dev-agent)
- `src/frontend/templates/` — HTML templates (index, article, admin)
- `src/frontend/static/` — CSS, JS static assets
- `src/data/news.json` — published news data (JSON array)
- `src/config/feeds.json` — RSS feed URLs
- `src/build/build.sh` — static site generator (bash + jq)
- `scripts/git-init.sh` — git repo initialization (clone or local init)
- `scripts/git-worktree.sh` — worktree lifecycle (create/deploy/discard/delete/activate/status)
- `dist/` — generated static site (nginx serves this, gitignored)
- `observability/` — Tempo + Grafana config for OpenTelemetry tracing

## Build Script

`src/build/build.sh` generates `dist/` from templates + news data. Called by both agents after making changes. Uses `jq` for JSON, `sed` for template substitution.

## Git Workflow

On startup, `scripts/git-init.sh` initializes a git repo in `/app/src`:
- **Without `GIT_REPO_URL`**: `git init` + initial commit of existing files
- **With `GIT_REPO_URL`**: clones the remote repo (supports SSH key, HTTPS token, or mounted key file for private repos)

The dev agent uses **git worktrees** for each session:
1. On session creation: creates feature branch `feature/{session-id}` + worktree at `/app/sessions/{session-id}/`
2. `/app/workdir` symlink points to the active session's worktree
3. Makes changes in the worktree (isolated from main)
4. On deploy: merges feature branch → main, keeps worktree, rebuilds site
5. On discard: resets worktree to base commit (keeps folder and branch)
6. On session delete: removes worktree directory and deletes feature branch

Multiple sessions can have worktrees simultaneously; only one is active at a time. The deploy script auto-commits any pending `news.json` changes on main before merging (safety net for news agent writes). The `git_agent` sub-agent handles all git operations and can resolve merge conflicts or fix broken worktrees.

## Adding RSS Feeds

Edit `src/config/feeds.json` — array of `{"name": "...", "url": "..."}` objects.

## Conventions

- Frontend: plain HTML + vanilla CSS + vanilla JS, no frameworks
- Build: pure bash + jq, no Node.js build tools
- Agents: Docker Agent YAML format, multi-agent via sub_agents, models `azure/gpt-5.4-mini` + `anthropic/claude-sonnet-4-6` (implementer)
- All news summaries in English
