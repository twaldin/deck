# Deck resident daemons

## WARNING: stop the hub-supervised broker first

Installing `ai.deck.broker` while the hub-supervised `deck-broker` development process is running starts a second broker. Both processes will try to bind port 8377.

Before activation, have the active coding-harness operator stop the hub process named `deck-broker` with the hub process manager and verify that it is stopped. Do not run the installer until that has happened. The scripts do not stop or restart the hub process.

## Install and activate

From the Deck checkout:

```sh
cd ~/dev/deck
./ops/install.sh
```

The first command is a dry-run preview. It prints every copy, load, and status action and makes no changes. After the hub-supervised broker has been stopped, apply the plan explicitly:

```sh
cd ~/dev/deck
./ops/install.sh --yes
```

The installer:

- creates `~/.deck/logs` with mode `0700`;
- copies available units to `~/Library/LaunchAgents`;
- runs `launchctl bootstrap gui/$(id -u) <plist>`, falling back to `launchctl load -w <plist>` on older launchctl behavior;
- leaves an already loaded service running and reports its status;
- skips a unit with a warning when its `~/dev/deck/<daemon>/src/main.ts` entrypoint is missing.

`RunAtLoad` starts each installed daemon. `KeepAlive` restarts it after an exit, with launchd throttling restarts to one attempt every five seconds.

Check launchd status:

```sh
launchctl print gui/$(id -u)/ai.deck.broker
```

## Logs

Both stdout and stderr go to one file per daemon:

- broker: `~/.deck/logs/broker.log`

Follow them with:

```sh
tail -f ~/.deck/logs/broker.log
tail -f ~/.deck/logs/broker.log
```

## Uninstall

Preview removal without changing anything:

```sh
cd ~/dev/deck
./ops/uninstall.sh
```

Boot out both labels and remove their installed plists:

```sh
cd ~/dev/deck
./ops/uninstall.sh --yes
```

The uninstaller uses `launchctl bootout`, falls back to `launchctl unload -w` (or label-based `launchctl remove` when an installed plist is already absent), verifies that each label is absent, and removes its plist. Re-running it is safe. It preserves `~/.deck/logs` and the daemon log files.
