import envPaths from 'env-paths';
import yaml from 'yaml';
import fs from 'fs';
import path from 'path';
import type { GlobalConfig, ProjectConfig } from '../types.js';

const paths = envPaths('multitable', { suffix: '' });

export function getConfigDir(): string {
  return paths.config;
}

export function getDataDir(): string {
  return paths.data;
}

const DEFAULT_CONFIG: GlobalConfig = {
  theme: 'system',
  defaultEditor: 'code',
  defaultShell: '',
  terminalFontSize: 13,
  terminalScrollback: 10000,
  notifications: true,
  // 3117, not 3000: 3000 is the default for Next.js/CRA/etc., so a co-running
  // dev server steals it and the daemon can't bind. Keep in sync with the vite
  // proxy target and the CLI default.
  port: 3117,
  host: '127.0.0.1',
  projects: [],
  integrations: {},
  lastThinkingEffort: 'medium',
};

// Trailing-debounce wrapper around saveGlobalConfig. Rapid toggles of the
// per-session effort badge would otherwise rewrite the YAML on every click;
// 250ms is well below human "is this saved?" perception and small enough that
// a daemon shutdown won't lose meaningful state.
let pendingConfig: GlobalConfig | null = null;
let saveTimer: NodeJS.Timeout | null = null;
export function saveGlobalConfigDebounced(config: GlobalConfig): void {
  pendingConfig = config;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    const next = pendingConfig;
    saveTimer = null;
    pendingConfig = null;
    if (next) saveGlobalConfig(next);
  }, 250);
}

export function loadGlobalConfig(): GlobalConfig {
  const configPath = path.join(getConfigDir(), 'config.yml');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return { ...DEFAULT_CONFIG, ...yaml.parse(content) };
  } catch {
    // Create default config if missing
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(configPath, yaml.stringify(DEFAULT_CONFIG));
    return { ...DEFAULT_CONFIG };
  }
}

export function saveGlobalConfig(config: GlobalConfig): void {
  const configPath = path.join(getConfigDir(), 'config.yml');
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(configPath, yaml.stringify(config));
}

export function loadProjectConfig(projectPath: string): ProjectConfig | null {
  const configPath = path.join(projectPath, 'mt.yml');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return yaml.parse(content) as ProjectConfig;
  } catch {
    return null;
  }
}
