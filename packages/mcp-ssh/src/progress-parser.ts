import type { ProgressInfo } from './types.js';

// Patterns for recognizing progress in output
const DOCKER_STEP_PATTERN = /^Step (\d+)\/(\d+)\s*:/i;
const DOCKER_LAYER_PATTERN = /^[a-f0-9]{12}:\s*(Pulling|Extracting|Download|Pull complete)/i;
const APT_PROGRESS_PATTERN = /^(?:Get|Hit|Ign):\d+\s/;
const NPM_PROGRESS_PATTERN = /^(?:added|removed|changed)\s+\d+\s+packages?/i;
const PERCENTAGE_PATTERN = /(\d{1,3})%/;
const DOWNLOAD_PATTERN = /(\d+(?:\.\d+)?)\s*(?:MB|KB|GB|B)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:MB|KB|GB|B)/i;
const PROMPT_PATTERNS = [
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /\(yes\/no\)/i,
  /password:/i,
  /passphrase:/i,
  /\[sudo\]/i,
  /Press (?:Enter|RETURN)/i,
  /Continue\?/i,
];

export class ProgressParser {
  private enabled: boolean;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  // Parse a line of output for progress info
  parse(line: string): ProgressInfo | null {
    if (!this.enabled) {
      return null;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    // Docker build steps
    const dockerMatch = trimmed.match(DOCKER_STEP_PATTERN);
    if (dockerMatch) {
      return {
        type: 'docker',
        current: parseInt(dockerMatch[1], 10),
        total: parseInt(dockerMatch[2], 10),
        message: trimmed,
      };
    }

    // Docker layer progress
    if (DOCKER_LAYER_PATTERN.test(trimmed)) {
      return {
        type: 'docker',
        message: trimmed,
      };
    }

    // APT progress
    if (APT_PROGRESS_PATTERN.test(trimmed)) {
      return {
        type: 'package',
        message: trimmed,
      };
    }

    // NPM progress
    if (NPM_PROGRESS_PATTERN.test(trimmed)) {
      return {
        type: 'package',
        message: trimmed,
      };
    }

    // Percentage in output
    const pctMatch = trimmed.match(PERCENTAGE_PATTERN);
    if (pctMatch) {
      return {
        type: 'percentage',
        current: parseInt(pctMatch[1], 10),
        total: 100,
        message: trimmed,
      };
    }

    // Download progress (e.g., "5.2 MB / 10.5 MB")
    const dlMatch = trimmed.match(DOWNLOAD_PATTERN);
    if (dlMatch) {
      return {
        type: 'percentage',
        message: trimmed,
      };
    }

    return null;
  }

  // Check if line looks like a prompt waiting for input
  isPrompt(line: string): boolean {
    const trimmed = line.trim();
    return PROMPT_PATTERNS.some(pattern => pattern.test(trimmed));
  }

  // Extract meaningful progress message from raw output
  summarize(output: string): string {
    const lines = output.split('\n');
    const lastMeaningfulLines: string[] = [];

    for (let i = lines.length - 1; i >= 0 && lastMeaningfulLines.length < 3; i--) {
      const line = lines[i].trim();
      if (line && line.length > 0 && line.length < 200) {
        lastMeaningfulLines.unshift(line);
      }
    }

    return lastMeaningfulLines.join('\n');
  }
}
