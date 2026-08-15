# pi-branch

A minimal [Pi](https://pi.dev) extension for branching into a new Windows Terminal pane, tab, or window while keeping the original session open. It copies the current active path through Pi's session tree into a new session file and launches `pi --session <file>` in PowerShell.

## Requirements

- Windows Terminal (`wt.exe`)
- PowerShell 7 (`pwsh.exe`)

## Install

```shell
pi install git:github.com/vadimtrifonov/pi-branch
```

## Usage

```text
/branch          # New pane on the right (default)
/branch pane     # New pane on the right
/branch tab      # New tab
/branch window   # New Windows Terminal window
```

## License

MIT
