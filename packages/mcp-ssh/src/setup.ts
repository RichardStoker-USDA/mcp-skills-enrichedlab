import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import * as readline from 'node:readline';

const CONFIG_DIR = join(homedir(), '.enrichedlab');
const CONFIG_FILE = join(CONFIG_DIR, 'ssh-config.json');
const SSH_DIR = join(homedir(), '.ssh');
const KEY_NAME = 'enrichedlab_key';
const KEY_PATH = join(SSH_DIR, KEY_NAME);

interface HostInput {
  name: string;
  host: string;
  user: string;
  port: number;
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function printStep(step: number, total: number, message: string): void {
  console.log(`\n[${step}/${total}] ${message}`);
}

function printSuccess(message: string): void {
  console.log(`  ✓ ${message}`);
}

function printInfo(message: string): void {
  console.log(`  → ${message}`);
}

function printError(message: string): void {
  console.log(`  ✗ ${message}`);
}

async function createConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    printSuccess(`Created ${CONFIG_DIR}`);
  } else {
    printInfo(`${CONFIG_DIR} already exists`);
  }
}

async function generateSSHKey(): Promise<boolean> {
  if (existsSync(KEY_PATH)) {
    printInfo(`SSH key already exists: ${KEY_PATH}`);
    return true;
  }

  // Ensure .ssh directory exists
  if (!existsSync(SSH_DIR)) {
    mkdirSync(SSH_DIR, { mode: 0o700, recursive: true });
  }

  try {
    execSync(`ssh-keygen -t ed25519 -f "${KEY_PATH}" -N "" -C "enrichedlab-mcp"`, {
      stdio: 'pipe',
    });
    printSuccess(`Generated SSH key: ${KEY_PATH}`);
    return true;
  } catch (err) {
    printError(`Failed to generate SSH key: ${err}`);
    return false;
  }
}

async function copyKeyToHost(host: HostInput): Promise<boolean> {
  const target = `${host.user}@${host.host}`;
  const portArg = host.port !== 22 ? `-p ${host.port}` : '';

  console.log(`\n  Copying key to ${target}...`);
  console.log(`  You may be prompted for the password.`);

  return new Promise((resolve) => {
    const proc = spawn('ssh-copy-id', ['-i', KEY_PATH, portArg, target].filter(Boolean), {
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        printSuccess(`Key copied to ${target}`);
        resolve(true);
      } else {
        printError(`Failed to copy key to ${target}`);
        resolve(false);
      }
    });

    proc.on('error', () => {
      printError(`ssh-copy-id not available`);
      resolve(false);
    });
  });
}

async function testConnection(host: HostInput): Promise<boolean> {
  const target = `${host.user}@${host.host}`;
  const portArg = host.port !== 22 ? `-p ${host.port}` : '';

  try {
    execSync(
      `ssh -i "${KEY_PATH}" ${portArg} -o BatchMode=yes -o ConnectTimeout=5 ${target} "echo ok"`,
      { stdio: 'pipe' }
    );
    return true;
  } catch {
    return false;
  }
}

function createConfig(hosts: HostInput[]): void {
  const hostsConfig: Record<string, object> = {};

  for (const h of hosts) {
    hostsConfig[h.name] = {
      host: h.host,
      port: h.port,
      user: h.user,
      keyPath: `~/.ssh/${KEY_NAME}`,
    };
  }

  const config = {
    hosts: hostsConfig,
    defaultHost: hosts[0]?.name || 'default',
    streaming: {
      enabled: true,
      hangTimeoutMs: 30000,
      progressPatterns: true,
    },
    logging: {
      localPath: '~/.enrichedlab/logs',
      remotePath: '~/.enrichedlab',
    },
    snapshots: {
      enabled: true,
      trackedPaths: [],
      autoSnapshotOnUpload: true,
      autoSnapshotOnExec: false,
      retention: {
        maxAgeDays: 14,
        maxSizeMB: 500,
        keepMinCount: 10,
      },
    },
  };

  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  printSuccess(`Created config: ${CONFIG_FILE}`);
}

function updateConfig(hosts: HostInput[]): void {
  const existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));

  for (const h of hosts) {
    existing.hosts[h.name] = {
      host: h.host,
      port: h.port,
      user: h.user,
      keyPath: `~/.ssh/${KEY_NAME}`,
    };
  }

  writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2));
  printSuccess(`Updated config: ${CONFIG_FILE}`);
}

export async function runSetup(): Promise<void> {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   @enrichedlab/mcp-ssh Setup Wizard    ║');
  console.log('╚════════════════════════════════════════╝');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const totalSteps = 4;
  const hosts: HostInput[] = [];

  try {
    // Step 1: Create config directory
    printStep(1, totalSteps, 'Creating config directory');
    await createConfigDir();

    // Step 2: Generate SSH key
    printStep(2, totalSteps, 'Setting up SSH key');
    const keyGenerated = await generateSSHKey();

    if (!keyGenerated) {
      console.log('\nSetup cannot continue without SSH key.');
      rl.close();
      return;
    }

    // Step 3: Add hosts
    printStep(3, totalSteps, 'Adding SSH hosts');
    console.log('  Enter your server details. Press Enter with empty name to finish.\n');

    let hostCount = 0;
    while (true) {
      const name = await prompt(rl, `  Host name (e.g., dev, prod, myserver): `);
      if (!name) break;

      const host = await prompt(rl, `  Host address (IP or hostname): `);
      if (!host) continue;

      const user = await prompt(rl, `  Username [${process.env.USER || 'root'}]: `) || process.env.USER || 'root';
      const portStr = await prompt(rl, `  Port [22]: `) || '22';
      const port = parseInt(portStr, 10) || 22;

      hosts.push({ name, host, user, port });
      hostCount++;
      console.log(`  Added: ${name} (${user}@${host}:${port})\n`);
    }

    if (hosts.length === 0) {
      console.log('\n  No hosts added. You can manually edit ~/.enrichedlab/ssh-config.json later.');

      // Create empty config
      if (!existsSync(CONFIG_FILE)) {
        createConfig([{ name: 'example', host: '10.0.0.1', user: 'llmuser', port: 22 }]);
        console.log('  Created example config - edit it with your actual hosts.');
      }

      rl.close();
      return;
    }

    // Step 4: Copy keys to hosts
    printStep(4, totalSteps, 'Copying SSH key to hosts');

    const copyKeys = await prompt(rl, '  Copy SSH key to hosts now? [Y/n]: ');
    const shouldCopy = !copyKeys || copyKeys.toLowerCase() === 'y';

    if (shouldCopy) {
      for (const host of hosts) {
        // First test if key already works
        const alreadyWorks = await testConnection(host);
        if (alreadyWorks) {
          printInfo(`Key already works for ${host.name}`);
          continue;
        }

        await copyKeyToHost(host);
      }
    } else {
      console.log('\n  To copy keys manually later, run:');
      for (const h of hosts) {
        const portArg = h.port !== 22 ? `-p ${h.port} ` : '';
        console.log(`    ssh-copy-id -i ${KEY_PATH} ${portArg}${h.user}@${h.host}`);
      }
    }

    // Create or update config
    if (existsSync(CONFIG_FILE)) {
      updateConfig(hosts);
    } else {
      createConfig(hosts);
    }

    // Final summary
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║            Setup Complete!             ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`
  Config: ${CONFIG_FILE}
  SSH Key: ${KEY_PATH}

  Add to Claude Code (available in all projects):
    claude mcp add --scope user enrichedlab-ssh -- npx @enrichedlab/mcp-ssh

  Or run directly:
    npx @enrichedlab/mcp-ssh
`);

    // Verify connections
    console.log('  Testing connections...');
    for (const h of hosts) {
      const works = await testConnection(h);
      if (works) {
        printSuccess(`${h.name}: connected`);
      } else {
        printError(`${h.name}: failed (check key or run ssh-copy-id)`);
      }
    }

  } finally {
    rl.close();
  }
}

// Quick add host without full wizard
export async function addHost(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\nAdd new SSH host\n');

  try {
    const name = await prompt(rl, 'Host name: ');
    if (!name) {
      console.log('Cancelled');
      return;
    }

    const host = await prompt(rl, 'Host address: ');
    const user = await prompt(rl, `Username [${process.env.USER}]: `) || process.env.USER || 'root';
    const port = parseInt(await prompt(rl, 'Port [22]: ') || '22', 10);

    if (!existsSync(CONFIG_FILE)) {
      console.log('Config not found. Run setup first: npx @enrichedlab/mcp-ssh --setup');
      return;
    }

    updateConfig([{ name, host, user, port }]);

    const copyKey = await prompt(rl, 'Copy SSH key to host? [Y/n]: ');
    if (!copyKey || copyKey.toLowerCase() === 'y') {
      await copyKeyToHost({ name, host, user, port });
    }

    console.log(`\nAdded ${name}. Test with: exec host="${name}" command="echo hello"`);

  } finally {
    rl.close();
  }
}
