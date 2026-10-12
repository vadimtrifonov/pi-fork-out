# pi-fork-out

A [Pi](https://pi.dev) extension that clones or forks conversations into separate terminal sessions.
The original session stays open.

## Supported terminals

`pane` and `tab` open in the terminal running Pi: [Herdr](https://herdr.dev) (Windows, macOS, Linux) or Windows Terminal.
`window` opens a new Windows Terminal window on Windows.

## Install

```shell
pi install git:github.com/vadimtrifonov/pi-fork-out
```

## Usage

```text
/clone-out [pane|tab|window]  # Duplicate the current session at the current position (default: `pane`)
/fork-out  [pane|tab|window]  # Create a new fork from a previous user message (default: `pane`)
```

A fork ends before the selected user message and restores it as an editable draft.

## License

MIT
