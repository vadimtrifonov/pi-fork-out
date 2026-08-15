# pi-terminal-branch

A [Pi](https://pi.dev) extension that opens clones and forks in a new Windows Terminal pane, tab, or window while keeping the original session open. It copies the selected path through Pi's session tree into a new session file and launches Pi directly with `--session <file>`.

## Requirements

- Windows Terminal (`wt.exe`)

## Install

```shell
pi install git:github.com/vadimtrifonov/pi-terminal-branch
```

## Usage

```text
/clone-out [pane|tab|window]  # Duplicate the current session at the current position (default: `pane`)
/fork-out  [pane|tab|window]  # Create a new fork from a previous user message (default: `pane`)
```

## License

MIT
