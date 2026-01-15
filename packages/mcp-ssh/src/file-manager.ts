import SftpClient from 'ssh2-sftp-client';
import { readFileSync } from 'node:fs';
import type { Config } from './types.js';
import type { SnapshotManager } from './snapshot-manager.js';

interface FileInfo {
  name: string;
  type: 'd' | '-' | 'l';
  size: number;
  modifyTime: number;
  accessTime: number;
  rights: {
    user: string;
    group: string;
    other: string;
  };
  owner: number;
  group: number;
}

export class FileManager {
  private config: Config;
  private snapshotManager: SnapshotManager;
  private sftpClients: Map<string, SftpClient> = new Map();

  constructor(config: Config, snapshotManager: SnapshotManager) {
    this.config = config;
    this.snapshotManager = snapshotManager;
  }

  private async getSftpClient(hostName: string): Promise<SftpClient> {
    const existing = this.sftpClients.get(hostName);
    if (existing) {
      return existing;
    }

    const hostConfig = this.config.hosts[hostName];
    if (!hostConfig) {
      throw new Error(`Unknown host: ${hostName}`);
    }

    const client = new SftpClient();

    const connectConfig: SftpClient.ConnectOptions = {
      host: hostConfig.host,
      port: hostConfig.port || 22,
      username: hostConfig.user,
    };

    if (hostConfig.keyPath) {
      connectConfig.privateKey = readFileSync(hostConfig.keyPath);
    }

    await client.connect(connectConfig);
    this.sftpClients.set(hostName, client);

    return client;
  }

  // Upload a file
  async upload(
    hostName: string,
    localPath: string,
    remotePath: string
  ): Promise<{ snapshotId: string | null; bytesTransferred: number }> {
    const client = await this.getSftpClient(hostName);

    // Create snapshot of existing file before overwriting
    let snapshotId: string | null = null;
    if (this.config.snapshots.autoSnapshotOnUpload) {
      try {
        snapshotId = await this.snapshotManager.createFileSnapshot(hostName, remotePath);
      } catch {
        // File might not exist, that's fine
      }
    }

    // Upload the file
    await client.put(localPath, remotePath);

    // Get file size for reporting
    const stats = await client.stat(remotePath);
    const bytesTransferred = stats.size;

    return { snapshotId, bytesTransferred };
  }

  // Download a file
  async download(
    hostName: string,
    remotePath: string,
    localPath: string
  ): Promise<{ bytesTransferred: number }> {
    const client = await this.getSftpClient(hostName);

    await client.get(remotePath, localPath);

    // Get remote file size
    const stats = await client.stat(remotePath);

    return { bytesTransferred: stats.size };
  }

  // List directory contents
  async list(hostName: string, remotePath: string): Promise<FileInfo[]> {
    const client = await this.getSftpClient(hostName);

    const listing = await client.list(remotePath);

    return listing.map(item => ({
      name: item.name,
      type: item.type,
      size: item.size,
      modifyTime: item.modifyTime,
      accessTime: item.accessTime,
      rights: item.rights,
      owner: item.owner,
      group: item.group,
    }));
  }

  // Check if file exists
  async exists(hostName: string, remotePath: string): Promise<boolean> {
    const client = await this.getSftpClient(hostName);

    try {
      await client.stat(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  // Get file info
  async stat(hostName: string, remotePath: string): Promise<SftpClient.FileStats> {
    const client = await this.getSftpClient(hostName);
    return client.stat(remotePath);
  }

  // Close all SFTP connections
  async closeAll(): Promise<void> {
    for (const [, client] of this.sftpClients) {
      await client.end();
    }
    this.sftpClients.clear();
  }

  // Close specific connection
  async close(hostName: string): Promise<void> {
    const client = this.sftpClients.get(hostName);
    if (client) {
      await client.end();
      this.sftpClients.delete(hostName);
    }
  }
}
