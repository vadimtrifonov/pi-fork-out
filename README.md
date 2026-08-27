# pi-fork-out

A [Pi](https://pi.dev) extension that opens a clone or fork in a new Windows Terminal pane, tab, or window. The original session stays open.

The extension copies the selected path through Pi's session tree into a new session file. It starts Pi with `--session <file>`.

## Requirements

- Windows Terminal (`wt.exe`)

## Install

```shell
pi install git:github.com/vadimtrifonov/pi-fork-out
```

## Usage

```text
/clone-out [pane|tab|window]  # Duplicate the current session at the current position (default: `pane`)
/fork-out  [pane|tab|window]  # Create a new fork from a previous user message (default: `pane`)
```

## License

MIT
