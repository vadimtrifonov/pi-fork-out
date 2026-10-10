# pi-fork-out

A [Pi](https://pi.dev) extension that clones or forks conversations into separate terminal sessions.
The original session stays open.

## Supported terminals

| Terminal         | Platform             | Destinations            | Default |
| ---------------- | -------------------- | ----------------------- | ------- |
| Windows Terminal | Windows              | `pane`, `tab`, `window` | `pane`  |
| Warp             | Windows, macOS (zsh) | `tab`, `window`         | `tab`   |

Warp tabs open in the currently focused Warp window.
Paths containing `{{` are not supported with Warp.

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
