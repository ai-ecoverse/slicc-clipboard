import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { run as clipboard, lookup } from '../../host/clipboard.mjs';

const root = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'slicc-clipboard-host-'));

after(() => rmSync(scratch, { recursive: true, force: true }));

function fake(name) {
  const reads = /copy|xclip|xsel|\.exe$/.test(name);
  return `#!${process.execPath}
const fs = require('node:fs');
const log = require('node:path').join(process.env.FAKE_LOG, ${JSON.stringify(name)});
fs.writeFileSync(log + '.argv', JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(log + '.locale', (process.env.LANG ?? 'unset') + '|' + (process.env.LC_ALL ?? 'unset'));
if (${reads}) fs.writeFileSync(log + '.stdin', fs.readFileSync(0));
if (process.env.FAKE_FAIL) {
  process.stderr.write(process.env.FAKE_FAIL + '\\n');
  process.exit(3);
}
process.stdout.write('pasted by ${name}');
`;
}

function tools(names) {
  const dir = mkdtempSync(join(scratch, 'bin-'));
  for (const name of names) {
    writeFileSync(join(dir, name), fake(name));
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

function base(path) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!['PATH', 'WAYLAND_DISPLAY', 'LANG', 'LC_ALL'].includes(key.toUpperCase())) {
      env[key] = value;
    }
  }
  env.PATH = path;
  return env;
}

async function select({ platform, names, mode, extra = {} }) {
  const dir = tools(names);
  const log = mkdtempSync(join(scratch, 'log-'));
  const input = join(log, 'in');
  const output = join(log, 'out');
  const error = join(log, 'err');
  writeFileSync(input, 'h\u00e9 \u2603\n');
  const fds = [openSync(input, 'r'), openSync(output, 'w'), openSync(error, 'w')];
  const env = { ...base(dir), FAKE_LOG: log, ...extra };
  if (platform === 'win32') {
    delete env.PATH;
    env.Path = `${join(scratch, 'missing')};${dir}`;
  }
  let code;
  try {
    code = await clipboard({ name: 'sc', mode, argv: [], env, platform, fds });
  } finally {
    for (const fd of fds) closeSync(fd);
  }
  const read = (file) => {
    try {
      return readFileSync(join(log, file), 'utf8');
    } catch {
      return undefined;
    }
  };
  const used = names.find((name) => read(`${name}.argv`) !== undefined);
  const argv = used && JSON.parse(read(`${used}.argv`));
  return {
    code,
    used,
    argv,
    locale: used && read(`${used}.locale`),
    stdin: used && read(`${used}.stdin`),
    stdout: read('out'),
    stderr: read('err'),
  };
}

function decoded(argv) {
  assert.deepEqual(argv.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(argv.length, 4);
  return Buffer.from(argv[3], 'base64').toString('utf16le');
}

const all = ['pbcopy', 'pbpaste', 'wl-copy', 'wl-paste', 'xclip', 'xsel'];

describe('picks the tool for each platform', {
  skip: process.platform === 'win32' && 'Windows does not run a file through its shebang',
}, () => {
  it('uses pbcopy and pbpaste on macOS, in a UTF-8 locale', async () => {
    const copy = await select({ platform: 'darwin', names: all, mode: 'copy' });
    assert.deepEqual(copy, {
      code: 0,
      used: 'pbcopy',
      argv: [],
      locale: 'en_US.UTF-8|en_US.UTF-8',
      stdin: 'h\u00e9 \u2603\n',
      stdout: '',
      stderr: '',
    });
    const paste = await select({ platform: 'darwin', names: all, mode: 'paste' });
    assert.equal(paste.code, 0);
    assert.equal(paste.used, 'pbpaste');
    assert.deepEqual(paste.argv, []);
    assert.equal(paste.locale, 'en_US.UTF-8|en_US.UTF-8');
    assert.equal(paste.stdout, 'pasted by pbpaste');
  });

  it('prefers wl-copy and wl-paste under Wayland', async () => {
    const extra = { WAYLAND_DISPLAY: 'wayland-0' };
    const copy = await select({ platform: 'linux', names: all, mode: 'copy', extra });
    assert.deepEqual([copy.code, copy.used, copy.argv], [0, 'wl-copy', []]);
    assert.equal(copy.stdin, 'h\u00e9 \u2603\n');
    assert.equal(copy.locale, 'unset|unset');
    const paste = await select({ platform: 'linux', names: all, mode: 'paste', extra });
    assert.deepEqual([paste.code, paste.used, paste.argv], [0, 'wl-paste', ['--no-newline']]);
    assert.equal(paste.stdout, 'pasted by wl-paste');
  });

  it('falls back to xclip without Wayland, or when wl-clipboard is missing', async () => {
    for (const [names, extra] of [
      [all, {}],
      [['xclip', 'xsel'], { WAYLAND_DISPLAY: 'wayland-0' }],
    ]) {
      const copy = await select({ platform: 'linux', names, mode: 'copy', extra });
      assert.deepEqual(
        [copy.code, copy.used, copy.argv],
        [0, 'xclip', ['-selection', 'clipboard', '-i']]
      );
      assert.equal(copy.stdin, 'h\u00e9 \u2603\n');
      const paste = await select({ platform: 'linux', names, mode: 'paste', extra });
      assert.deepEqual(
        [paste.code, paste.used, paste.argv],
        [0, 'xclip', ['-selection', 'clipboard', '-o']]
      );
      assert.equal(paste.stdout, 'pasted by xclip');
    }
  });

  it('falls back to xsel when xclip is missing, on Linux and other Unix systems', async () => {
    for (const platform of ['linux', 'freebsd']) {
      const copy = await select({ platform, names: ['xsel'], mode: 'copy' });
      assert.deepEqual([copy.code, copy.used, copy.argv], [0, 'xsel', ['--clipboard', '--input']]);
      assert.equal(copy.stdin, 'h\u00e9 \u2603\n');
      const paste = await select({ platform, names: ['xsel'], mode: 'paste' });
      assert.deepEqual(
        [paste.code, paste.used, paste.argv],
        [0, 'xsel', ['--clipboard', '--output']]
      );
      assert.equal(paste.stdout, 'pasted by xsel');
    }
  });

  it('runs powershell.exe on Windows, else pwsh.exe, with a raw UTF-8 script', async () => {
    for (const names of [['powershell.exe', 'pwsh.exe', ...all], ['pwsh.exe']]) {
      const copy = await select({ platform: 'win32', names, mode: 'copy' });
      assert.deepEqual([copy.code, copy.used], [0, names[0]]);
      assert.equal(copy.stdin, 'h\u00e9 \u2603\n');
      const set = decoded(copy.argv);
      assert.match(set, /^\$ErrorActionPreference = 'Stop'\n/);
      assert.match(set, /\[Console\]::OpenStandardInput\(\)/);
      assert.match(set, /UTF8Encoding \$false, \$true/);
      assert.match(set, /Set-Clipboard -Value \$text/);
      assert.match(set, /\[System\.Windows\.Forms\.Clipboard\]::Clear\(\)/);
      assert.doesNotMatch(set, /clip\.exe/);
      const paste = await select({ platform: 'win32', names, mode: 'paste' });
      assert.deepEqual([paste.code, paste.used], [0, names[0]]);
      const get = decoded(paste.argv);
      assert.match(get, /Get-Clipboard -Raw/);
      assert.match(get, /\[Console\]::OpenStandardOutput\(\)/);
      assert.equal(paste.stdout, `pasted by ${names[0]}`);
    }
  });

  it('passes on the stderr and fails when the tool fails', async () => {
    const result = await select({
      platform: 'linux',
      names: ['xclip', 'xsel'],
      mode: 'copy',
      extra: { FAKE_FAIL: 'Error: Can\u2019t open display' },
    });
    assert.deepEqual(
      [result.code, result.used, result.stderr],
      [1, 'xclip', 'Error: Can\u2019t open display\n']
    );
  });
});

function host(command, args, { input = '', env }) {
  const result = spawnSync(process.execPath, [join(root, 'host', `${command}.mjs`), ...args], {
    input: Buffer.from(input),
    env,
    timeout: 30000,
  });
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
}

const ok = { status: 0, stdout: '', stderr: '' };

function tried(command) {
  if (process.platform === 'win32') return 'powershell.exe, pwsh.exe';
  if (process.platform === 'darwin') return command === 'sccopy' ? 'pbcopy' : 'pbpaste';
  return 'xclip, xsel';
}

describe('sccopy and scpaste', () => {
  it('copy and paste through the tool on PATH', {
    skip: process.platform === 'win32' && 'Windows does not run a file through its shebang',
  }, () => {
    const names = ['pbcopy', 'pbpaste', 'xclip', 'xsel'];
    const log = mkdtempSync(join(scratch, 'log-'));
    const env = { ...base(tools(names)), FAKE_LOG: log };
    const tool = process.platform === 'darwin' ? ['pbcopy', 'pbpaste'] : ['xclip', 'xclip'];
    assert.deepEqual(host('sccopy', [], { input: 'one\ntwo\n', env }), ok);
    assert.equal(readFileSync(join(log, `${tool[0]}.stdin`), 'utf8'), 'one\ntwo\n');
    assert.deepEqual(host('scpaste', [], { env }), { ...ok, stdout: `pasted by ${tool[1]}` });
  });

  it('fails when no tool is on PATH', () => {
    for (const command of ['sccopy', 'scpaste']) {
      assert.deepEqual(host(command, [], { input: 'x', env: base('') }), {
        status: 1,
        stdout: '',
        stderr: `${command}: no clipboard tool found (tried ${tried(command)})\n`,
      });
    }
  });

  it('prints the usage line for -h and --help, and refuses anything else', () => {
    for (const command of ['sccopy', 'scpaste']) {
      const env = base('');
      for (const flag of ['-h', '--help']) {
        assert.deepEqual(host(command, [flag], { env }), { ...ok, stdout: `usage: ${command}\n` });
      }
      for (const args of [['-Z'], ['word'], ['--', '-h']]) {
        assert.deepEqual(host(command, args, { env }), {
          status: 2,
          stdout: '',
          stderr: `${command}: unknown option: ${args[0]}\nusage: ${command}\n`,
        });
      }
    }
  });
});

function installed(name) {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : undefined;
}

function live(name) {
  if (process.env.CI !== 'true') return 'touches the real clipboard, so it runs on CI only';
  if (process.platform !== 'linux') return 'runs on Linux only';
  if (!process.env.DISPLAY) return 'needs an X display';
  if (!installed(name)) return `${name} is not installed`;
  return false;
}

const texts = ['h\u00e9 \u2603 \ud83c\udf66\ttab', 'one\ntwo\n', '\n', 'x', ''];

function trip(name, env) {
  for (const text of texts) {
    assert.deepEqual(host('sccopy', [], { input: text, env }), ok, name);
    assert.deepEqual(host('scpaste', [], { env }), { ...ok, stdout: text }, name);
  }
}

describe('the real clipboard on Linux', () => {
  for (const name of ['xclip', 'xsel']) {
    it(`round-trips UTF-8, a trailing newline and an empty clipboard through ${name}`, {
      skip: live(name),
    }, () => {
      const dir = mkdtempSync(join(scratch, 'bin-'));
      symlinkSync(installed(name), join(dir, name));
      trip(name, base(dir));
    });
  }
});

function windows(name) {
  if (process.env.CI !== 'true') return 'touches the real clipboard, so it runs on CI only';
  if (process.platform !== 'win32') return 'runs on Windows only';
  if (!lookup(name, 'win32', process.env)) return `${name} is not on PATH`;
  return false;
}

describe('the real clipboard on Windows', () => {
  for (const name of ['powershell.exe', 'pwsh.exe']) {
    it(`round-trips UTF-8, a trailing newline and an empty clipboard through ${name}`, {
      skip: windows(name),
    }, () => {
      trip(name, base(dirname(lookup(name, 'win32', process.env))));
    });
  }
});
