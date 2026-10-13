import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'coverage/unit');
const traces = join(out, 'traces');

const skip = [
  /^\s*$/,
  /^#!/,
  /^\s*(\}|fi|done|esac|;;|else|then|do)\s*$/,
  /^\s*[\w-]+\(\)\s*\{\s*$/,
  /^\s*[^()]+\)\s*(;;)?\s*$/,
  /='$/,
];

function executable(source) {
  const lines = [];
  source.split('\n').forEach((text, index) => {
    if (!skip.some((pattern) => pattern.test(text))) lines.push(index + 1);
  });
  return lines;
}

function hits(trace) {
  const counts = new Map();
  for (const line of trace.split('\n')) {
    const match = /^\++(\d+):/.exec(line);
    if (match) counts.set(Number(match[1]), (counts.get(Number(match[1])) ?? 0) + 1);
  }
  return counts;
}

function lcov(files) {
  let text = '';
  for (const { path, lines, counts } of files) {
    text += `SF:${path}\n`;
    for (const line of lines) text += `DA:${line},${counts.get(line) ?? 0}\n`;
    text += `LF:${lines.length}\nLH:${lines.filter((line) => counts.get(line)).length}\n`;
    text += 'end_of_record\n';
  }
  return text;
}

function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(traces, { recursive: true });
  const tests = join(root, 'test/unit');
  const files = readdirSync(tests)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => join(tests, name));
  const run = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SLICC_CLIPBOARD_TRACE: traces },
  });
  const bin = join(root, 'bin');
  const report = readdirSync(bin).map((name) => {
    const counts = new Map();
    for (const trace of readdirSync(traces).filter((file) => file.startsWith(`${name}.`))) {
      for (const [line, count] of hits(readFileSync(join(traces, trace), 'utf8'))) {
        counts.set(line, (counts.get(line) ?? 0) + count);
      }
    }
    return {
      path: join(bin, name),
      lines: executable(readFileSync(join(bin, name), 'utf8')),
      counts,
    };
  });
  writeFileSync(join(out, 'lcov.info'), lcov(report));
  for (const { path, lines, counts } of report) {
    const missed = lines.filter((line) => !counts.get(line));
    const name = path.slice(bin.length + 1);
    console.log(
      `${name}: ${lines.length - missed.length}/${lines.length}${missed.length ? ` missed ${missed.join(',')}` : ''}`
    );
  }
  process.exit(run.status ?? 1);
}

main();
