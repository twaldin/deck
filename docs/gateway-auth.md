# Smithers Gateway authentication

Deck's Gateway fails closed unless `SMITHERS_GATEWAY_TOKEN` is set. The same bearer is required by HTTP RPC/API calls, Gateway UI reads, and the WebSocket `connect` frame. `GET /health` remains public by Smithers design and must contain no run data.

## Issue and install a token

Run the repository-pinned Smithers CLI; do not generate an unrelated random secret:

```sh
cd ~/dev/deck/workflows/.smithers
./node_modules/.bin/smithers token issue \
  --scopes '*' \
  --role operator \
  --ttl 90d \
  --action-id gateway \
  --reveal-token \
  --format json
```

Store the returned `token` in the Gateway process's secret environment as `SMITHERS_GATEWAY_TOKEN`, then restart the Gateway. Never put the bearer in this repository, a launchd plist, shell history, a URL, or a tailnet ACL.

Clients must send `Authorization: Bearer <token>` for HTTP. A `SmithersGatewayClient` must receive the same value as its `token` option so it includes the token in the WebSocket `connect` frame.

Smithers 0.30.0 does not load CLI grants into an embedded `new Gateway(...)` by itself. Deck closes that seam at startup: `SMITHERS_GATEWAY_TOKEN` must match a grant in the CLI's `~/.smithers/tokens.json`, and Deck copies that grant's scopes and expiry into the Gateway auth map. Because Smithers does not revalidate established WebSockets, Deck stops the whole Gateway at grant expiry; that closes cached sessions, and launchd then fails closed until the token is rotated. `smithers token revoke` updates the store but cannot mutate a running Gateway's in-memory grant, so revocation also requires a restart.

## Rotate

1. Issue a replacement with the command above and put it in the Gateway's secret environment.
2. Restart the Gateway. The old bearer stops working at restart because only the replacement is loaded.
3. Run the negative test, then verify the restarted service accepts the replacement:

   ```sh
   curl -fsS \
     -H "Authorization: Bearer $SMITHERS_GATEWAY_TOKEN" \
     http://127.0.0.1:7331/v1/api/runs
   ```

4. Record revocation of the old grant:

   ```sh
   ./node_modules/.bin/smithers token revoke "$OLD_SMITHERS_GATEWAY_TOKEN"
   ```

   Load that variable from the secret store without pasting the bearer into the command line.

If the token is exposed, do the same rotation immediately; do not wait for its TTL.

The repository launchd template does not provision secrets. Do not load its KeepAlive Gateway job until the live-cutover step has installed `SMITHERS_GATEWAY_TOKEN`; otherwise the intended fail-closed startup will restart-loop.

## Approve from a phone

Tailnet reachability is transport, not authentication. Exposure is allowed only after the repository test passes against the live Smithers home from the machine that will serve it:

```sh
cd ~/dev/deck
SMITHERS_AUTH_TEST_WORKSPACE_ROOT="$HOME/.deck/state/smithers" \
  bun workflows/.smithers/test-gateway-auth.ts
```

The test starts a separate Gateway on an OS-assigned ephemeral loopback port, issues its bearer with the pinned CLI into a temporary token store, and always stops the process. It verifies missing, unissued, and revoked tokens fail startup; anonymous and wrong-token root/UI, metrics, workflow metadata, HTTP RPC/API, and WebSocket requests are rejected; pre-connect WS reads and mutations are denied; the challenge contains only a nonce and timestamp; no application data leaks through rejection/close; issued-token requests succeed; and grant expiry closes an active authenticated socket and stops the Gateway.

Smithers 0.30.0 serves `GET /metrics` and `GET /workflows` before its auth router. Deck therefore publishes a thin authenticated HTTP proxy and keeps the native Gateway on an OS-assigned loopback-only internal port. The proxy requires the same bearer on every HTTP route except intentionally public `/health`.

Smithers upgrades a WebSocket before authenticating its mandatory `connect` frame. Rejecting the HTTP upgrade would break its browser client because the browser WebSocket API cannot set an `Authorization` header, so Deck accepts the upgrade but gates the protocol: before Smithers confirms `connect`, the proxy forwards only one `connect` request, directly rejects every read/mutation, caps connections, frames, and pre-auth queues, and canonicalizes the credential passed upstream. A missing or wrong-token client receives only `connect.challenge`, then `UNAUTHORIZED` and a policy close; no run read or mutation is dispatched. Direct browser navigation to the embedded UI still cannot attach the required HTTP bearer, so a phone UI needs a separate authentication bootstrap.

The upgrade-then-reject window means approve-from-phone tailnet exposure stays **captain-attended** even after the live-home test passes. An unattended or broadly shared tailnet exposure is not allowed; tailnet configuration and a browser-token bootstrap are separate follow-up work.
