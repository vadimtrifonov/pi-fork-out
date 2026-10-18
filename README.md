# pi-fork-out

A [Pi](https://pi.dev) extension that clones or forks conversations into separate terminal sessions.
The original session stays open.

## Supported terminals/multiplexers

- [Herdr](https://herdr.dev) (Windows, macOS, Linux)
- [Ghostty](https://ghostty.org) (macOS)
- Windows Terminal (Windows)

## Install

```shell
pi install git:github.com/vadimtrifonov/pi-fork-out
```

## Usage

```text
/clone-out [right|down|tab|window]  # Duplicate the current session at the current position (default: right)
/fork-out  [right|down|tab|window]  # Create a new fork from an earlier point (default: right)
```

`window` opens Ghostty on macOS or Windows Terminal on Windows, including from inside Herdr.

Selecting a user message forks before it and restores its text as an editable draft.
Selecting any other entry forks after it with an empty editor.

## Limitations

- Ghostty runs Pi through its configured shell.
  Variables exported only in the originating terminal are not copied.

## License

MIT
