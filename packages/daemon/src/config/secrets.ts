import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { getConfigDir } from './loader.js';

export interface SecretsFile {
  telegram?: {
    token?: string;
  };
}

const SECRETS_FILENAME = 'secrets.yml';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function secretsPath(): string {
  return path.join(getConfigDir(), SECRETS_FILENAME);
}

export function loadSecrets(): SecretsFile {
  const p = secretsPath();
  try {
    const content = fs.readFileSync(p, 'utf8');
    const parsed = yaml.parse(content);
    if (parsed && typeof parsed === 'object') return parsed as SecretsFile;
    return {};
  } catch {
    return {};
  }
}

export function saveSecrets(secrets: SecretsFile): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // Best-effort: tighten dir perms even if it pre-existed with looser bits.
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {}
  const p = secretsPath();
  // Write to a tmp file then rename — atomic swap so a partial write can't
  // leave a half-blank secrets file. Set mode at write time so the temp
  // file is never world-readable, even briefly.
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, yaml.stringify(secrets), { mode: FILE_MODE });
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, FILE_MODE);
  } catch {}
}

export function getTelegramToken(): string {
  const fromEnv = process.env.MULTITABLE_TELEGRAM_BOT_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const fromFile = loadSecrets().telegram?.token;
  return typeof fromFile === 'string' ? fromFile : '';
}

export function setTelegramToken(token: string | null): void {
  const current = loadSecrets();
  const next: SecretsFile = { ...current };
  if (token && token.length > 0) {
    next.telegram = { ...(current.telegram ?? {}), token };
  } else {
    if (next.telegram) {
      const rest = { ...next.telegram };
      delete rest.token;
      if (Object.keys(rest).length === 0) delete next.telegram;
      else next.telegram = rest;
    }
  }
  saveSecrets(next);
}

export function hasTelegramToken(): boolean {
  return getTelegramToken().length > 0;
}

export function isTelegramTokenFromEnv(): boolean {
  const env = process.env.MULTITABLE_TELEGRAM_BOT_TOKEN;
  return typeof env === 'string' && env.length > 0;
}
