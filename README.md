# pi-fork-out

A [Pi](https://pi.dev) extension that clones or forks conversations into separate terminal sessions.
The original session stays open.

## Supported terminals/multiplexers

- [Herdr](https://herdr.dev) (Windows, macOS, Linux)
- Windows Terminal

## Install

```shell
pi install git:github.com/vadimtrifonov/pi-fork-out
```

## Usage

```text
/clone-out [right|down|tab|window]  # Duplicate the current session at the current position (default: right)
/fork-out  [right|down|tab|window]  # Create a new fork from a previous user message (default: right)
```

A fork ends before the selected user message and restores it as an editable draft.

## License

MIT
