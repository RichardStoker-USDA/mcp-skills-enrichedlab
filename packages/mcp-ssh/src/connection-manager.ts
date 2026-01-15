import { Client, type ConnectConfig } from 'ssh2';
import { readFileSync } from 'node:fs';
import type { Config, ExecResult } from './types.js';

interface ConnectionEntry {
  client: Client;
  lastUsed: number;
  connecting: boolean;
  ready: boolean;
}

export class ConnectionManager {
  private connections: Map<string, ConnectionEntry> = new Map();
  private config: Config;
  private idleTimeout = 300000; // 5 minutes
  private idleCheckInterval: NodeJS.Timeout | null = null;

  constructor(config: Config) {
    this.config = config;
    this.startIdleCheck();
  }

  private startIdleCheck(): void {
    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [name, entry] of this.connections) {
        if (now - entry.lastUsed > this.idleTimeout) {
          this.close(name);
        }
      }
    }, 60000); // Check every minute
  }

  isConnected(hostName: string): boolean {
    const entry = this.connections.get(hostName);
    return entry?.ready || false;
  }

  async getConnection(hostName: string): Promise<Client> {
    const entry = this.connections.get(hostName);

    if (entry?.ready) {
      entry.lastUsed = Date.now();
      return entry.client;
    }

    // Close stale connection if exists
    if (entry) {
      entry.client.end();
      this.connections.delete(hostName);
    }

    return this.connect(hostName);
  }

  private async connect(hostName: string): Promise<Client> {
    const hostConfig = this.config.hosts[hostName];
    if (!hostConfig) {
      throw new Error(`Unknown host: ${hostName}`);
    }

    const client = new Client();

    const connectConfig: ConnectConfig = {
      host: hostConfig.host,
      port: hostConfig.port || 22,
      username: hostConfig.user,
    };

    // Load private key if specified
    if (hostConfig.keyPath) {
      try {
        connectConfig.privateKey = readFileSync(hostConfig.keyPath);
      } catch (err) {
        throw new Error(`Failed to read SSH key: ${hostConfig.keyPath}`);
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error(`Connection timeout to ${hostName}`));
      }, 30000);

      client.on('ready', () => {
        clearTimeout(timeout);
        this.connections.set(hostName, {
          client,
          lastUsed: Date.now(),
          connecting: false,
          ready: true,
        });
        resolve(client);
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        this.connections.delete(hostName);
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      client.on('close', () => {
        this.connections.delete(hostName);
      });

      client.connect(connectConfig);
    });
  }

  async exec(hostName: string, command: string): Promise<ExecResult> {
    const client = await this.getConnection(hostName);
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      client.exec(command, (err, stream) => {
        if (err) {
          reject(new Error(`Exec failed: ${err.message}`));
          return;
        }

        stream.on('close', (code: number) => {
          resolve({
            stdout,
            stderr,
            exitCode: code,
            duration: Date.now() - startTime,
          });
        });

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('error', (err: Error) => {
          reject(new Error(`Stream error: ${err.message}`));
        });
      });
    });
  }

  // Execute with streaming callback
  async execStreaming(
    hostName: string,
    command: string,
    onData: (chunk: string, isStderr: boolean) => void
  ): Promise<ExecResult> {
    const client = await this.getConnection(hostName);
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      client.exec(command, (err, stream) => {
        if (err) {
          reject(new Error(`Exec failed: ${err.message}`));
          return;
        }

        stream.on('close', (code: number) => {
          resolve({
            stdout,
            stderr,
            exitCode: code,
            duration: Date.now() - startTime,
          });
        });

        stream.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          onData(chunk, false);
        });

        stream.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
          onData(chunk, true);
        });

        stream.on('error', (err: Error) => {
          reject(new Error(`Stream error: ${err.message}`));
        });
      });
    });
  }

  async close(hostName: string): Promise<void> {
    const entry = this.connections.get(hostName);
    if (entry) {
      entry.client.end();
      this.connections.delete(hostName);
    }
  }

  async closeAll(): Promise<void> {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }

    for (const [name] of this.connections) {
      await this.close(name);
    }
  }
}
