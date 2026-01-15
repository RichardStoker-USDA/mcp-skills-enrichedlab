#!/usr/bin/env node

import { SSHMCPServer } from './server.js';
import { runSetup, addHost } from './setup.js';

const args = process.argv.slice(2);

// Handle CLI commands
if (args.includes('--setup') || args.includes('setup')) {
  runSetup().then(() => process.exit(0)).catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
} else if (args.includes('--add-host') || args.includes('add-host')) {
  addHost().then(() => process.exit(0)).catch((err) => {
    console.error('Add host failed:', err);
    process.exit(1);
  });
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`
@enrichedlab/mcp-ssh - SSH MCP server with streaming, snapshots, and dual logging

Usage:
  npx @enrichedlab/mcp-ssh [options] [config-path]

Options:
  --setup       Run interactive setup wizard
  --add-host    Add a new SSH host to config
  --help, -h    Show this help

Examples:
  npx @enrichedlab/mcp-ssh --setup              # First-time setup
  npx @enrichedlab/mcp-ssh --add-host           # Add another host
  npx @enrichedlab/mcp-ssh                      # Start MCP server
  npx @enrichedlab/mcp-ssh ~/my-config.json     # Use custom config

Add to Claude Code (all projects):
  claude mcp add --scope user enrichedlab-ssh -- npx @enrichedlab/mcp-ssh
`);
  process.exit(0);
} else {
  // Start MCP server
  const configPath = args.find(a => !a.startsWith('-'));

  const server = new SSHMCPServer(configPath);
  server.start().catch((err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
}
