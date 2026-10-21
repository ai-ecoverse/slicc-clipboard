import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { boot, bootWithoutClipboard } from './kernel.mjs';

const names = ['pbcopy', 'pbpaste', 'xclip', 'xsel', 'wl-copy', 'wl-paste', 'sccopy', 'scpaste'];
const board = { text: '', fail: undefined, calls: [] };

function refusal(name, message) {
  return Object.assign(new Error(message), { name });
}

const clipboard = {
  async read(stamp) {
    board.calls.push(['read', stamp]);
    if (board.fail) throw board.fail;
    return board.text;
  },
  async write(text, stamp) {
    board.calls.push(['write', text, stamp]);
    if (board.fail) throw board.fail;
    board.text = text;
  },
};

let os;
let bare;

async function sh(script, text = 'old') {
  board.text = text;
  const result = await os.sh(script);
  return { ...result, clip: board.text };
}

before(async () => {
  os = await boot({ clipboard });
  bare = await boot();
});

after(() => {
  os?.close();
  bare?.close();
});

beforeEach(() => {
  board.fail = undefined;
  board.calls = [];
});

describe('on the kernel', () => {
  it('lists all eight commands, and /dev/clipboard', async () => {
    const result = await os.sh(`command -v ${names.join(' ')} && test -c /dev/clipboard`);
    assert.equal(result.stdout, names.map((n) => `/usr/bin/${n}\n`).join(''));
    assert.equal(result.status, 0);
  });

  it('copies with the command lines gh uses, as one write per copy', async () => {
    for (const command of [
      'pbcopy',
      'xclip -in -selection clipboard',
      'xsel --input --clipboard',
      'wl-copy',
    ]) {
      board.calls = [];
      const result = await sh(`printf 'h\\303\\251 \\342\\230\\203\\n' | ${command}`);
      assert.deepEqual(result, { status: 0, stdout: '', stderr: '', clip: 'hé ☃\n' }, command);
      assert.deepEqual(
        board.calls.map(([op, text]) => [op, text]),
        [['write', 'hé ☃\n']],
        command
      );
      assert.equal(board.calls[0][2].uid, 0, command);
    }
  });

  it('pastes with the command lines gh uses', async () => {
    for (const command of [
      'pbpaste',
      'xclip -out -selection clipboard',
      'xsel --output --clipboard',
      'wl-paste --no-newline',
    ]) {
      const result = await sh(command, 'hé ☃\n\n');
      assert.deepEqual(
        result,
        { status: 0, stdout: 'hé ☃\n\n', stderr: '', clip: 'hé ☃\n\n' },
        command
      );
    }
  });

  it('runs sccopy and scpaste as pbcopy and pbpaste', async () => {
    const result = await sh("printf 'h\\303\\251\\n\\n' | sccopy && scpaste && pbpaste", '');
    assert.deepEqual(result, { status: 0, stdout: 'hé\n\nhé\n\n', stderr: '', clip: 'hé\n\n' });
    assert.deepEqual(await sh('scpaste', ''), { status: 0, stdout: '', stderr: '', clip: '' });
    assert.deepEqual(await sh('sccopy </dev/null'), {
      status: 0,
      stdout: '',
      stderr: '',
      clip: '',
    });
    for (const name of ['sccopy', 'scpaste']) {
      assert.deepEqual(await sh(`${name} --help`), {
        status: 0,
        stdout: `usage: ${name}\n`,
        stderr: '',
        clip: 'old',
      });
      assert.deepEqual(await sh(`${name} word </dev/null`), {
        status: 2,
        stdout: '',
        stderr: `${name}: unknown option: word\nusage: ${name}\n`,
        clip: 'old',
      });
    }
  });

  it('runs the sh sccopy and scpaste where the kernel also takes npm bins', async () => {
    const modules = '/opt/tool/node_modules';
    const tool = await boot({ clipboard, commands: { append: [modules] } }, undefined, modules);
    try {
      const where = await tool.sh('command -v sccopy scpaste xclip');
      assert.equal(where.stdout, '/usr/bin/sccopy\n/usr/bin/scpaste\n/usr/bin/xclip\n');
      board.text = '';
      const result = await tool.sh("printf 'h\\303\\251\\n' | sccopy && scpaste");
      assert.deepEqual(result, { status: 0, stdout: 'hé\n', stderr: '' });
      assert.equal(board.text, 'hé\n');
    } finally {
      tool.close();
    }
  });

  it('round-trips text through the hook', async () => {
    const result = await sh("printf 'a\\tb\\n\\360\\237\\215\\246' | pbcopy && pbpaste", '');
    assert.deepEqual(result, { status: 0, stdout: 'a\tb\n🍦', stderr: '', clip: 'a\tb\n🍦' });
  });

  it('pastes an empty clipboard', async () => {
    for (const command of ['pbpaste', 'xclip -o', 'xsel -o', 'wl-paste -n', 'xclip -o -rmlastnl']) {
      assert.deepEqual(
        await sh(command, ''),
        { status: 0, stdout: '', stderr: '', clip: '' },
        command
      );
    }
    assert.equal((await sh('wl-paste', '')).stdout, '\n');
  });

  it('clears and copies empty input', async () => {
    for (const command of [
      'xsel -c',
      'xsel --clear',
      'wl-copy -c',
      'wl-copy --clear',
      'pbcopy </dev/null',
    ]) {
      assert.deepEqual(await sh(command), { status: 0, stdout: '', stderr: '', clip: '' }, command);
    }
  });

  it('parses the options of all eight', async () => {
    const cases = [
      ['echo a | xclip -sel c -rmlastnl', 'a'],
      ['printf "x\\n" > /tmp/f && printf "y" > /tmp/g && xclip -i /tmp/f /tmp/g', 'x\ny'],
      ['echo a | xclip -selection primary', 'a\n'],
      ['echo a | xclip -selection secondary -i -', 'a\n'],
      ['echo a | xsel -b -i -n', 'a\n'],
      ['echo a | xsel -p --input --nodetach', 'a\n'],
      ['echo a | xsel -s', 'a\n'],
      ['wl-copy -n "one two\n"', 'one two'],
      ['wl-copy one two', 'one two'],
      ['echo a | wl-copy --trim-newline', 'a'],
      ['wl-copy -- -n', '-n'],
    ];
    for (const [script, clip] of cases) {
      assert.deepEqual(await sh(script), { status: 0, stdout: '', stderr: '', clip }, script);
    }
    assert.equal((await sh('xclip -o -rmlastnl', 'a\n')).stdout, 'a');
    assert.equal((await sh('wl-paste', 'a')).stdout, 'a\n');
    for (const name of names) {
      const result = await sh(`${name} -h`);
      assert.match(result.stdout, new RegExp(`^usage: ${name}`), name);
      assert.equal(result.status, 0, name);
    }
  });

  it('refuses unknown options with status 2 and a usage line', async () => {
    for (const name of names) {
      const result = await sh(`${name} -Z </dev/null`);
      assert.equal(result.status, 2, name);
      assert.match(result.stderr, new RegExp(`^${name}: unknown option: -Z\nusage: ${name}`), name);
      assert.equal(result.clip, 'old', name);
    }
    for (const script of [
      'xclip -selection nope',
      'xclip -sel',
      'xsel word',
      'wl-paste word',
      'pbpaste word',
    ]) {
      const result = await sh(`${script} </dev/null`);
      assert.equal(result.status, 2, script);
      assert.equal(result.clip, 'old', script);
    }
    assert.deepEqual(board.calls, []);
  });

  it('reports a refusal as EACCES, on copy and paste', async () => {
    board.fail = refusal('NotAllowedError', "The clipboard needs seven's tab to be in front");
    for (const name of names) {
      const script =
        name.endsWith('copy') || name === 'xsel' || name === 'xclip' ? `echo x | ${name}` : name;
      const result = await sh(script);
      assert.deepEqual(
        result,
        {
          status: 1,
          stdout: '',
          stderr: `${name}: Permission denied\n${name}: the clipboard needs seven's tab in front, with clipboard access allowed\n`,
          clip: 'old',
        },
        name
      );
    }
    for (const script of ['pbpaste', 'xclip -o', 'xclip -o -rmlastnl', 'xsel -o', 'wl-paste']) {
      const result = await sh(script);
      assert.equal(result.status, 1, script);
      assert.equal(result.stdout, '', script);
      assert.match(
        result.stderr,
        /: Permission denied\n\S+: the clipboard needs seven's tab in front, with clipboard access allowed\n$/,
        script
      );
    }
  });

  it('reports any other hook failure as EIO', async () => {
    board.fail = new Error('boom');
    assert.deepEqual(await sh('echo x | xclip -i'), {
      status: 1,
      stdout: '',
      stderr: 'xclip: I/O error\n',
      clip: 'old',
    });
    assert.equal((await sh('pbpaste')).stderr, 'pbpaste: I/O error\n');
  });

  it('reports an embedder without a clipboard as ENOTSUP', async () => {
    for (const [script, name] of [
      ['pbpaste', 'pbpaste'],
      ['echo x | pbcopy', 'pbcopy'],
      ['wl-copy x', 'wl-copy'],
      ['xsel -o', 'xsel'],
    ]) {
      assert.deepEqual(
        await bare.sh(script),
        { status: 1, stdout: '', stderr: `${name}: Not supported\n` },
        script
      );
    }
  });

  it('copies 1 MiB, and refuses one byte more with EFBIG', async () => {
    const mib = 1024 * 1024;
    const ok = await sh(`head -c ${mib} /dev/zero | tr '\\0' a | pbcopy`);
    assert.equal(ok.status, 0);
    assert.equal(ok.clip.length, mib);
    const big = await sh(`head -c ${mib + 1} /dev/zero | tr '\\0' a | xclip -i`);
    assert.deepEqual(big, {
      status: 1,
      stdout: '',
      stderr: 'xclip: File too large\n',
      clip: 'old',
    });
  });

  it('refuses invalid UTF-8 with EILSEQ, without calling the hook', async () => {
    const result = await sh("printf 'a\\377' | pbcopy");
    assert.deepEqual(result, {
      status: 1,
      stdout: '',
      stderr: 'pbcopy: Illegal byte sequence\n',
      clip: 'old',
    });
    assert.deepEqual(board.calls, []);
  });

  it('runs under users enforce as an ordinary user', async () => {
    const strict = await boot({ clipboard, users: 'enforce' });
    try {
      const ada = await strict.kernel.users.add({ name: 'ada' });
      board.text = 'shared';
      const result = await strict.kernel.run(['sh', '-c', 'pbpaste && echo new | wl-copy -n'], {
        user: 'ada',
        cwd: ada.home,
      });
      assert.deepEqual(
        { ...result, clip: board.text },
        { status: 0, stdout: 'shared', stderr: '', clip: 'new' }
      );
      const stamp = board.calls.at(-1)[2];
      assert.deepEqual([stamp.uid, stamp.users], [ada.uid, 'enforce']);
    } finally {
      strict.close();
    }
  });

  it('ignores SLICC_CLIPBOARD_TEST_DEVICE', async () => {
    board.text = 'old';
    const result = await os.kernel.run(['sh', '-c', 'echo new | pbcopy && pbpaste'], {
      cwd: '/tmp',
      env: { SLICC_CLIPBOARD_TEST_DEVICE: '/tmp/elsewhere' },
    });
    assert.deepEqual(result, { status: 0, stdout: 'new\n', stderr: '' });
    assert.equal(board.text, 'new\n');
    assert.equal((await os.sh('test -e /tmp/elsewhere')).status, 1);
  });
});

describe('on a kernel without /dev/clipboard', () => {
  it('fails every command instead of copying nowhere', async () => {
    const old = await bootWithoutClipboard();
    try {
      for (const name of names) {
        const result = await old.sh(`echo x | ${name}`);
        assert.deepEqual(
          result,
          {
            status: 1,
            stdout: '',
            stderr: `${name}: /dev/clipboard not available (needs slicc-kernel >= 1.75.0)\n`,
          },
          name
        );
      }
      for (const script of ['xclip -o', 'xsel -o', 'xsel -c', 'wl-copy -c', 'wl-copy text']) {
        assert.equal((await old.sh(script)).status, 1, script);
      }
      assert.equal((await old.sh('test -e /dev/clipboard')).status, 1);
      assert.equal((await old.sh('pbcopy -h')).status, 0);
    } finally {
      old.close();
    }
  });
});
