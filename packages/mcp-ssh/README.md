# @enrichedlab/mcp-ssh

SSH MCP server with real-time streaming, dual logging, and snapshots.

> **Note:** MCP servers can execute code on your machines. Only install from sources you trust and have reviewed - including this one. The source is available in this repo; read it before running.

## Features

- **Real-time streaming** - Output streams back as commands run, not after completion
- **Hang detection** - Get alerted when something's stuck or waiting for input
- **Dual logging** - Commands logged on remote server AND local machine
- **Snapshots** - Git-first snapshots with tar fallback for file rollback
- **Multi-host** - Manage multiple Linux servers from one MCP
- **Background jobs** - Start long commands, check status later
- **SFTP** - Upload, download, list remote files

## Quick Start

Run the interactive setup wizard:

```bash
npx @enrichedlab/mcp-ssh --setup
```

This will:
1. Create `~/.enrichedlab/` config directory
2. Generate SSH key (`~/.ssh/enrichedlab_key`)
3. Prompt for your server details
4. Copy SSH key to your servers
5. Create the config file
6. Test connections

Then add to Claude:
```bash
claude mcp add --scope user enrichedlab-ssh -- npx @enrichedlab/mcp-ssh
```

## Manual Setup

### 1. Create config file

`~/.enrichedlab/ssh-config.json`:

```json
{
  "hosts": {
    "dev": {
      "host": "10.0.0.1",
      "user": "llmuser",
      "keyPath": "~/.ssh/id_ed25519"
    },
    "prod": {
      "host": "10.0.0.2",
      "user": "llmuser",
      "keyPath": "~/.ssh/id_ed25519"
    }
  },
  "defaultHost": "dev",
  "streaming": {
    "enabled": true,
    "hangTimeoutMs": 30000,
    "progressPatterns": true
  },
  "logging": {
    "localPath": "~/.enrichedlab/logs",
    "remotePath": "~/.enrichedlab"
  },
  "snapshots": {
    "enabled": true,
    "trackedPaths": ["/home/llmuser/code"],
    "autoSnapshotOnUpload": true,
    "autoSnapshotOnExec": false,
    "retention": {
      "maxAgeDays": 14,
      "maxSizeMB": 500,
      "keepMinCount": 10
    }
  }
}
```

### 2. Add to Claude Code

```bash
claude mcp add --scope user enrichedlab-ssh -- npx @enrichedlab/mcp-ssh
```

Or with explicit config path:
```bash
claude mcp add --scope user enrichedlab-ssh -- npx @enrichedlab/mcp-ssh ~/.enrichedlab/ssh-config.json
```

## Tools

### Core

| Tool | Description |
|------|-------------|
| `exec` | Run command with streaming output and hang detection |
| `list_hosts` | Show configured hosts and connection status |

### Background Jobs

| Tool | Description |
|------|-------------|
| `job_start` | Start a command as a background job |
| `job_status` | Get status of a background job |
| `job_output` | Get output from a background job |
| `job_list` | List all background jobs |
| `job_kill` | Terminate a running job |

### File Operations

| Tool | Description |
|------|-------------|
| `file_upload` | Upload file via SFTP (auto-snapshots existing) |
| `file_download` | Download file via SFTP |
| `file_list` | List remote directory contents |

### Snapshots

| Tool | Description |
|------|-------------|
| `snapshot_create` | Manually create a snapshot |
| `snapshot_list` | List available snapshots |
| `snapshot_restore` | Restore from a snapshot |
| `snapshot_cleanup` | Clean old snapshots |

## Config Reference

### hosts

```json
{
  "myhost": {
    "host": "10.0.0.1",
    "port": 22,
    "user": "llmuser",
    "keyPath": "~/.ssh/id_ed25519",
    "allowPasswordAuth": false
  }
}
```

- `keyPath` - SSH private key (recommended)
- `allowPasswordAuth` - Enable password auth (debugging only, prompts at startup)

### streaming

```json
{
  "enabled": true,
  "hangTimeoutMs": 30000,
  "progressPatterns": true
}
```

- `hangTimeoutMs` - Alert after this many ms of no output
- `progressPatterns` - Parse Docker/npm/apt progress

### snapshots

```json
{
  "enabled": true,
  "trackedPaths": ["/home/llmuser/code"],
  "autoSnapshotOnUpload": true,
  "autoSnapshotOnExec": false,
  "retention": {
    "maxAgeDays": 14,
    "maxSizeMB": 500,
    "keepMinCount": 10
  }
}
```

- `trackedPaths` - Directories to snapshot before exec (if autoSnapshotOnExec)
- `autoSnapshotOnUpload` - Backup files before SFTP upload overwrites them
- Git directories use git commits, others use tar

## Logging

Commands logged to two places:

**Remote:** `~/.enrichedlab/audit.log` on each host
**Local:** `~/.enrichedlab/logs/{hostname}/audit.log`

Format is JSONL:
```json
{"ts":"2026-01-14T10:30:45Z","host":"dev","cmd":"docker ps","exit":0,"duration_ms":234}
```

## Examples

```
# Run command on default host
exec command="docker ps"

# Run on specific host
exec host="prod" command="systemctl status nginx"

# Start background build
job_start command="docker build -t myapp ." name="build-myapp"

# Check job status
job_status jobId="job_abc123"

# Get last 50 lines of output
job_output jobId="job_abc123" tail=50

# Upload config file
file_upload localPath="/tmp/nginx.conf" remotePath="/etc/nginx/nginx.conf"

# Create snapshot before risky operation
snapshot_create path="/home/llmuser/myproject"

# List snapshots
snapshot_list limit=10

# Restore if something went wrong
snapshot_restore snapshotId="snap_xyz789"
```

## CLI Commands

```bash
# First-time setup (interactive wizard)
npx @enrichedlab/mcp-ssh --setup

# Add another host to existing config
npx @enrichedlab/mcp-ssh --add-host

# Start MCP server (default config)
npx @enrichedlab/mcp-ssh

# Start with custom config
npx @enrichedlab/mcp-ssh ~/my-config.json

# Show help
npx @enrichedlab/mcp-ssh --help
```

## License

MIT
