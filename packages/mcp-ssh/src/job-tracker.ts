import type { Config, Job, JobStatus } from './types.js';
import type { ConnectionManager } from './connection-manager.js';

export class JobTracker {
  private config: Config;
  private connectionManager: ConnectionManager;
  private jobs: Map<string, Job> = new Map();

  constructor(config: Config, connectionManager: ConnectionManager) {
    this.config = config;
    this.connectionManager = connectionManager;
  }

  // Generate unique job ID
  private generateId(): string {
    return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  // Start a background job
  async start(hostName: string, command: string, name?: string): Promise<Job> {
    const id = this.generateId();
    const outputFile = `/tmp/enrichedlab_job_${id}.out`;
    const pidFile = `/tmp/enrichedlab_job_${id}.pid`;

    // Run command with nohup, redirect output, save PID
    const wrappedCmd = `nohup sh -c '${command.replace(/'/g, "'\\''")}' > "${outputFile}" 2>&1 & echo $! > "${pidFile}"`;

    await this.connectionManager.exec(hostName, wrappedCmd);

    // Get the PID
    const pidResult = await this.connectionManager.exec(hostName, `cat "${pidFile}"`);
    const pid = parseInt(pidResult.stdout.trim(), 10);

    const job: Job = {
      id,
      host: hostName,
      command,
      name,
      status: 'running',
      pid,
      startTime: new Date().toISOString(),
      outputFile,
    };

    this.jobs.set(id, job);

    return job;
  }

  // Get job status
  async getStatus(jobId: string): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Check if still running
    if (job.status === 'running') {
      const checkCmd = `ps -p ${job.pid} -o pid= 2>/dev/null || echo "done"`;
      const result = await this.connectionManager.exec(job.host, checkCmd);

      if (result.stdout.trim() === 'done' || result.stdout.trim() === '') {
        // Process finished, get exit code from output
        const exitResult = await this.connectionManager.exec(
          job.host,
          `wait ${job.pid} 2>/dev/null; echo $?`
        );

        const exitCode = parseInt(exitResult.stdout.trim(), 10) || 0;
        job.status = exitCode === 0 ? 'completed' : 'failed';
        job.exitCode = exitCode;
        job.endTime = new Date().toISOString();
      }
    }

    return job;
  }

  // Get job output
  async getOutput(jobId: string, tail?: number): Promise<string> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    let cmd: string;
    if (tail && tail > 0) {
      cmd = `tail -n ${tail} "${job.outputFile}" 2>/dev/null || echo "[No output yet]"`;
    } else {
      cmd = `cat "${job.outputFile}" 2>/dev/null || echo "[No output yet]"`;
    }

    const result = await this.connectionManager.exec(job.host, cmd);
    return result.stdout;
  }

  // List all jobs
  async list(hostName?: string): Promise<Job[]> {
    let jobs = Array.from(this.jobs.values());

    if (hostName) {
      jobs = jobs.filter(j => j.host === hostName);
    }

    // Update status for running jobs
    for (const job of jobs) {
      if (job.status === 'running') {
        await this.getStatus(job.id);
      }
    }

    return jobs.sort((a, b) =>
      new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );
  }

  // Kill a running job
  async kill(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== 'running') {
      return false;
    }

    const killCmd = `kill ${job.pid} 2>/dev/null && echo "killed" || echo "failed"`;
    const result = await this.connectionManager.exec(job.host, killCmd);

    if (result.stdout.trim() === 'killed') {
      job.status = 'failed';
      job.exitCode = -9;
      job.endTime = new Date().toISOString();
      return true;
    }

    return false;
  }

  // Clean up job output files
  async cleanup(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    try {
      await this.connectionManager.exec(
        job.host,
        `rm -f "${job.outputFile}" "/tmp/enrichedlab_job_${job.id}.pid"`
      );
    } catch {
      // Best effort
    }

    this.jobs.delete(jobId);
  }

  // Get job by ID
  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }
}
