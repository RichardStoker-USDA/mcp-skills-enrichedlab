import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { Config, SnapshotMetadata } from './types.js';
import type { ConnectionManager } from './connection-manager.js';
import type { AuditLogger } from './audit-logger.js';

export class SnapshotManager {
  private config: Config;
  private connectionManager: ConnectionManager;
  private auditLogger: AuditLogger;
  private localMetadataPath: string;

  constructor(config: Config, connectionManager: ConnectionManager, auditLogger: AuditLogger) {
    this.config = config;
    this.connectionManager = connectionManager;
    this.auditLogger = auditLogger;
    this.localMetadataPath = join(config.logging.localPath, 'snapshots', 'metadata.jsonl');

    // Ensure local snapshot metadata dir exists
    const dir = dirname(this.localMetadataPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Generate unique snapshot ID
  private generateId(): string {
    return `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // Create a snapshot of a path
  async create(hostName: string, path: string): Promise<string> {
    const id = this.generateId();
    const timestamp = Date.now();
    const ts = new Date().toISOString();

    // Check if path is a git directory
    const isGit = await this.isGitDirectory(hostName, path);

    let metadata: SnapshotMetadata;

    if (isGit) {
      // Git-based snapshot
      const commit = await this.createGitSnapshot(hostName, path);
      metadata = { ts, id, type: 'git', host: hostName, path, commit };
    } else {
      // Tar-based snapshot
      const backup = await this.createTarSnapshot(hostName, path, timestamp);
      metadata = { ts, id, type: 'tar', host: hostName, path, backup };
    }

    // Save metadata
    await this.saveMetadata(metadata);

    return id;
  }

  // Create snapshot for SFTP file upload
  async createFileSnapshot(hostName: string, remotePath: string): Promise<string | null> {
    if (!this.config.snapshots.autoSnapshotOnUpload) {
      return null;
    }

    // Check if file exists
    const exists = await this.fileExists(hostName, remotePath);
    if (!exists) {
      return null;
    }

    const id = this.generateId();
    const timestamp = Date.now();
    const ts = new Date().toISOString();

    // Create backup of single file
    const snapshotDir = `${this.config.logging.remotePath}/snapshots/${timestamp}`;
    const backupPath = `${snapshotDir}/${basename(remotePath)}`;

    const cmd = `mkdir -p "${snapshotDir}" && cp "${remotePath}" "${backupPath}"`;
    await this.connectionManager.exec(hostName, cmd);

    const metadata: SnapshotMetadata = {
      ts,
      id,
      type: 'sftp',
      host: hostName,
      path: remotePath,
      backup: backupPath,
    };

    await this.saveMetadata(metadata);

    return id;
  }

  // Check if path is a git directory
  private async isGitDirectory(hostName: string, path: string): Promise<boolean> {
    try {
      const result = await this.connectionManager.exec(hostName, `[ -d "${path}/.git" ] && echo "git"`);
      return result.stdout.trim() === 'git';
    } catch {
      return false;
    }
  }

  // Check if file exists
  private async fileExists(hostName: string, path: string): Promise<boolean> {
    try {
      const result = await this.connectionManager.exec(hostName, `[ -f "${path}" ] && echo "exists"`);
      return result.stdout.trim() === 'exists';
    } catch {
      return false;
    }
  }

  // Create git-based snapshot
  private async createGitSnapshot(hostName: string, path: string): Promise<string> {
    // Add and commit (allow empty in case no changes)
    const commitMsg = `snapshot: ${new Date().toISOString()}`;
    const cmd = `cd "${path}" && git add -A && git commit -m "${commitMsg}" --allow-empty 2>/dev/null; git rev-parse HEAD`;

    const result = await this.connectionManager.exec(hostName, cmd);
    return result.stdout.trim();
  }

  // Create tar-based snapshot
  private async createTarSnapshot(hostName: string, path: string, timestamp: number): Promise<string> {
    const snapshotDir = `${this.config.logging.remotePath}/snapshots/${timestamp}`;
    const tarFile = `${snapshotDir}/${basename(path)}.tar.gz`;

    const cmd = `mkdir -p "${snapshotDir}" && tar -czf "${tarFile}" -C "$(dirname ${path})" "$(basename ${path})"`;
    await this.connectionManager.exec(hostName, cmd);

    return tarFile;
  }

  // Save metadata locally
  private async saveMetadata(metadata: SnapshotMetadata): Promise<void> {
    const line = JSON.stringify(metadata) + '\n';
    appendFileSync(this.localMetadataPath, line);
  }

  // List snapshots
  async list(hostName?: string, limit = 20): Promise<SnapshotMetadata[]> {
    if (!existsSync(this.localMetadataPath)) {
      return [];
    }

    const content = readFileSync(this.localMetadataPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    let snapshots = lines
      .map(line => {
        try {
          return JSON.parse(line) as SnapshotMetadata;
        } catch {
          return null;
        }
      })
      .filter((s): s is SnapshotMetadata => s !== null);

    if (hostName) {
      snapshots = snapshots.filter(s => s.host === hostName);
    }

    // Sort by timestamp descending, take limit
    return snapshots
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, limit);
  }

  // Restore a snapshot
  async restore(snapshotId: string): Promise<string> {
    const snapshots = await this.list(undefined, 1000);
    const snapshot = snapshots.find(s => s.id === snapshotId);

    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    switch (snapshot.type) {
      case 'git':
        return this.restoreGit(snapshot);
      case 'tar':
        return this.restoreTar(snapshot);
      case 'sftp':
        return this.restoreFile(snapshot);
      default:
        throw new Error(`Unknown snapshot type: ${(snapshot as SnapshotMetadata).type}`);
    }
  }

  private async restoreGit(snapshot: SnapshotMetadata): Promise<string> {
    if (!snapshot.commit) {
      throw new Error('Git snapshot missing commit hash');
    }

    const cmd = `cd "${snapshot.path}" && git checkout ${snapshot.commit}`;
    await this.connectionManager.exec(snapshot.host, cmd);

    return `Restored git commit ${snapshot.commit.slice(0, 8)} in ${snapshot.path}`;
  }

  private async restoreTar(snapshot: SnapshotMetadata): Promise<string> {
    if (!snapshot.backup) {
      throw new Error('Tar snapshot missing backup path');
    }

    const parentDir = dirname(snapshot.path);
    const cmd = `tar -xzf "${snapshot.backup}" -C "${parentDir}"`;
    await this.connectionManager.exec(snapshot.host, cmd);

    return `Restored ${snapshot.path} from tar backup`;
  }

  private async restoreFile(snapshot: SnapshotMetadata): Promise<string> {
    if (!snapshot.backup) {
      throw new Error('File snapshot missing backup path');
    }

    const cmd = `cp "${snapshot.backup}" "${snapshot.path}"`;
    await this.connectionManager.exec(snapshot.host, cmd);

    return `Restored file ${snapshot.path}`;
  }

  // Cleanup old snapshots
  async cleanup(hostName?: string): Promise<number> {
    const retention = this.config.snapshots.retention;
    const cutoffDate = Date.now() - retention.maxAgeDays * 24 * 60 * 60 * 1000;

    const snapshots = await this.list(hostName, 10000);
    let removed = 0;

    // Keep track of which to keep (most recent per host, up to keepMinCount)
    const byHost = new Map<string, SnapshotMetadata[]>();
    for (const s of snapshots) {
      const list = byHost.get(s.host) || [];
      list.push(s);
      byHost.set(s.host, list);
    }

    for (const snapshot of snapshots) {
      const hostSnapshots = byHost.get(snapshot.host) || [];
      const index = hostSnapshots.indexOf(snapshot);

      // Skip if within keepMinCount
      if (index < retention.keepMinCount) {
        continue;
      }

      const snapshotTime = new Date(snapshot.ts).getTime();

      // Remove if older than cutoff
      if (snapshotTime < cutoffDate) {
        await this.removeSnapshot(snapshot);
        removed++;
      }
    }

    // TODO: Also check size limits

    return removed;
  }

  private async removeSnapshot(snapshot: SnapshotMetadata): Promise<void> {
    // Remove backup file/directory on remote
    if (snapshot.backup) {
      try {
        const cmd = `rm -rf "${snapshot.backup}"`;
        await this.connectionManager.exec(snapshot.host, cmd);
      } catch {
        // Best effort
      }
    }

    // Note: We don't remove from metadata file, just filter on read
    // A proper implementation would rewrite the file
  }
}
