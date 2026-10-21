import { spawn } from 'node:child_process';
import { accessSync, constants, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const utf8 = { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };

const powershell = {
  copy: [
    "$ErrorActionPreference = 'Stop'",
    '$in = [Console]::OpenStandardInput()',
    '$buffer = New-Object System.IO.MemoryStream',
    '$in.CopyTo($buffer)',
    '$text = (New-Object System.Text.UTF8Encoding $false, $true).GetString($buffer.ToArray())',
    'Set-Clipboard -Value $text',
  ],
  paste: [
    "$ErrorActionPreference = 'Stop'",
    '$text = Get-Clipboard -Raw',
    "if ($null -eq $text) { $text = '' }",
    '$bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($text)',
    '$out = [Console]::OpenStandardOutput()',
    '$out.Write($bytes, 0, $bytes.Length)',
    '$out.Flush()',
  ],
};

function encoded(lines) {
  return Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
}

export function candidates(mode, platform, env) {
  const copy = mode === 'copy';
  if (platform === 'darwin') return [{ file: copy ? 'pbcopy' : 'pbpaste', args: [], env: utf8 }];
  if (platform === 'win32') {
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(powershell[mode])];
    return ['powershell.exe', 'pwsh.exe'].map((file) => ({ file, args }));
  }
  const list = [];
  if (env.WAYLAND_DISPLAY) {
    list.push(copy ? { file: 'wl-copy', args: [] } : { file: 'wl-paste', args: ['--no-newline'] });
  }
  list.push({ file: 'xclip', args: ['-selection', 'clipboard', copy ? '-i' : '-o'] });
  list.push({ file: 'xsel', args: ['--clipboard', copy ? '--input' : '--output'] });
  return list;
}

function runnable(path, platform) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function lookup(file, platform, env) {
  const path = (platform === 'win32' ? (env.PATH ?? env.Path) : env.PATH) ?? '';
  for (const dir of path.split(platform === 'win32' ? ';' : ':')) {
    if (dir && runnable(join(dir, file), platform)) return join(dir, file);
  }
  return undefined;
}

function say(fd, text) {
  writeSync(fd, text);
}

function spawned(tool, path, mode, env, fds) {
  return new Promise((resolve) => {
    const copy = mode === 'copy';
    let child;
    try {
      child = spawn(path, tool.args, {
        env: tool.env ? { ...env, ...tool.env } : env,
        stdio: copy ? [fds[0], 'ignore', 'pipe'] : ['ignore', fds[1], 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ error });
      return;
    }
    const errors = [];
    let code;
    let closed = false;
    const settle = () => {
      if (code === 0) {
        child.stderr.destroy();
        resolve({ code });
      } else if (code !== undefined && closed) {
        resolve({ code, stderr: Buffer.concat(errors) });
      }
    };
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.stderr.on('close', () => {
      closed = true;
      settle();
    });
    child.on('error', (error) => resolve({ error }));
    child.on('exit', (status) => {
      code = status ?? 1;
      settle();
    });
  });
}

export async function run({
  name,
  mode,
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  fds = [0, 1, 2],
}) {
  const usage = `usage: ${name}\n`;
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      say(fds[1], usage);
      return 0;
    }
    say(fds[2], `${name}: unknown option: ${arg}\n${usage}`);
    return 2;
  }
  const tools = candidates(mode, platform, env);
  for (const tool of tools) {
    const path = lookup(tool.file, platform, env);
    if (!path) continue;
    const result = await spawned(tool, path, mode, env, fds);
    if (result.error) {
      say(fds[2], `${name}: ${tool.file}: ${result.error.message}\n`);
      return 1;
    }
    if (result.code === 0) return 0;
    if (result.stderr.length) say(fds[2], result.stderr);
    else say(fds[2], `${name}: ${tool.file} failed\n`);
    return 1;
  }
  say(fds[2], `${name}: no clipboard tool found (tried ${tools.map((t) => t.file).join(', ')})\n`);
  return 1;
}
