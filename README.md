# pi-caffeinated

A Pi extension that adds a `/caffeinate` command for keeping your machine awake. It starts a platform-native keep-awake process in the background and shows a centered coffee-break modal while it runs.

## Features

- `/caffeinate` toggles a platform-native keep-awake process
- Centered overlay modal that captures input while running
- Escape stops caffeinate and closes the modal
- Animated mug, computer, and elapsed timer
- Status bar indicator while caffeinate is active
- Cleans up the background process when Pi shuts down

## Platform support

| Platform | Mechanism | Requires |
| --- | --- | --- |
| macOS | `caffeinate -dimsu` | Built in |
| Linux | `systemd-inhibit --what=idle:sleep ... sleep infinity` | `systemd-inhibit` on systemd-based distros |
| Windows | PowerShell calling `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` | PowerShell |

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

- Pi coding agent extension runtime
- One supported keep-awake backend from the platform table above

## License

MIT
