import { readSmithersTokenStore } from "@smithers-orchestrator/cli/token-store";
import { Gateway, mdxPlugin } from "smithers-orchestrator";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const workflowsRoot = resolve(here, "..");
// The gateway loads workflow modules from this checkout but must serve the LIVE
// run workspace: the DB, executions and prompts live there, not in the source
// tree. Without this the gateway reads an empty workspace and lists no runs.
const workspaceRoot = resolve(process.env.SMITHERS_WORKSPACE_ROOT ?? process.cwd());
process.chdir(workspaceRoot);

const portValue = process.env.PORT?.trim();
const parsedPort = Number(portValue || "7331");
const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 7331;
const host = process.env.HOST ?? "127.0.0.1";
const bearer = process.env.SMITHERS_GATEWAY_TOKEN?.trim();
if (!bearer) {
  throw new Error("SMITHERS_GATEWAY_TOKEN is required");
}

const issuedGrant = readSmithersTokenStore().tokens[bearer];
if (!issuedGrant) {
  throw new Error("SMITHERS_GATEWAY_TOKEN must be issued by `smithers token issue`");
}
if (issuedGrant.revokedAtMs !== undefined) {
  throw new Error("SMITHERS_GATEWAY_TOKEN has been revoked");
}
const expiresAtMs = issuedGrant.expiresAtMs;
if (expiresAtMs === undefined || expiresAtMs <= Date.now()) {
  throw new Error("SMITHERS_GATEWAY_TOKEN has expired or has no expiry");
}
if (!issuedGrant.scopes.includes("*")) {
  throw new Error("SMITHERS_GATEWAY_TOKEN must grant the `*` scope");
}

const gateway = new Gateway({
  heartbeatMs: 15_000,
  workspaceRoot,
  // Smithers 0.30 defaults to an all-powerful unauthenticated operator unless
  // auth is explicit. This one config gates HTTP RPC/API, UI reads, and the
  // WebSocket connect frame through the same token grant.
  auth: {
    mode: "token",
    tokens: {
      [bearer]: {
        role: issuedGrant.role ?? "operator",
        scopes: issuedGrant.scopes,
        ...(issuedGrant.userId ? { userId: issuedGrant.userId } : {}),
        tokenId: issuedGrant.tokenId,
        ...(issuedGrant.issuedAtMs !== undefined ? { issuedAtMs: issuedGrant.issuedAtMs } : {}),
        expiresAtMs,
      },
    },
  },
  // The default root redirects before UI authorization. Mounting the built-in
  // operator UI at `/` makes the required negative GET / probe pass through
  // Smithers' UI auth gate too.
  operatorUi: { path: "/" },
});

const internalHost = "127.0.0.1";

type ProxySocketData = {
  upstream: WebSocket;
  client: Bun.ServerWebSocket<ProxySocketData> | null;
  pendingUpstream: string[];
  pendingClient: string[];
  upstreamReady: boolean;
  failed: boolean;
  authState: "awaiting-connect" | "authenticating" | "authenticated" | "rejected";
  connectId: string | null;
  authTimer?: ReturnType<typeof setTimeout>;
  connectTokenValid: boolean;
};

let publicServer: Bun.Server<ProxySocketData> | null = null;
let proxyConnections = 0;
const MAX_PROXY_CONNECTIONS = 128;
const MAX_PRE_AUTH_QUEUE = 4;
const PROXY_AUTH_TIMEOUT_MS = 5_000;
const MAX_PROXY_PAYLOAD_BYTES = 4 * 1024 * 1024;

function bearerFromRequest(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  if (!authorization || authorization.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const token = authorization.slice(7);
  return token ? token : null;
}

function clearProxyAuthTimer(data: ProxySocketData): void {
  clearTimeout(data.authTimer);
  data.authTimer = undefined;
}

function sendProxyClient(data: ProxySocketData, message: string): boolean {
  if (data.client) {
    data.client.send(message);
    return true;
  }
  if (data.pendingClient.length < MAX_PRE_AUTH_QUEUE) {
    data.pendingClient.push(message);
    return true;
  }
  data.failed = true;
  data.upstream.close(1009, "Gateway proxy queue limit exceeded");
  return false;
}

function rejectPreAuthRequest(
  client: Bun.ServerWebSocket<ProxySocketData>,
  id: string,
): void {
  clearProxyAuthTimer(client.data);
  client.data.authState = "rejected";
  client.send(
    JSON.stringify({
      type: "res",
      id,
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Connect first" },
    }),
  );
  client.data.upstream.close(1008, "authentication required");
}

async function closeGatewayServers(): Promise<void> {
  const server = publicServer;
  publicServer = null;
  await Promise.all([gateway.close(), server?.stop(true) ?? Promise.resolve()]);
}

function createAuthenticatedProxy(internalPort: number): Bun.Server<ProxySocketData> {
  return Bun.serve<ProxySocketData>({
    hostname: host,
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (proxyConnections >= MAX_PROXY_CONNECTIONS) {
          return new Response("Gateway connection limit reached\n", { status: 503 });
        }
        const data: ProxySocketData = {
          upstream: new WebSocket(`ws://${internalHost}:${internalPort}${url.pathname}${url.search}`),
          client: null,
          pendingUpstream: [],
          pendingClient: [],
          upstreamReady: false,
          failed: false,
          authState: "awaiting-connect",
          connectId: null,
          connectTokenValid: false,
        };
        data.authTimer = setTimeout(() => {
          if (data.authState === "authenticated" || data.authState === "rejected") return;
          data.authState = "rejected";
          data.upstream.close(1008, "authentication timed out");
          data.client?.close(1008, "authentication timed out");
        }, PROXY_AUTH_TIMEOUT_MS);
        data.upstream.addEventListener("open", () => {
          data.upstreamReady = true;
          for (const message of data.pendingUpstream) data.upstream.send(message);
          data.pendingUpstream.length = 0;
        });
        data.upstream.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            data.failed = true;
            data.client?.close(1011, "Gateway proxy received a non-text frame");
            data.upstream.close(1011, "Gateway proxy received a non-text frame");
            return;
          }

          let outbound = event.data;
          if (data.authState !== "authenticated") {
            let frame: {
              type?: string;
              id?: string;
              event?: string;
              payload?: unknown;
              ok?: boolean;
            };
            try {
              frame = JSON.parse(event.data);
            } catch {
              data.failed = true;
              clearProxyAuthTimer(data);
              data.client?.close(1011, "Gateway proxy received invalid JSON");
              data.upstream.close(1011, "Gateway proxy received invalid JSON");
              return;
            }
            const challenge =
              frame.type === "event" &&
              frame.event === "connect.challenge" &&
              frame.payload !== null &&
              typeof frame.payload === "object" &&
              !Array.isArray(frame.payload) &&
              typeof (frame.payload as Record<string, unknown>).nonce === "string" &&
              typeof (frame.payload as Record<string, unknown>).ts === "number" &&
              Object.keys(frame.payload as Record<string, unknown>).every(
                (key) => key === "nonce" || key === "ts",
              );
            const connectResponse =
              data.authState === "authenticating" &&
              frame.type === "res" &&
              frame.id === data.connectId;
            if (!challenge && !connectResponse) {
              data.failed = true;
              data.authState = "rejected";
              clearProxyAuthTimer(data);
              data.client?.close(1008, "Unexpected pre-auth Gateway frame");
              data.upstream.close(1008, "Unexpected pre-auth Gateway frame");
              return;
            }
            if (connectResponse) {
              clearProxyAuthTimer(data);
              if (frame.ok === true && data.connectTokenValid) {
                data.authState = "authenticated";
              } else {
                data.authState = "rejected";
                outbound = JSON.stringify({
                  type: "res",
                  id: data.connectId,
                  ok: false,
                  error: { code: "UNAUTHORIZED", message: "Invalid token" },
                });
                sendProxyClient(data, outbound);
                data.client?.close(1008, "authentication failed");
                data.upstream.close(1008, "authentication failed");
                return;
              }
            }
          }
          sendProxyClient(data, outbound);
        });
        data.upstream.addEventListener("close", (event) => {
          clearProxyAuthTimer(data);
          data.failed = true;
          data.client?.close(event.code || 1000, event.reason);
        });
        data.upstream.addEventListener("error", () => {
          clearProxyAuthTimer(data);
          data.failed = true;
          data.client?.close(1011, "Gateway proxy upstream failed");
        });
        if (server.upgrade(req, { data })) {
          proxyConnections += 1;
          return;
        }
        clearProxyAuthTimer(data);
        data.upstream.close();
        return new Response("WebSocket upgrade failed\n", { status: 500 });
      }

      if (url.pathname === "/health") {
        try {
          const upstream = await fetch(`http://${internalHost}:${internalPort}/health`);
          const payload = (await upstream.json()) as { ok?: unknown };
          return Response.json({ ok: upstream.ok && payload.ok === true }, { status: upstream.status });
        } catch {
          return Response.json({ ok: false }, { status: 502 });
        }
      }
      if (bearerFromRequest(req) !== bearer) {
        return Response.json(
          {
            ok: false,
            error: { code: "UNAUTHORIZED", message: "A valid bearer token is required" },
          },
          { status: 401 },
        );
      }

      const headers = new Headers(req.headers);
      headers.set("host", `${internalHost}:${internalPort}`);
      headers.delete("x-smithers-key");
      headers.set("authorization", `Bearer ${bearer}`);
      try {
        return await fetch(`http://${internalHost}:${internalPort}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          redirect: "manual",
        });
      } catch (error) {
        return new Response(
          `Gateway proxy error: ${error instanceof Error ? error.message : String(error)}\n`,
          { status: 502 },
        );
      }
    },
    websocket: {
      open(client) {
        const data = client.data;
        data.client = client;
        if (data.failed) {
          client.close(1011, "Gateway proxy upstream failed");
          return;
        }
        for (const message of data.pendingClient) client.send(message);
        data.pendingClient.length = 0;
      },
      message(client, message) {
        if (typeof message !== "string") {
          clearProxyAuthTimer(client.data);
          client.data.authState = "rejected";
          client.data.upstream.close(1003, "Gateway protocol requires text frames");
          client.close(1003, "Gateway protocol requires text frames");
          return;
        }
        const data = client.data;
        if (data.authState === "authenticated") {
          data.upstream.send(message);
          return;
        }
        if (data.authState === "rejected") {
          client.close(1008, "authentication required");
          return;
        }

        let frame: {
          type?: string;
          id?: string;
          method?: string;
          params?: { auth?: { token?: unknown } };
        };
        try {
          frame = JSON.parse(message);
        } catch {
          rejectPreAuthRequest(client, "invalid-request");
          return;
        }
        if (data.authState !== "awaiting-connect") {
          rejectPreAuthRequest(client, frame.id ?? "pre-auth-request");
          return;
        }
        if (frame.type !== "req" || frame.method !== "connect" || typeof frame.id !== "string") {
          rejectPreAuthRequest(client, frame.id ?? "pre-auth-request");
          return;
        }

        data.authState = "authenticating";
        data.connectId = frame.id;
        data.connectTokenValid = frame.params?.auth?.token === bearer;
        if (data.upstreamReady) {
          data.upstream.send(message);
        } else if (data.pendingUpstream.length < MAX_PRE_AUTH_QUEUE) {
          data.pendingUpstream.push(message);
        } else {
          rejectPreAuthRequest(client, frame.id);
        }
      },
      close(client) {
        clearProxyAuthTimer(client.data);
        proxyConnections = Math.max(0, proxyConnections - 1);
        client.data.upstream.close();
      },
      maxPayloadLength: MAX_PROXY_PAYLOAD_BYTES,
      backpressureLimit: MAX_PROXY_PAYLOAD_BYTES,
      closeOnBackpressureLimit: true,
    },
  });
}

// Smithers caches auth on an established WebSocket and does not re-check token
// expiry per frame. Stop both listeners at grant expiry so launchd closes every
// cached session before attempting a fail-closed restart.
const MAX_TIMER_DELAY_MS = 2_147_000_000;
function armGatewayExpiry() {
  const remainingMs = expiresAtMs - Date.now();
  const delayMs = Math.min(Math.max(remainingMs, 0), MAX_TIMER_DELAY_MS);
  setTimeout(() => {
    if (Date.now() < expiresAtMs) {
      armGatewayExpiry();
      return;
    }
    console.error("Smithers Gateway token expired; closing authenticated sessions");
    process.exitCode = 1;
    const forceExit = setTimeout(() => process.exit(1), 5_000);
    forceExit.unref();
    void closeGatewayServers().catch((error) => {
      console.error(`Failed to close expired Gateway: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, delayMs);
}

/**
 * `ui` is set only for workflows whose UI cannot be found by convention.
 * Gateway looks for `<entryFile>/../../ui/<key>.tsx`, which resolves inside
 * `.smithers/` for the pack workflows but outside it for the deck pipelines.
 */
type WorkflowMount = { key: string; title: string; entryFile: string; ui?: string };

const packWorkflow = (key: string, title: string): WorkflowMount => ({
  key,
  title,
  entryFile: resolve(here, "workflows", `${key}.tsx`),
});

const deckWorkflow = (key: string, title: string, entry: string): WorkflowMount => ({
  key,
  title,
  entryFile: resolve(workflowsRoot, entry),
  ui: resolve(here, "ui", `${key}.tsx`),
});

const mounts: WorkflowMount[] = [
  packWorkflow("create-workflow", "Create Workflow"),
  packWorkflow("create-skill", "Create Skill"),
  packWorkflow("docs-driven-development", "Docs Driven Development"),
  packWorkflow("share-pack", "Share Pack"),
  deckWorkflow("pr-pipeline", "PR Pipeline approvals", "pr-pipeline/pipeline.tsx"),
  deckWorkflow("stack-owner", "Stack Owner approvals", "stack-owner-workflow/pipeline.tsx"),
];

// Mount each workflow independently: one that fails to import (a broken prompt,
// a bad export) disables only itself, and the rest of the gateway still serves.
async function mountWorkflow({ key, title, entryFile, ui }: WorkflowMount) {
  try {
    const mod = await import(pathToFileURL(entryFile).href);
    gateway.register(key, mod.default, {
      entryFile,
      ...(ui ? { ui: { entry: ui, path: `/workflows/${key}`, title } } : {}),
    });
    const mounted = gateway.getUiMounts().some((mount) => mount.workflowKey === key);
    console.log(mounted ? `  ${title} UI -> http://${host}:${port}/workflows/${key}` : `  ${title} (no UI)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[gateway] skipped ${key}: ${message}`);
  }
}

console.log(`Workspace: ${workspaceRoot}`);
console.log("Workflow UIs:");
for (const mount of mounts) await mountWorkflow(mount);

const internalServer = await gateway.listen({ host: internalHost, port: 0 });
const internalAddress = internalServer.address();
if (!internalAddress || typeof internalAddress === "string") {
  await gateway.close();
  throw new Error("Smithers Gateway could not allocate its internal listener");
}

try {
  const externalServer = createAuthenticatedProxy(internalAddress.port);
  publicServer = externalServer;
  armGatewayExpiry();
  const portFile = process.env.SMITHERS_GATEWAY_PORT_FILE?.trim();
  if (portFile) await writeFile(resolve(portFile), `${externalServer.port}\n`, { mode: 0o600 });
  console.log(`Smithers Gateway listening on http://${host}:${externalServer.port}`);
} catch (error) {
  await closeGatewayServers();
  throw error;
}
