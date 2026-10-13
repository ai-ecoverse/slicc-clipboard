# slicc-clipboard

Clipboard commands for SLICC: `pbcopy`, `pbpaste`, `xclip`, `xsel`, `wl-copy` and `wl-paste`, as POSIX `sh` scripts over the kernel's `/dev/clipboard` character device. Programs that shell out to a clipboard tool, such as `gh` through [atotto/clipboard](https://github.com/atotto/clipboard), find one whichever they look for.

The kernel answers the device from its embedder's `clipboard` hook, which in seven is `navigator.clipboard` in seven's own page. It needs seven's tab in front, and Chrome's clipboard permission for reading. Text only.

## Install

The package declares its commands in `slicc.commands`, so installing it puts them in `/usr/bin`:

```sh
pnpm add -g @ai-ecoverse/slicc-clipboard
```

## Commands

| command | copies | pastes |
| --- | --- | --- |
| `pbcopy` | stdin | |
| `pbpaste` | | to stdout |
| `xclip` | `-i`, `-in`: stdin, or the files named | `-o`, `-out` |
| `xsel` | `-i`, `--input`: stdin | `-o`, `--output` |
| `wl-copy` | stdin, or the arguments joined by spaces | |
| `wl-paste` | | to stdout, then a newline |

- **xclip:** `-selection` (or `-se`, `-sel`, …) takes `clipboard`, `primary` or `secondary`, or any prefix of one (`c`, `clip`, `p`); all three are the one clipboard, and `primary` is the default. `-rmlastnl` (or `-r`) drops one newline at the end of what is copied or pasted. A file named `-` is stdin. Without `-i` or `-o`, xclip copies, unless stdin is a terminal; then it pastes. Of `-i` and `-o`, the last one wins, and files are ignored when pasting.
- **xsel:** `-b`/`--clipboard`, `-p`/`--primary` and `-s`/`--secondary` all mean the one clipboard. `-c`/`--clear` empties it. `-n`/`--nodetach` is accepted and does nothing. Without a mode, xsel copies, unless stdin is a terminal; then it pastes. Of `-i`, `-o` and `-c`, the last one wins. It takes no other arguments.
- **wl-copy:** `-n`/`--trim-newline` drops one newline at the end. `-c`/`--clear` empties the clipboard. Options may come anywhere, until `--`.
- **wl-paste:** `-n`/`--no-newline` leaves out the newline it adds.
- **Help:** `-h` and `--help` (`-help` for xclip) print the usage line to stdout and exit 0.

An unknown option (or an argument a command doesn't take) prints the command's error and its usage line to stderr and exits 2. When the device fails, the command prints `name: ` and the device's message to stderr, and exits 1; for example:

```
pbcopy: The clipboard needs seven's tab to be in front, and clipboard access allowed
```

## The device

What the scripts rely on from `/dev/clipboard`:

- Reading gives the clipboard's text as UTF-8, from one snapshot, then EOF.
- Writing buffers per open file; the copy happens at `close()`. Coreutils `cat` reports an error there as a write error, so the scripts always write through `cat`, never a shell builtin.
- A copy over 1 MiB fails with `EFBIG`, invalid UTF-8 with `EILSEQ`, a refusal (the tab not in front, or no permission) with `EACCES`, an embedder without a clipboard with `ENOTSUP`, anything else with `EIO`, each with the hook's message.

Copying or pasting NUL bytes isn't supported: the text goes through shell variables when it has to be trimmed.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

- `npm run lint`: Biome, the no-comment check and the other [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web) checks, `shellcheck -s sh` and `dash -n` on every script.
- `npm test`: the integration tests in `test/integration/`, on `@ai-ecoverse/slicc-kernel/node` with its bash and coreutils.
- `npm run test:unit`: the unit tests in the gitignored `test/unit/`. They run every script under dash and bash, against a temporary file as the device (`SLICC_CLIPBOARD_TEST_DEVICE`, for tests only), and `scripts/cover.mjs` turns bash's `xtrace` into line coverage in `coverage/unit/lcov.info`. The pre-commit hook wants 100% coverage of the changed lines.

Releases come from `main` through semantic-release, and the release workflow publishes to npm with trusted publishing and provenance.

## License

Apache-2.0
