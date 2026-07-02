#!/usr/bin/env node
import { Command } from 'commander';
import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';

const program = new Command();

function getDaemonConfig(): { port: number; host: string } {
  const configPath = join(os.homedir(), '.config', 'multitable', 'config.yml');
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf8');
    const portMatch = content.match(/port:\s*(\d+)/);
    const hostMatch = content.match(/host:\s*(.+)/);
    return {
      port: portMatch ? parseInt(portMatch[1]) : 3117,
      host: hostMatch ? hostMatch[1].trim() : 'localhost',
    };
  }
  return { port: 3117, host: 'localhost' };
}

program
  .name('mt')
  .description(
    'MultiTable — the local-first AI agent framework and meta-harness for all your coding agents.',
  )
  .version('0.1.0');

program
  .command('start')
  .description('Start the MultiTable daemon')
  .option('--port <port>', 'Port to listen on', '3117')
  .option('--host <host>', 'Host to bind to', '127.0.0.1')
  .action((options) => {
    console.log(`Starting MultiTable daemon on ${options.host}:${options.port}...`);
    execFileSync('node', [join(__dirname, '../../daemon/dist/index.js')], { stdio: 'inherit' });
  });

program
  .command('open')
  .description('Open the MultiTable UI in browser')
  .action(() => {
    const { port, host } = getDaemonConfig();
    const url = `http://${host}:${port}`;
    console.log(`Opening ${url}...`);
    const platform = process.platform;
    if (platform === 'darwin') execSync(`open ${url}`);
    else if (platform === 'win32') execSync(`start ${url}`);
    else execSync(`xdg-open ${url}`);
  });

program.parse();
