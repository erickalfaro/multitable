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
  port: 3000,
  host: '127.0.0.1',
  projects: [],
  integrations: {},
};

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
