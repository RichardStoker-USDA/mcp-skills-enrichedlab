import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './types.js';

// Zod schemas
const hostConfigSchema = z.object({
  host: z.string(),
  port: z.number().optional().default(22),
  user: z.string(),
  keyPath: z.string().optional(),
  allowPasswordAuth: z.boolean().optional().default(false),
});

const streamingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  hangTimeoutMs: z.number().default(30000),
  progressPatterns: z.boolean().default(true),
});

const loggingConfigSchema = z.object({
  localPath: z.string().default('~/.enrichedlab/logs'),
  remotePath: z.string().default('~/.enrichedlab'),
});

const snapshotRetentionSchema = z.object({
  maxAgeDays: z.number().default(14),
  maxSizeMB: z.number().default(500),
  keepMinCount: z.number().default(10),
});

const snapshotConfigSchema = z.object({
  enabled: z.boolean().default(true),
  trackedPaths: z.array(z.string()).default([]),
  autoSnapshotOnUpload: z.boolean().default(true),
  autoSnapshotOnExec: z.boolean().default(false),
  retention: snapshotRetentionSchema.default({}),
});

const sudoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  blockedPatterns: z.array(z.string()).default([
    'rm -rf /',
    'dd if=',
    ':(){ :|:& };:',
    'chmod -R 777 /',
    'mkfs.',
  ]),
});

const configSchema = z.object({
  hosts: z.record(hostConfigSchema),
  defaultHost: z.string(),
  streaming: streamingConfigSchema.default({}),
  logging: loggingConfigSchema.default({}),
  snapshots: snapshotConfigSchema.default({}),
  sudo: sudoConfigSchema.optional(),
});

// Expand ~ in paths
function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// Default config path
const DEFAULT_CONFIG_PATH = '~/.enrichedlab/ssh-config.json';

// Load config from file or env
export function loadConfig(configPath?: string): Config {
  const path = expandPath(configPath || process.env.ENRICHEDLAB_SSH_CONFIG || DEFAULT_CONFIG_PATH);

  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}\nCreate it at ~/.enrichedlab/ssh-config.json`);
  }

  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${path}`);
  }

  const result = configSchema.safeParse(parsed);

  if (!result.success) {
    const errors = result.error.errors.map(e => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Config validation failed:\n${errors}`);
  }

  const config = result.data;

  // Validate defaultHost exists
  if (!config.hosts[config.defaultHost]) {
    throw new Error(`Default host "${config.defaultHost}" not found in hosts`);
  }

  // Expand paths in config
  config.logging.localPath = expandPath(config.logging.localPath);
  config.logging.remotePath = expandPath(config.logging.remotePath);

  for (const hostConfig of Object.values(config.hosts)) {
    if (hostConfig.keyPath) {
      hostConfig.keyPath = expandPath(hostConfig.keyPath);
    }
  }

  return config as Config;
}

// Get host config by name
export function getHostConfig(config: Config, hostName?: string): { name: string; config: typeof config.hosts[string] } {
  const name = hostName || config.defaultHost;
  const hostConfig = config.hosts[name];

  if (!hostConfig) {
    const available = Object.keys(config.hosts).join(', ');
    throw new Error(`Unknown host: ${name}. Available: ${available}`);
  }

  return { name, config: hostConfig };
}
