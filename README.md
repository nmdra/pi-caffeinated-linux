# pi-caffeinated

A Pi extension that adds a `/caffeinate` command for macOS. It starts `caffeinate -dimsu` in the background and shows a centered coffee-break modal while your Mac is kept awake.

## Features

- `/caffeinate` toggles macOS `caffeinate -dimsu`
- Centered overlay modal that captures input while running
- Escape stops caffeinate and closes the modal
- Animated mug, computer, and elapsed timer
- Status bar indicator while caffeinate is active
- Cleans up the background process when Pi shuts down

## Install

```sh
pi install npm:pi-caffeinated
```

Restart Pi after installing or updating the extension.

## Usage

Run the command inside Pi:

```text
/caffeinate
```

Press `Esc` in the modal to stop. Running `/caffeinate` again also toggles it off.

## Requirements

- macOS
- Pi coding agent extension runtime
- The system `caffeinate` command

## License

MIT
