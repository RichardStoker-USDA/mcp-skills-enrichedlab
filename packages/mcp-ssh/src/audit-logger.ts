import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config, AuditLogEntry } from './types.js';
import type { ConnectionManager } from './connection-manager.js';

export class AuditLogger {
  private config: Config;
  private connectionManager: ConnectionManager;

  constructor(config: Config, connectionManager: ConnectionManager) {
    this.config = config;
    this.connectionManager = connectionManager;
  }

  async log(entry: AuditLogEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';

    // Log locally
    await this.logLocal(entry.host, line);

    // Log remotely (best effort)
    await this.logRemote(entry.host, line).catch(() => {
      // Remote logging failed, local log has it
    });
  }

  private async logLocal(hostName: string, line: string): Promise<void> {
    const localPath = join(this.config.logging.localPath, hostName, 'audit.log');

    // Ensure directory exists
    const dir = dirname(localPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    appendFileSync(localPath, line);
  }

  private async logRemote(hostName: string, line: string): Promise<void> {
    const remotePath = `${this.config.logging.remotePath}/audit.log`;

    // Escape the line for shell
    const escapedLine = line.replace(/'/g, "'\\''");

    // Append to remote log file
    const command = `mkdir -p "${dirname(remotePath)}" && echo '${escapedLine}' >> "${remotePath}"`;

    try {
      await this.connectionManager.exec(hostName, command);
    } catch {
      // Remote logging failed, ignore
    }
  }

  // Get local log path for a host
  getLocalLogPath(hostName: string): string {
    return join(this.config.logging.localPath, hostName, 'audit.log');
  }

  // Get remote log path
  getRemoteLogPath(): string {
    return `${this.config.logging.remotePath}/audit.log`;
  }
}
