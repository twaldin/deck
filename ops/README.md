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
- refuses to replace a changed plist for a loaded, running service unless the operator passes `--force-service` with `--yes`;
- does not restart an unchanged loaded service;
- only runs from the primary checkout. It refuses linked worktrees and a `DECK_ROOT` that differs from the installer checkout;
- skips a unit with a warning when its `<checkout>/<daemon>/src/main.ts` entrypoint is missing.

To deliberately restart a live service after a plist change:

```sh
cd ~/dev/deck
./ops/install.sh --yes --force-service
```

The installer stops the broker and waits for both port 8377 and `~/.deck/run/broker.sock` to be free before it starts the replacement.

`RunAtLoad` starts each installed daemon. `KeepAlive` restarts it after an exit, with launchd throttling restarts to one attempt every five seconds.

## Smithers Gateway

`ai.deck.smithers-gateway` serves the authenticated Gateway on `http://127.0.0.1:7331`.

It loads workflow modules from the canonical checkout but serves the LIVE run
workspace `~/.deck/state/smithers`, which holds the run database. The two paths
are different on purpose. `SMITHERS_WORKSPACE_ROOT` in the plist sets the
workspace; a gateway started without it reads the source tree and lists no runs.

The gateway registers `pr-pipeline` and `stack-owner` with approval UI routes:

- `http://127.0.0.1:7331/workflows/pr-pipeline`
- `http://127.0.0.1:7331/workflows/stack-owner`

Every route except `/health` requires the bearer described in
[`docs/gateway-auth.md`](../docs/gateway-auth.md). Direct browser navigation
cannot attach that header; do not expose or advertise these UI routes until the
separate browser authentication bootstrap is installed.

Approving in the browser submits the Gateway `submitApproval` RPC. The browser
never merges. The approval releases the workflow's own gate, and the workflow
then re-checks the PR head and runs its merge node itself.

A gateway may already be loaded under this label. Do not install or restart the
KeepAlive job until its `SMITHERS_GATEWAY_TOKEN` secret environment is
provisioned per `docs/gateway-auth.md`; the gateway intentionally fails closed
without it. Once provisioned, preview and explicitly restart:

```sh
cd ~/dev/deck
./ops/install.sh                        # preview only, changes nothing
./ops/install.sh --yes --force-service  # apply and restart the gateway
```

Verify that both workflows are served:

```sh
curl -s \
  -H "Authorization: Bearer $SMITHERS_GATEWAY_TOKEN" \
  http://127.0.0.1:7331/workflows
```

Both `pr-pipeline` and `stack-owner` must appear with `"hasUi":true`.

Check launchd status:

```sh
launchctl print gui/$(id -u)/ai.deck.smithers-gateway
```

## Logs

Both stdout and stderr go to one file per daemon:

- broker: `~/.deck/logs/broker.log`
- resource monitor: `~/.deck/logs/resource-monitor.log`
- smithers gateway: `~/.deck/logs/smithers-gateway.log`

Resource metrics append to `~/.deck/data/resource-monitor/metrics.log`. An older file at `~/.deck/data/resource-monitor` moves to `.legacy` before the directory is created.

Follow them with:

```sh
tail -f ~/.deck/logs/broker.log
tail -f ~/.deck/logs/resource-monitor.log
tail -f ~/.deck/logs/smithers-gateway.log
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
