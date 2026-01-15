# enrichedlab MCP Servers & Skills

Custom MCP servers and Claude Code skills I've built for my own workflows. Sharing in case others find them useful.

This is a monorepo - each package can be installed independently via npm.

---

## Packages

### [@enrichedlab/mcp-ssh](packages/mcp-ssh/)

Multi-host SSH server for Claude Code. Not just remote command execution - this handles the things that make working with remote servers tedious.

**What it does:**
- Run commands on multiple hosts with persistent connections
- Background jobs - start long builds, check back later
- SFTP uploads/downloads with auto-snapshot before overwriting files
- Hang detection - warns you when a command is stuck waiting for input
- Dual audit logging (local + remote) so you have a trail of what ran

**Quick setup:**
```bash
npx @enrichedlab/mcp-ssh --setup
claude mcp add --scope user enrichedlab-ssh -- npx @enrichedlab/mcp-ssh
```

The setup wizard handles SSH key generation and copying to your servers.

---

## Coming Soon

More packages as I build them. Structure will be:
- `packages/` - MCP servers (installable via npm)
- `skills/` - Claude Code skills

---

## Development

```bash
npm install
npm run build
```

Requires Node 24+.

## License

MIT
