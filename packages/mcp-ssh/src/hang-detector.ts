import type { Config } from './types.js';

export type HangCallback = (message: string) => void;

export class HangDetector {
  private timeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastActivity: number = Date.now();
  private callback: HangCallback | null = null;
  private alertSent: boolean = false;

  constructor(config: Config) {
    this.timeoutMs = config.streaming.hangTimeoutMs;
  }

  // Start monitoring with a callback for hang alerts
  start(callback: HangCallback): void {
    this.callback = callback;
    this.lastActivity = Date.now();
    this.alertSent = false;
    this.scheduleCheck();
  }

  // Call this when output is received
  onActivity(): void {
    this.lastActivity = Date.now();
    this.alertSent = false;
  }

  // Stop monitoring
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.callback = null;
  }

  private scheduleCheck(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.checkHang();
    }, this.timeoutMs);
  }

  private checkHang(): void {
    const elapsed = Date.now() - this.lastActivity;

    if (elapsed >= this.timeoutMs && !this.alertSent && this.callback) {
      const seconds = Math.round(elapsed / 1000);
      this.callback(`No output for ${seconds}s - command may be hung or waiting for input`);
      this.alertSent = true;
    }

    // Keep checking
    this.scheduleCheck();
  }
}
