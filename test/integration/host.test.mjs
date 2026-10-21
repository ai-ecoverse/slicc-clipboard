import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const live = process.env.SLICC_CLIPBOARD_HOST_TESTS === '1';
const scratch = mkdtempSync(join(tmpdir(), 'slicc-clipboard-host-'));

after(() => rmSync(scratch, { recursive: true, force: true }));

function base(path) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!['PATH', 'WAYLAND_DISPLAY'].includes(key.toUpperCase())) env[key] = value;
  }
  env.PATH = path;
  return env;
}

function which(name) {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  assert.equal(found.status, 0, `${name} is not installed`);
  return found.stdout.trim();
}

function bin(names) {
  const dir = mkdtempSync(join(scratch, 'bin-'));
  for (const name of names) symlinkSync(which(name), join(dir, name));
  return dir;
}

function legs() {
  if (process.platform === 'win32') {
    return [
      {
        name: 'powershell',
        path: join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0'
        ),
      },
    ];
  }
  if (process.platform === 'darwin') return [{ name: 'pbcopy', path: bin(['pbcopy', 'pbpaste']) }];
  return ['xclip', 'xsel'].map((name) => ({ name, path: bin([name]) }));
}

function tried(command) {
  if (process.platform === 'win32') return 'powershell.exe, pwsh.exe';
  if (process.platform === 'darwin') return command === 'sccopy' ? 'pbcopy' : 'pbpaste';
  return 'xclip, xsel';
}

function run(command, args, { input = '', env }) {
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

describe('on this host', () => {
  for (const leg of live ? legs() : []) {
    const env = base(leg.path);
    const trip = (text) => {
      assert.deepEqual(run('sccopy', [], { input: text, env }), ok, leg.name);
      assert.deepEqual(run('scpaste', [], { env }), { ...ok, stdout: text }, leg.name);
    };

    it(`round-trips UTF-8 through ${leg.name}`, () => {
      trip('h\u00e9 \u2603 \ud83c\udf66\ttab');
    });

    it(`keeps a trailing newline through ${leg.name}`, () => {
      trip('one\ntwo\n');
      trip('\n');
    });

    it(`copies and pastes an empty clipboard through ${leg.name}`, () => {
      trip('x');
      trip('');
    });
  }

  it('passes on the stderr of a tool that fails', {
    skip: !live || process.platform !== 'linux',
  }, () => {
    const env = base(bin(['xclip']));
    delete env.DISPLAY;
    const result = run('sccopy', [], { input: 'x', env });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /display/i);
  });

  it('fails when no tool is on PATH', () => {
    for (const command of ['sccopy', 'scpaste']) {
      assert.deepEqual(run(command, [], { input: 'x', env: base('') }), {
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
        assert.deepEqual(run(command, [flag], { env }), {
          ...ok,
          stdout: `usage: ${command}\n`,
        });
      }
      for (const args of [['-Z'], ['word'], ['--', '-h']]) {
        assert.deepEqual(run(command, args, { env }), {
          status: 2,
          stdout: '',
          stderr: `${command}: unknown option: ${args[0]}\nusage: ${command}\n`,
        });
      }
    }
  });
});
