export type Channel = 'stable' | 'pre-release';
export const channels: Channel[] = ['stable', 'pre-release'];

export interface Config {
  days: number;
  jobs: number;
  timeout: number;
  workDir: string;
  outputDir: string;
  packages: string[];
  limit?: number;
}

export interface Release {
  name: string;
  version: string;
  checksum: string;
  createdAt: string;
  recentReleaseAt: string;
}

export interface RunError { stage: string; message: string }
export interface Archive {
  url: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface ProcessResult {
  command: string[];
  cwd: string;
  kind: 'exited' | 'spawn-error' | 'timeout' | 'cancelled' | 'io-error';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  durationMs: number;
  stdoutLog: string;
  stderrLog: string;
  error?: string;
}

export interface Toolchain {
  channel: Channel;
  distribution: 'latest' | 'pre-release';
  root: string;
  architecture: string;
  version: string;
  archives: Archive[];
  setup: ProcessResult[];
}

export interface IndexSnapshot { url: string; path: string; commit: string }
export interface PackageResult {
  package: Release;
  status: 'pending' | 'checking' | 'ok' | 'regression' | 'runtime-error' | 'interrupted';
  checks: Partial<Record<Channel, ProcessResult>>;
  errors: RunError[];
  source?: Archive;
  workDirs: Partial<Record<Channel, string>>;
  retained: boolean;
}

export interface Report {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  complete: boolean;
  config: Config;
  workDir: string;
  outputDir: string;
  index?: IndexSnapshot;
  toolchains: Partial<Record<Channel, Toolchain>>;
  selection: { cutoff: string; eligible: number; selected: number };
  results: PackageResult[];
  errors: RunError[];
  exitCode: 0 | 1 | 2;
}
