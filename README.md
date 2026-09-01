# pi-caffeinated

A Linux-only Pi extension that keeps the machine awake with
`systemd-inhibit`.

## Features

- `/caffeinate` toggles a systemd inhibitor for idle and sleep actions
- Colored live Pi footer status: ` [awake] idle+sleep · <elapsed>`
- Press `Esc` or run `/caffeinate` again to stop
- KDE Plasma tray indicator through the StatusNotifierItem D-Bus protocol
- Click the tray indicator to stop caffeinate
- Cleans up the inhibitor and indicators when Pi shuts down

## Requirements

- Pi coding agent extension runtime
- Linux with `systemd-inhibit` available on `PATH`
- A D-Bus session bus for the optional KDE tray indicator

The extension uses this systemd command:

```text
systemd-inhibit --what=idle:sleep --who=pi-caffeinated \
  --why="Keeping the machine awake from Pi" --mode=block sleep infinity
```

The `idle` lock prevents automatic idle handling. The `sleep` lock prevents
user-requested suspend and hibernation. The tray indicator is optional; the Pi
status and systemd inhibitor continue to work when no StatusNotifier host is
available.

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

While active:

- Pi shows a colored ` [awake] idle+sleep · <elapsed>` status in the footer.
- KDE Plasma shows an active coffee indicator in the system tray when a
  StatusNotifier host is available.

Stop caffeinate with `Esc`, by running `/caffeinate` again, or by clicking the
KDE tray indicator.

## Diagnostics

List active systemd inhibitors with:

```sh
systemd-inhibit --list
```

Look for an entry with `pi-caffeinated` and both `idle` and `sleep` (the
order may appear as `sleep:idle`). If `systemd-inhibit`
is not found, install the systemd package for your distribution. If the KDE
tray indicator is unavailable, check that a user D-Bus session and a Plasma
StatusNotifier host are running; the colored Pi footer status remains available
without them.

## License

MIT
