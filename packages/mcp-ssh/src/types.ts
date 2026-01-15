// Host configuration
export interface HostConfig {
  host: string;
  port?: number;
  user: string;
  keyPath?: string;
  allowPasswordAuth?: boolean;
}

// Streaming configuration
export interface StreamingConfig {
  enabled: boolean;
  hangTimeoutMs: number;
  progressPatterns: boolean;
}

// Logging configuration
export interface LoggingConfig {
  localPath: string;
  remotePath: string;
}

// Snapshot retention configuration
export interface SnapshotRetention {
  maxAgeDays: number;
  maxSizeMB: number;
  keepMinCount: number;
}

// Snapshot configuration
export interface SnapshotConfig {
  enabled: boolean;
  trackedPaths: string[];
  autoSnapshotOnUpload: boolean;
  autoSnapshotOnExec: boolean;
  retention: SnapshotRetention;
}

// Sudo configuration (hidden feature)
export interface SudoConfig {
  enabled: boolean;
  blockedPatterns: string[];
}

// Full config
export interface Config {
  hosts: Record<string, HostConfig>;
  defaultHost: string;
  streaming: StreamingConfig;
  logging: LoggingConfig;
  snapshots: SnapshotConfig;
  sudo?: SudoConfig;
}

// Audit log entry
export interface AuditLogEntry {
  ts: string;
  host: string;
  cmd: string;
  exit: number;
  duration_ms: number;
  user: string;
  output?: string;
  sudo?: boolean;
}

// Snapshot metadata
export interface SnapshotMetadata {
  ts: string;
  id: string;
  type: 'sftp' | 'git' | 'tar';
  host: string;
  path: string;
  backup?: string;
  commit?: string;
}

// Job status
export type JobStatus = 'running' | 'completed' | 'failed';

// Background job
export interface Job {
  id: string;
  host: string;
  command: string;
  name?: string;
  status: JobStatus;
  pid: number;
  startTime: string;
  endTime?: string;
  exitCode?: number;
  outputFile: string;
}

// Exec result
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

// Progress info parsed from output
export interface ProgressInfo {
  current?: number;
  total?: number;
  message: string;
  type: 'docker' | 'package' | 'percentage' | 'generic';
}
