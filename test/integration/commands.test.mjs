import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { boot } from './kernel.mjs';

let os;
const dev = '/tmp/clipboard';
const env = { SLICC_CLIPBOARD_TEST_DEVICE: dev };

async function sh(script, clip) {
  await os.kernel.writeFile(dev, clip ?? '');
  const result = await os.sh(script, { env });
  return { ...result, clip: new TextDecoder().decode(await os.kernel.readFile(dev)) };
}

before(async () => {
  os = await boot();
});

after(() => os?.close());

describe('on the kernel', () => {
  it('lists all six commands', async () => {
    const result = await os.sh('command -v pbcopy pbpaste xclip xsel wl-copy wl-paste');
    assert.equal(
      result.stdout,
      ['pbcopy', 'pbpaste', 'xclip', 'xsel', 'wl-copy', 'wl-paste']
        .map((n) => `/usr/bin/${n}\n`)
        .join('')
    );
  });

  it('copies with the command lines gh uses', async () => {
    for (const command of [
      'pbcopy',
      'xclip -in -selection clipboard',
      'xsel --input --clipboard',
      'wl-copy',
    ]) {
      const result = await sh(`printf 'h\\303\\251 \\342\\230\\203\\n' | ${command}`, 'old');
      assert.deepEqual(result, { status: 0, stdout: '', stderr: '', clip: 'hé ☃\n' }, command);
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

  it('pastes an empty clipboard', async () => {
    for (const command of ['pbpaste', 'xclip -o', 'xsel -o', 'wl-paste -n']) {
      assert.equal((await sh(command, '')).stdout, '', command);
    }
    assert.equal((await sh('wl-paste', '')).stdout, '\n');
  });

  it('parses the options of all six', async () => {
    const cases = [
      ['echo a | xclip -sel c -rmlastnl', 'a'],
      ['printf "x\\n" > /tmp/f && xclip -i /tmp/f', 'x\n'],
      ['echo a | xclip -selection primary', 'a\n'],
      ['echo a | xsel -b -i -n', 'a\n'],
      ['echo a | xsel -p --input', 'a\n'],
      ['xsel --clear', ''],
      ['wl-copy -n "one two\n"', 'one two'],
      ['echo a | wl-copy --trim-newline', 'a'],
      ['wl-copy --clear', ''],
      ['wl-copy -- -n', '-n'],
    ];
    for (const [script, clip] of cases) {
      const result = await sh(script, 'old');
      assert.deepEqual(result, { status: 0, stdout: '', stderr: '', clip }, script);
    }
    assert.equal((await sh('xclip -o -rmlastnl', 'a\n')).stdout, 'a');
    assert.equal((await sh('wl-paste', 'a')).stdout, 'a\n');
  });

  it('refuses unknown options with status 2 and a usage line', async () => {
    for (const name of ['pbcopy', 'pbpaste', 'xclip', 'xsel', 'wl-copy', 'wl-paste']) {
      const result = await sh(`${name} -Z </dev/null`, 'old');
      assert.equal(result.status, 2, name);
      assert.match(result.stderr, new RegExp(`^${name}: unknown option: -Z\nusage: ${name}`), name);
      assert.equal(result.clip, 'old', name);
    }
    const sel = await sh('xclip -selection nope </dev/null', 'old');
    assert.equal(sel.status, 2);
  });

  it("prints coreutils' write error and exits 1", async () => {
    const result = await os.sh('echo x | pbcopy', {
      env: { SLICC_CLIPBOARD_TEST_DEVICE: '/dev/full' },
    });
    assert.deepEqual(result, {
      status: 1,
      stdout: '',
      stderr: 'pbcopy: No space left on device\n',
    });
  });
});
