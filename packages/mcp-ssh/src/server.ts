import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { ConnectionManager } from './connection-manager.js';
import { AuditLogger } from './audit-logger.js';
import { SnapshotManager } from './snapshot-manager.js';
import { JobTracker } from './job-tracker.js';
import { FileManager } from './file-manager.js';
import { HangDetector } from './hang-detector.js';
import { ProgressParser } from './progress-parser.js';
import type { Config } from './types.js';

export class SSHMCPServer {
  private server: McpServer;
  private config: Config;
  private connectionManager: ConnectionManager;
  private auditLogger: AuditLogger;
  private snapshotManager: SnapshotManager;
  private jobTracker: JobTracker;
  private fileManager: FileManager;
  private progressParser: ProgressParser;

  constructor(configPath?: string) {
    this.config = loadConfig(configPath);
    this.connectionManager = new ConnectionManager(this.config);
    this.auditLogger = new AuditLogger(this.config, this.connectionManager);
    this.snapshotManager = new SnapshotManager(this.config, this.connectionManager, this.auditLogger);
    this.jobTracker = new JobTracker(this.config, this.connectionManager);
    this.fileManager = new FileManager(this.config, this.snapshotManager);
    this.progressParser = new ProgressParser(this.config.streaming.progressPatterns);

    this.server = new McpServer({
      name: '@enrichedlab/mcp-ssh',
      version: '0.1.0',
    });

    this.registerTools();
  }

  private registerTools(): void {
    this.registerCoreTools();
    this.registerJobTools();
    this.registerFileTools();
    this.registerSnapshotTools();

    // Register sudo_exec only if enabled
    if (this.config.sudo?.enabled) {
      this.registerSudoTool();
    }
  }

  private registerCoreTools(): void {
    // list_hosts
    this.server.tool(
      'list_hosts',
      'List all configured SSH hosts and their connection status',
      {},
      async () => {
        const hosts = Object.entries(this.config.hosts).map(([name, cfg]) => {
          const connected = this.connectionManager.isConnected(name);
          return `${name}: ${cfg.user}@${cfg.host}:${cfg.port || 22} [${connected ? 'connected' : 'disconnected'}]`;
        });

        return {
          content: [{
            type: 'text',
            text: `Configured hosts:\n${hosts.join('\n')}\n\nDefault: ${this.config.defaultHost}`,
          }],
        };
      }
    );

    // exec
    this.server.tool(
      'exec',
      'Execute a shell command on a remote SSH host with real-time streaming output',
      {
        command: z.string().describe('The command to execute'),
        host: z.string().optional().describe('Target host name (uses default if not specified)'),
      },
      async ({ command, host }) => {
        const startTime = Date.now();
        const hostName = host || this.config.defaultHost;

        // Create hang detector for this execution
        const hangDetector = new HangDetector(this.config);
        let hangAlert: string | null = null;

        try {
          let outputBuffer = '';

          // Use streaming exec with hang detection
          const result = await new Promise<{ stdout: string; stderr: string; exitCode: number; duration: number }>((resolve, reject) => {
            hangDetector.start((msg) => {
              hangAlert = msg;
            });

            this.connectionManager.execStreaming(
              hostName,
              command,
              (chunk, isStderr) => {
                hangDetector.onActivity();
                outputBuffer += chunk;

                // Check for interactive prompts
                if (this.progressParser.isPrompt(chunk)) {
                  hangAlert = 'Command appears to be waiting for input';
                }
              }
            ).then(resolve).catch(reject);
          });

          hangDetector.stop();

          // Log to audit
          await this.auditLogger.log({
            ts: new Date().toISOString(),
            host: hostName,
            cmd: command,
            exit: result.exitCode,
            duration_ms: Date.now() - startTime,
            user: this.config.hosts[hostName].user,
            output: result.stdout.slice(0, 500),
          });

          let output = result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : '');
          if (hangAlert) {
            output = `[Warning: ${hangAlert}]\n\n${output}`;
          }

          return {
            content: [{
              type: 'text',
              text: `Exit code: ${result.exitCode}\nDuration: ${result.duration}ms\n\n${output}`,
            }],
          };
        } catch (err) {
          hangDetector.stop();
          const message = err instanceof Error ? err.message : String(err);

          await this.auditLogger.log({
            ts: new Date().toISOString(),
            host: hostName,
            cmd: command,
            exit: -1,
            duration_ms: Date.now() - startTime,
            user: this.config.hosts[hostName]?.user || 'unknown',
            output: `Error: ${message}`,
          });

          return {
            content: [{ type: 'text', text: `Error executing command: ${message}` }],
            isError: true,
          };
        }
      }
    );
  }

  private registerJobTools(): void {
    // job_start
    this.server.tool(
      'job_start',
      'Start a command as a background job and return job ID',
      {
        command: z.string().describe('Command to run in background'),
        host: z.string().optional().describe('Target host'),
        name: z.string().optional().describe('Optional job name for easier identification'),
      },
      async ({ command, host, name }) => {
        const hostName = host || this.config.defaultHost;

        try {
          const job = await this.jobTracker.start(hostName, command, name);

          await this.auditLogger.log({
            ts: new Date().toISOString(),
            host: hostName,
            cmd: `[JOB START] ${command}`,
            exit: 0,
            duration_ms: 0,
            user: this.config.hosts[hostName].user,
            output: `Job ID: ${job.id}`,
          });

          return {
            content: [{
              type: 'text',
              text: `Job started: ${job.id}\nPID: ${job.pid}\nOutput file: ${job.outputFile}`,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Failed to start job: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );

    // job_status
    this.server.tool(
      'job_status',
      'Get the status of a background job',
      {
        jobId: z.string().describe('Job ID to check'),
      },
      async ({ jobId }) => {
        try {
          const job = await this.jobTracker.getStatus(jobId);
          const duration = job.endTime
            ? new Date(job.endTime).getTime() - new Date(job.startTime).getTime()
            : Date.now() - new Date(job.startTime).getTime();

          return {
            content: [{
              type: 'text',
              text: `Job: ${job.id}${job.name ? ` (${job.name})` : ''}\nStatus: ${job.status}\nHost: ${job.host}\nPID: ${job.pid}\nDuration: ${Math.round(duration / 1000)}s${job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : ''}`,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );

    // job_output
    this.server.tool(
      'job_output',
      'Get output from a background job',
      {
        jobId: z.string().describe('Job ID'),
        tail: z.number().optional().describe('Only get last N lines'),
      },
      async ({ jobId, tail }) => {
        try {
          const output = await this.jobTracker.getOutput(jobId, tail);
          const job = this.jobTracker.get(jobId);

          return {
            content: [{
              type: 'text',
              text: `Output for job ${jobId}${tail ? ` (last ${tail} lines)` : ''}:\n\n${output}`,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );

    // job_list
    this.server.tool(
      'job_list',
      'List all background jobs',
      {
        host: z.string().optional().describe('Filter by host'),
      },
      async ({ host }) => {
        try {
          const jobs = await this.jobTracker.list(host);

          if (jobs.length === 0) {
            return {
              content: [{ type: 'text', text: 'No jobs found' }],
            };
          }

          const lines = jobs.map(j => {
            const age = Math.round((Date.now() - new Date(j.startTime).getTime()) / 1000);
            return `[${j.id}] ${j.status.padEnd(9)} ${j.host.padEnd(10)} ${age}s ago ${j.name || j.command.slice(0, 30)}`;
          });

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );

    // job_kill
    this.server.tool(
      'job_kill',
      'Terminate a running background job',
      {
        jobId: z.string().describe('Job ID to kill'),
      },
      async ({ jobId }) => {
        try {
          const killed = await this.jobTracker.kill(jobId);

          if (killed) {
            return {
              content: [{ type: 'text', text: `Job ${jobId} terminated` }],
            };
          } else {
            return {
              content: [{ type: 'text', text: `Job ${jobId} was not running` }],
            };
          }
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );
  }

  private registerFileTools(): void {
    // file_upload
    this.server.tool(
      'file_upload',
      'Upload a file to remote host via SFTP (auto-snapshots existing file)',
      {
        localPath: z.string().describe('Local file path'),
        remotePath: z.string().describe('Remote destination path'),
        host: z.string().optional().describe('Target host'),
      },
      async ({ localPath, remotePath, host }) => {
        const hostName = host || this.config.defaultHost;

        try {
          const result = await this.fileManager.upload(hostName, localPath, remotePath);

          await this.auditLogger.log({
            ts: new Date().toISOString(),
            host: hostName,
            cmd: `[SFTP UPLOAD] ${localPath} -> ${remotePath}`,
            exit: 0,
            duration_ms: 0,
            user: this.config.hosts[hostName].user,
            output: `${result.bytesTransferred} bytes`,
          });

          let msg = `Uploaded ${result.bytesTransferred} bytes to ${remotePath}`;
          if (result.snapshotId) {
            msg += `\nPrevious version saved as snapshot: ${result.snapshotId}`;
          }

          return {
            content: [{ type: 'text', text: msg }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Upload failed: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );

    // file_download
    this.server.tool(
      'file_download',
      'Download a file from remote host via SFTP',
      {
        remotePath: z.string().describe('Remote file path'),
        localPath: z.string().describe('Local destination path'),
        host: z.string().optional().describe('Target host'),
      },
      async ({ remotePath, localPath, host }) => {
        const hostName = host || this.config.defaultHost;

        try {
          const result = await this.fileManager.download(hostName, remotePath, localPath);

          await this.auditLogger.log({
            ts: new Date().toISOString(),
            host: hostName,
            cmd: `[SFTP DOWNLOAD] ${remotePath} -> ${localPath}`,
            exit: 0,
            duration_ms: 0,
            user: this.config.hosts[hostName].user,
            output: `${result.bytesTransferred} bytes`,
          });

          return {
            content: [{ type: 'text', text: `Downloaded ${result.bytesTransferred} bytes to ${localPath}` }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Download failed: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );

    // file_list
    this.server.tool(
      'file_list',
      'List contents of a remote directory',
      {
        path: z.string().describe('Remote directory path'),
        host: z.string().optional().describe('Target host'),
      },
      async ({ path, host }) => {
        const hostName = host || this.config.defaultHost;

        try {
          const files = await this.fileManager.list(hostName, path);

          if (files.length === 0) {
            return {
              content: [{ type: 'text', text: `Empty directory: ${path}` }],
            };
          }

          const lines = files.map(f => {
            const typeChar = f.type === 'd' ? 'd' : f.type === 'l' ? 'l' : '-';
            const size = f.type === 'd' ? '<dir>' : `${f.size}`;
            const date = new Date(f.modifyTime).toISOString().split('T')[0];
            return `${typeChar} ${size.padStart(10)} ${date} ${f.name}`;
          });

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `List failed: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );
  }

  private registerSnapshotTools(): void {
    // snapshot_list
    this.server.tool(
      'snapshot_list',
      'List available snapshots for restore',
      {
        host: z.string().optional().describe('Filter by host'),
        limit: z.number().optional().default(20).describe('Max snapshots to return'),
      },
      async ({ host, limit }) => {
        const snapshots = await this.snapshotManager.list(host, limit);

        if (snapshots.length === 0) {
          return {
            content: [{ type: 'text', text: 'No snapshots found' }],
          };
        }

        const lines = snapshots.map(s => {
          const typeLabel = s.type === 'git' ? 'git' : s.type === 'sftp' ? 'file' : 'tar';
          return `[${s.id}] ${s.ts.split('T')[0]} ${s.host.padEnd(10)} (${typeLabel.padEnd(4)}) ${s.path}`;
        });

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        };
      }
    );

    // snapshot_restore
    this.server.tool(
      'snapshot_restore',
      'Restore files from a snapshot',
      {
        snapshotId: z.string().describe('Snapshot ID to restore'),
      },
      async ({ snapshotId }) => {
        try {
          const result = await this.snapshotManager.restore(snapshotId);
          return {
            content: [{ type: 'text', text: result }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Restore failed: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );

    // snapshot_create
    this.server.tool(
      'snapshot_create',
      'Manually create a snapshot of a directory',
      {
        path: z.string().describe('Directory path to snapshot'),
        host: z.string().optional().describe('Target host'),
      },
      async ({ path, host }) => {
        const hostName = host || this.config.defaultHost;

        try {
          const id = await this.snapshotManager.create(hostName, path);
          return {
            content: [{ type: 'text', text: `Created snapshot: ${id}` }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Snapshot failed: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );

    // snapshot_cleanup
    this.server.tool(
      'snapshot_cleanup',
      'Clean up old snapshots based on retention policy',
      {
        host: z.string().optional().describe('Clean snapshots for specific host'),
      },
      async ({ host }) => {
        try {
          const removed = await this.snapshotManager.cleanup(host);
          return {
            content: [{ type: 'text', text: `Cleaned up ${removed} snapshots` }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Cleanup failed: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );
  }

  private registerSudoTool(): void {
    this.server.tool(
      'sudo_exec',
      'Execute a command with sudo (requires explicit enable in config)',
      {
        command: z.string().describe('Command to execute with sudo'),
        host: z.string().optional().describe('Target host'),
      },
      async ({ command, host }) => {
        const startTime = Date.now();
        const hostName = host || this.config.defaultHost;

        // Check blocklist
        const blocked = this.config.sudo?.blockedPatterns || [];
        for (const pattern of blocked) {
          if (command.includes(pattern)) {
            return {
              content: [{ type: 'text', text: `Blocked: matches dangerous pattern "${pattern}"` }],
              isError: true,
            };
          }
        }

        try {
          const result = await this.connectionManager.exec(hostName, `sudo ${command}`);

          await this.auditLogger.log({
            ts: new Date().toISOString(),
            host: hostName,
            cmd: `[SUDO] ${command}`,
            exit: result.exitCode,
            duration_ms: Date.now() - startTime,
            user: this.config.hosts[hostName].user,
            output: result.stdout.slice(0, 500),
            sudo: true,
          });

          return {
            content: [{
              type: 'text',
              text: `[SUDO] Exit code: ${result.exitCode}\n\n${result.stdout}`,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Sudo failed: ${err instanceof Error ? err.message : err}` }],
            isError: true,
          };
        }
      }
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  private async shutdown(): Promise<void> {
    await this.connectionManager.closeAll();
    await this.fileManager.closeAll();
    process.exit(0);
  }
}
