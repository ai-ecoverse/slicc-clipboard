# slicc-clipboard

Clipboard commands for SLICC: `pbcopy`, `pbpaste`, `xclip`, `xsel`, `wl-copy` and `wl-paste`, as POSIX `sh` scripts over the kernel's `/dev/clipboard` character device. Programs that shell out to a clipboard tool, such as `gh` through [atotto/clipboard](https://github.com/atotto/clipboard), find one whichever they look for.

`sccopy` (stdin to the clipboard) and `scpaste` (the clipboard to stdout) work the same everywhere: in SLICC they are `pbcopy` and `pbpaste`, and on macOS, Linux and Windows they hand off to the platform's own clipboard tool (see [On a host](#on-a-host)).

The kernel answers the device from its embedder's `clipboard` hook, which in seven is `navigator.clipboard` in seven's own page. It needs seven's tab in front, and Chrome's clipboard permission for reading. Text only.

## Install

In SLICC, the package declares its commands in `slicc.commands`, so installing it puts them in `/usr/bin`:

```sh
pnpm add -g @ai-ecoverse/slicc-clipboard
```

It needs slicc-kernel 1.75.0 or later (`engines.slicc-kernel`). On an older kernel, which has no `/dev/clipboard`, every command except `-h` fails with `<cmd>: /dev/clipboard not available (needs slicc-kernel >= 1.75.0)` and exits 1, before it reads or writes anything.

## Commands

| command | copies | pastes |
| --- | --- | --- |
| `pbcopy` | stdin | |
| `pbpaste` | | to stdout |
| `xclip` | `-i`, `-in`: stdin, or the files named | `-o`, `-out` |
| `xsel` | `-i`, `--input`: stdin | `-o`, `--output` |
| `wl-copy` | stdin, or the arguments joined by spaces | |
| `wl-paste` | | to stdout, then a newline |
| `sccopy` | stdin | |
| `scpaste` | | to stdout |

- **xclip:** `-selection` (or `-se`, `-sel`, …) takes `clipboard`, `primary` or `secondary`, or any prefix of one (`c`, `clip`, `p`); all three are the one clipboard, and `primary` is the default. `-rmlastnl` (or `-r`) drops one newline at the end of what is copied or pasted. A file named `-` is stdin, and xclip has no `--`, so a file whose name starts with `-` needs a path (`./-notes.txt`). Without `-i` or `-o`, xclip copies, unless stdin is a terminal; then it pastes. Of `-i` and `-o`, the last one wins, and files are ignored when pasting.
- **xsel:** `-b`/`--clipboard`, `-p`/`--primary` and `-s`/`--secondary` all mean the one clipboard. `-c`/`--clear` empties it. `-n`/`--nodetach` is accepted and does nothing. Without a mode, xsel copies, unless stdin is a terminal; then it pastes. Of `-i`, `-o` and `-c`, the last one wins. It takes no other arguments.
- **wl-copy:** `-n`/`--trim-newline` drops one newline at the end. `-c`/`--clear` empties the clipboard. Options may come anywhere, until `--`.
- **wl-paste:** `-n`/`--no-newline` leaves out the newline it adds.
- **sccopy, scpaste:** the same as `pbcopy` and `pbpaste`, under their own names.
- **Help:** `-h` and `--help` (`-help` for xclip) print the usage line to stdout and exit 0.

An unknown option (or an argument a command doesn't take) prints the command's error and its usage line to stderr and exits 2. When the device fails, the command prints `name: ` and the error's message to stderr, and exits 1; for example, when the tab isn't in front:

```
pbcopy: Permission denied
pbcopy: the clipboard needs seven's tab in front, with clipboard access allowed
```

## On a host

On a machine with Node 24 or later:

```sh
npm install -g @ai-ecoverse/slicc-clipboard
printf 'hello\n' | sccopy
scpaste
```

or without installing, `npx -p @ai-ecoverse/slicc-clipboard sccopy`. Only `sccopy` and `scpaste` are installed (the package's `bin`, small Node scripts in `host/`); the host's own `pbcopy`, `xclip` and the rest are never shadowed. They hand off to the platform's clipboard tool, the first one on `PATH`:

| platform | `sccopy` | `scpaste` |
| --- | --- | --- |
| macOS | `pbcopy` | `pbpaste` |
| Linux, under Wayland (`WAYLAND_DISPLAY` set) | `wl-copy` | `wl-paste --no-newline` |
| Linux, X11 | `xclip -selection clipboard -i`, else `xsel --clipboard --input` | `xclip -selection clipboard -o`, else `xsel --clipboard --output` |
| Windows | PowerShell `Set-Clipboard` | PowerShell `Get-Clipboard -Raw` |

- **Text only, bytes in = bytes out:** UTF-8 and a trailing newline survive a round trip unchanged, and `scpaste` adds nothing. On macOS, `pbcopy` and `pbpaste` run with `LANG` and `LC_ALL` set to `en_US.UTF-8`. On Windows, `powershell.exe` (else `pwsh.exe`) reads stdin and writes stdout as raw UTF-8 bytes, not through the console code page; `clip.exe` isn't used, as it mangles non-ASCII. Under Wayland, `wl-copy` and `wl-paste` come first, then `xclip` and `xsel` (through XWayland). Other Unix systems are treated as Linux.
- **Spawning:** the tool runs with a fixed argv and no shell. `sccopy` doesn't wait for the background process that `xclip`, `xsel` and `wl-copy` leave behind to serve the clipboard.
- **Errors:** with no tool on `PATH`, `sccopy: no clipboard tool found (tried xclip, xsel)` (the names tried on that platform) to stderr, exit 1. A tool that fails has its stderr passed through, exit 1. `-h` and `--help` print `usage: sccopy` (or `scpaste`) to stdout and exit 0; any other argument prints `sccopy: unknown option: <arg>` and the usage line to stderr, and exits 2.

**In SLICC, the `sh` commands win.** The package has both `bin` and `slicc.commands`, and both name `sccopy` and `scpaste`. The kernel ignores a package's `bin` entry when the same package declares that name in `slicc.commands` (where it reads `bin` at all, in its appended command roots), so `/usr/bin/sccopy` is always `bin/sccopy`. bios's base set doesn't put `bin` links on `PATH`, and after a `pnpm add -g`, bios removes the `$PNPM_HOME/bin` link pnpm made for each name a package declares in both `bin` and `slicc.commands`, so the Node scripts, which SLICC has no Node to run, never shadow the `sh` ones.

## The device

What the scripts rely on from `/dev/clipboard` (slicc-kernel 1.75.0 and later):

- Reading gives the clipboard's text as UTF-8, from one snapshot, then EOF.
- Writing buffers per open file; the copy happens at `close()`. Coreutils `cat` reports an error there as a write error, so the scripts always write through `cat`, never a shell builtin.
- A copy over 1 MiB fails with `EFBIG`, invalid UTF-8 with `EILSEQ`, a refusal (the tab not in front, or no permission) with `EACCES`, an embedder without a clipboard with `ENOTSUP`, anything else with `EIO`. Coreutils sees only the errno, so the commands print its message (`Permission denied`, `Not supported`, `File too large`, `Illegal byte sequence`, `I/O error`), not the hook's. After `Permission denied`, they add a second line that says what to do.

Copying or pasting NUL bytes isn't supported: the text goes through shell variables when it has to be trimmed.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

- `npm run lint`: Biome, the no-comment check and the other [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web) checks, `shellcheck -s sh` and `dash -n` on every script.
- `npm test`: the integration tests in `test/integration/`. The kernel tests run on `@ai-ecoverse/slicc-kernel/node` with wasm-bash and wasm-coreutils, and a fake `clipboard` hook behind the real `/dev/clipboard`: gh's command lines, a round trip, UTF-8, an empty clipboard, the options of all eight, `EACCES`, `EIO`, `ENOTSUP`, `EFBIG`, `EILSEQ`, an ordinary user under `users: 'enforce'`, slicc-kernel 1.74.0, which has no `/dev/clipboard` (as the devDependency `slicc-kernel-without-clipboard`), and a kernel that reads npm `bin` entries, where `sccopy` and `scpaste` must still be the `sh` ones. `test/integration/host.test.mjs` runs `host/` against fake `pbcopy`, `pbpaste`, `wl-copy`, `wl-paste`, `xclip`, `xsel`, `powershell.exe` and `pwsh.exe` on a temporary `PATH`, with the platform forced through `run({ platform })`, so each branch is checked on any machine: the tool picked, its argv, its stdin and stdout, the UTF-8 locale on macOS, the PowerShell script on Windows, the fallbacks, a failing tool's stderr, an empty `PATH` and the argument errors. On CI, it also round-trips UTF-8 (a non-BMP character and a tab included), a trailing newline, a newline alone and an empty clipboard through the real clipboard: under Linux with an X display through `xclip` and `xsel` when they're installed, and on Windows through `powershell.exe` and, when it's on `PATH`, `pwsh.exe`; it skips each of those, saying why, everywhere else. On Windows, which doesn't run the fake tools' shebangs, the tests with fake tools skip. `test/integration/repo.test.mjs` checks the workflow, the release config and what `npm pack` ships.
- `npm run test:unit`: the unit tests in the gitignored `test/unit/`. They run every script under dash and bash, against copies of the scripts that use a temporary file as the device (the shipped scripts always use `/dev/clipboard`), and `scripts/cover.mjs` turns bash's `xtrace` into line coverage in `coverage/unit/lcov.info`, next to Node's coverage of `host/`, whose tests use fake tools on `PATH`. The pre-commit hook wants 100% coverage of the changed lines.

CI is `.github/workflows/ci.yml`, the only workflow, which runs [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) at the devDependency's version: `npm run lint`, then `npm test` split over two shards on Linux and, on pull requests and in the merge queue, `npm run test:windows` (`host.test.mjs` alone) on GitHub's `windows-latest`, which `ci / integration` requires, then on a pull request the Claude and Codex reviews. Nothing runs on macOS: the pipeline has no macOS runner. The merge queue requires `ci / integration` and `ci / review`. On a push to `main`, semantic-release releases and publishes to npm through trusted publishing, with provenance from `ci.yml`.

## License

Apache-2.0
