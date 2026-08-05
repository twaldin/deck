import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";


const testRoot = mkdtempSync(join(tmpdir(), "deck-gateway-auth-"));
let cleanup = async () => {
  await rm(testRoot, { recursive: true, force: true });
};
let handlingSignal = false;
const handleSignal = (exitCode: number) => {
  if (handlingSignal) return;
  handlingSignal = true;
  void cleanup().finally(() => process.exit(exitCode));
};
const onSigint = () => handleSignal(130);
const onSigterm = () => handleSignal(143);
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

let workspaceRoot: string;
let tokenStore: string;
let token: string;
let port = 0;
let baseUrl = "";
let gateway: Bun.ReadableSubprocess;
let stdoutText: Promise<string>;
let stderrText: Promise<string>;

function assertGatewayStartupRejected(
  label: string,
  env: NodeJS.ProcessEnv,
  expectedMessage: string,
): void {
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(here, "gateway.ts")],
    cwd: here,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  if (result.exitCode === 0 || !output.includes(expectedMessage)) {
    throw new Error(`${label}: expected startup rejection containing ${JSON.stringify(expectedMessage)}`);
  }
}

function issueTestToken(storePath: string, ttl: string, actionId: string): string {
  const result = Bun.spawnSync({
    cmd: [
      join(here, "node_modules", ".bin", "smithers"),
      "token",
      "issue",
      "--scopes",
      "*",
      "--role",
      "operator",
      "--ttl",
      ttl,
      "--action-id",
      actionId,
      "--reveal-token",
      "--format",
      "json",
    ],
    cwd: here,
    env: { ...process.env, SMITHERS_TOKEN_STORE: storePath },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not issue test token: ${new TextDecoder().decode(result.stderr)}`);
  }
  const issued = JSON.parse(new TextDecoder().decode(result.stdout)) as { token?: unknown };
  if (typeof issued.token !== "string" || !issued.token) {
    throw new Error("smithers token issue did not return a bearer");
  }
  return issued.token;
}

function revokeTestToken(storePath: string, revokedToken: string): void {
  const result = Bun.spawnSync({
    cmd: [
      join(here, "node_modules", ".bin", "smithers"),
      "token",
      "revoke",
      revokedToken,
      "--format",
      "json",
    ],
    cwd: here,
    env: { ...process.env, SMITHERS_TOKEN_STORE: storePath },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not revoke test token: ${new TextDecoder().decode(result.stderr)}`);
  }
}

try {
  const requestedWorkspace = process.env.SMITHERS_AUTH_TEST_WORKSPACE_ROOT;
  workspaceRoot = requestedWorkspace ? resolve(requestedWorkspace) : join(testRoot, "workspace");
  if (!requestedWorkspace) await mkdir(workspaceRoot);
  tokenStore = join(testRoot, "tokens.json");

  token = issueTestToken(tokenStore, "30s", "gateway-auth-test");

  const startupEnv = {
    ...process.env,
    HOST: host,
    PORT: "1",
    SMITHERS_WORKSPACE_ROOT: workspaceRoot,
    SMITHERS_TOKEN_STORE: tokenStore,
  };
  const missingTokenEnv = { ...startupEnv };
  delete missingTokenEnv.SMITHERS_GATEWAY_TOKEN;
  assertGatewayStartupRejected("missing-token startup", missingTokenEnv, "SMITHERS_GATEWAY_TOKEN is required");
  assertGatewayStartupRejected(
    "unissued-token startup",
    { ...startupEnv, SMITHERS_GATEWAY_TOKEN: "smithers_unissued_auth_test_token" },
    "must be issued by `smithers token issue`",
  );
  const revokedToken = issueTestToken(tokenStore, "5m", "gateway-auth-test-revoked");
  revokeTestToken(tokenStore, revokedToken);
  assertGatewayStartupRejected(
    "revoked-token startup",
    { ...startupEnv, SMITHERS_GATEWAY_TOKEN: revokedToken },
    "SMITHERS_GATEWAY_TOKEN has been revoked",
  );

  const portFile = join(testRoot, "gateway.port");
  gateway = Bun.spawn({
    cmd: [process.execPath, join(here, "gateway.ts")],
    cwd: here,
    env: {
      ...process.env,
      HOST: host,
      PORT: "0",
      SMITHERS_GATEWAY_TOKEN: token,
      SMITHERS_WORKSPACE_ROOT: workspaceRoot,
      SMITHERS_TOKEN_STORE: tokenStore,
      SMITHERS_GATEWAY_PORT_FILE: portFile,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup = async () => {
    if (gateway.exitCode === null) {
      gateway.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (gateway.exitCode === null) gateway.kill("SIGKILL");
      }, 5_000);
      await gateway.exited;
      clearTimeout(forceKill);
    }
    await rm(testRoot, { recursive: true, force: true });
  };
  stdoutText = new Response(gateway.stdout).text();
  stderrText = new Response(gateway.stderr).text();
  const portDeadline = Date.now() + 30_000;
  while (!baseUrl && Date.now() < portDeadline) {
    if (gateway.exitCode !== null) {
      throw new Error(`Gateway exited before publishing its ephemeral port with code ${gateway.exitCode}`);
    }
    try {
      const publishedPort = Number((await readFile(portFile, "utf8")).trim());
      if (Number.isInteger(publishedPort) && publishedPort > 0) {
        port = publishedPort;
        baseUrl = `http://${host}:${port}`;
        break;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await sleep(50);
  }
  if (!baseUrl) throw new Error("Gateway did not publish an ephemeral port within 30 seconds");
} catch (error) {
  await cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  throw error;
}
function assertRejected(response: Response, label: string): void {
  if (response.status !== 401 && response.status !== 403) {
    throw new Error(`${label}: expected 401/403, got ${response.status}`);
  }
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) {
      throw new Error(`Gateway exited before readiness with code ${gateway.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return;
    } catch {
      // The listener is not ready yet.
    }
    await sleep(100);
  }
  throw new Error("Gateway did not become ready within 15 seconds");
}

type WsResponse = {
  ok?: boolean;
  error?: { code?: string; message?: string };
};

type WsResult = {
  response: WsResponse;
  unexpectedEvents: unknown[];
  closed: Promise<void>;
  elapsedMs: number;
  request(method: string, params: Record<string, unknown>): Promise<WsResponse>;
};

async function requestWebSocket(
  method: "connect" | "listRuns" | "launchRun",
  authToken?: string,
  expectServerClose = false,
  keepOpen = false,
  expectChallenge = true,
): Promise<WsResult> {
  return await new Promise<WsResult>((resolveRequest, rejectRequest) => {
    const socket = new WebSocket(`ws://${host}:${port}/`);
    const id = `${method}-${crypto.randomUUID()}`;
    const pendingRequests = new Map<
      string,
      {
        resolve: (result: WsResponse) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >();
    const request = (requestMethod: string, params: Record<string, unknown>): Promise<WsResponse> =>
      new Promise<WsResponse>((resolveResponse, rejectResponse) => {
        if (socket.readyState !== WebSocket.OPEN) {
          rejectResponse(new Error(`WebSocket is not open for ${requestMethod}`));
          return;
        }
        const requestId = `${requestMethod}-${crypto.randomUUID()}`;
        const requestTimeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          rejectResponse(new Error(`Timed out waiting for ${requestMethod}`));
        }, 5_000);
        pendingRequests.set(requestId, {
          resolve: resolveResponse,
          reject: rejectResponse,
          timeout: requestTimeout,
        });
        socket.send(JSON.stringify({ type: "req", id: requestId, method: requestMethod, params }));
      });
    const startedAtMs = Date.now();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const unexpectedEvents: unknown[] = [];
    let challengeCount = 0;
    let response: WsResponse | undefined;
    let settled = false;
    const timeout = setTimeout(
      () => fail(new Error("Timed out waiting for the WebSocket authentication result")),
      expectServerClose ? 12_000 : 5_000,
    );

    const finish = () => {
      if (settled || !response) return;
      settled = true;
      clearTimeout(timeout);
      if ((expectChallenge && challengeCount !== 1) || (!expectChallenge && challengeCount !== 0)) {
        unexpectedEvents.push({ invalidChallengeCount: challengeCount });
      }
      resolveRequest({
        response,
        unexpectedEvents,
        closed,
        elapsedMs: Date.now() - startedAtMs,
        request,
      });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      rejectRequest(error);
    };

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "req",
          id,
          method,
          params:
            method === "connect"
              ? {
                  minProtocol: 1,
                  maxProtocol: 1,
                  client: { id: "deck-auth-test", version: "1.0.0", platform: "bun" },
                  ...(authToken ? { auth: { token: authToken } } : {}),
                }
              : {},
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        fail(new Error("Gateway returned a non-text WebSocket frame"));
        return;
      }
      let frame: {
        type?: string;
        id?: string;
        event?: string;
        payload?: unknown;
        ok?: boolean;
        error?: { code?: string; message?: string };
      };
      try {
        frame = JSON.parse(event.data);
      } catch {
        fail(new Error("Gateway returned invalid WebSocket JSON"));
        return;
      }
      if (frame.type === "res" && frame.id) {
        const pending = pendingRequests.get(frame.id);
        if (pending) {
          pendingRequests.delete(frame.id);
          clearTimeout(pending.timeout);
          pending.resolve(frame);
          return;
        }
      }
      if (frame.type === "event") {
        if (frame.event === "connect.challenge") {
          challengeCount += 1;
          const payload =
            frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
              ? (frame.payload as Record<string, unknown>)
              : null;
          const safeChallenge =
            payload !== null &&
            typeof payload.nonce === "string" &&
            typeof payload.ts === "number" &&
            Object.keys(payload).every((key) => key === "nonce" || key === "ts");
          if (!safeChallenge) unexpectedEvents.push(frame);
        } else {
          unexpectedEvents.push(frame);
        }
      }
      if (frame.type !== "res" || frame.id !== id) return;
      response = frame;
      if (expectServerClose) return;
      finish();
      if (!keepOpen) socket.close();
    });
    socket.addEventListener("error", () => {
      if (!expectServerClose || !response) {
        fail(new Error("WebSocket failed before the authentication result"));
      }
    });
    socket.addEventListener("close", () => {
      for (const [requestId, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`WebSocket closed before ${requestId} completed`));
      }
      pendingRequests.clear();
      resolveClosed();
      if (expectServerClose && response) {
        finish();
      } else if (!settled) {
        fail(new Error("WebSocket closed before the authentication result"));
      }
    });
  });
}

async function assertIdleSocketTimesOut(): Promise<void> {
  await new Promise<void>((resolveTimeout, rejectTimeout) => {
    const socket = new WebSocket(`ws://${host}:${port}/`);
    const timeout = setTimeout(() => {
      socket.close();
      rejectTimeout(new Error("Idle pre-auth WebSocket did not time out"));
    }, 7_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      if (event.code !== 1008) {
        rejectTimeout(new Error(`Idle pre-auth WebSocket closed with ${event.code}, not 1008`));
        return;
      }
      resolveTimeout();
    });
    socket.addEventListener("error", () => {
      // The policy close is the assertion; Bun may also surface it as an error.
    });
  });
}

let failure: unknown;
try {
  await waitUntilReady();
  await assertIdleSocketTimesOut();
  const publicHealth = await fetch(`${baseUrl}/health`);
  const publicHealthPayload = (await publicHealth.json()) as Record<string, unknown>;
  const allowedHealthKeys = [
    "ok",
    "protocol",
    "features",
    "stateVersion",
    "identity",
    "workflowsLoaded",
    "workflowsTotal",
  ];
  const leakedHealthKeys = Object.keys(publicHealthPayload).filter(
    (key) => !allowedHealthKeys.includes(key),
  );
  if (publicHealth.status !== 200 || leakedHealthKeys.length > 0) {
    throw new Error(
      `public /health leaked unexpected fields: ${JSON.stringify(leakedHealthKeys)}`,
    );
  }

  const anonymousRoot = await fetch(`${baseUrl}/`, { redirect: "manual" });
  assertRejected(anonymousRoot, "unauthenticated GET /");

  for (const [path, response] of await Promise.all(
    ["/metrics", "/workflows", "/v1/api/runs"].map(async (path) => [
      path,
      await fetch(`${baseUrl}${path}`),
    ] as const),
  )) {
    assertRejected(response, `unauthenticated GET ${path}`);
  }

  const rpcRequest = JSON.stringify({ method: "listRuns", params: {} });
  const anonymousRpc = await fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rpcRequest,
  });
  assertRejected(anonymousRpc, "unauthenticated POST /rpc");

  const wrongTokenRpc = await fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: {
      authorization: "Bearer smithers_wrong_token",
      "content-type": "application/json",
    },
    body: rpcRequest,
  });
  assertRejected(wrongTokenRpc, "wrong-token POST /rpc");

  const [anonymousWs, wrongTokenWs] = await Promise.all([
    requestWebSocket("connect", undefined, true),
    requestWebSocket("connect", "smithers_wrong_token", true),
  ]);
  for (const [label, result] of [
    ["unauthenticated", anonymousWs],
    ["wrong-token", wrongTokenWs],
  ] as const) {
    if (result.response.ok !== false || result.response.error?.code !== "UNAUTHORIZED") {
      throw new Error(
        `${label} WebSocket connect: expected UNAUTHORIZED, got ${JSON.stringify(result.response)}`,
      );
    }
    if (result.unexpectedEvents.length > 0) {
      throw new Error(
        `${label} WebSocket leaked pre-auth application data: ${JSON.stringify(result.unexpectedEvents)}`,
      );
    }
    if (result.elapsedMs >= 5_000) {
      throw new Error(`${label} WebSocket was not rejected immediately (${result.elapsedMs}ms)`);
    }
  }

  for (const [label, result] of [
    ["pre-connect read", await requestWebSocket("listRuns", undefined, false, false, false)],
    ["pre-connect mutation", await requestWebSocket("launchRun", undefined, false, false, false)],
  ] as const) {
    if (result.response.ok !== false || result.response.error?.code !== "UNAUTHORIZED") {
      throw new Error(`${label}: expected UNAUTHORIZED, got ${JSON.stringify(result.response)}`);
    }
    if (result.unexpectedEvents.length > 0) {
      throw new Error(`${label} leaked application data: ${JSON.stringify(result.unexpectedEvents)}`);
    }
  }

  const authenticatedHeaders = { authorization: `Bearer ${token}` };
  const [authenticatedRoot, authenticatedMetrics, authenticatedWorkflows, authenticatedApi] =
    await Promise.all([
      fetch(`${baseUrl}/`, { headers: authenticatedHeaders }),
      fetch(`${baseUrl}/metrics`, { headers: authenticatedHeaders }),
      fetch(`${baseUrl}/workflows`, { headers: authenticatedHeaders }),
      fetch(`${baseUrl}/v1/api/runs`, { headers: authenticatedHeaders }),
    ]);
  for (const [path, response] of [
    ["/", authenticatedRoot],
    ["/metrics", authenticatedMetrics],
    ["/workflows", authenticatedWorkflows],
    ["/v1/api/runs", authenticatedApi],
  ] as const) {
    if (response.status !== 200) {
      throw new Error(`authenticated GET ${path}: expected 200, got ${response.status}`);
    }
  }
  if (!authenticatedRoot.headers.get("content-type")?.startsWith("text/html")) {
    throw new Error("authenticated GET / did not return the Gateway UI");
  }
  const authenticatedRpc = await fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: rpcRequest,
  });
  if (authenticatedRpc.status !== 200) {
    throw new Error(`authenticated POST /rpc: expected 200, got ${authenticatedRpc.status}`);
  }
  const authenticatedPayload = (await authenticatedRpc.json()) as { ok?: boolean; error?: unknown };
  if (authenticatedPayload.ok !== true) {
    throw new Error(`authenticated POST /rpc failed: ${JSON.stringify(authenticatedPayload)}`);
  }

  const authenticatedWs = await requestWebSocket("connect", token, false, true);
  if (authenticatedWs.response.ok !== true) {
    throw new Error(`authenticated WebSocket connect failed: ${JSON.stringify(authenticatedWs.response)}`);
  }
  const authenticatedRuns = await authenticatedWs.request("listRuns", {});
  if (authenticatedRuns.ok !== true) {
    throw new Error(`authenticated WebSocket listRuns failed: ${JSON.stringify(authenticatedRuns)}`);
  }
  const authenticatedCancel = await authenticatedWs.request("cancelRun", {
    runId: `gateway-auth-missing-${crypto.randomUUID()}`,
  });
  if (
    authenticatedCancel.error?.code === "UNAUTHORIZED" ||
    authenticatedCancel.error?.code === "FORBIDDEN"
  ) {
    throw new Error(
      `authenticated WebSocket mutation did not pass the proxy gate: ${JSON.stringify(authenticatedCancel)}`,
    );
  }

  let expiryTimedOut = false;
  const expiryTimeout = setTimeout(() => {
    expiryTimedOut = true;
    if (gateway.exitCode === null) gateway.kill("SIGTERM");
  }, 32_000);
  await gateway.exited;
  clearTimeout(expiryTimeout);
  if (expiryTimedOut || gateway.exitCode !== 1) {
    throw new Error(
      `Gateway did not stop cleanly at token expiry (timedOut=${expiryTimedOut}, exitCode=${gateway.exitCode})`,
    );
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    const timeout = setTimeout(
      () => rejectClose(new Error("Authenticated WebSocket remained open after grant expiry")),
      1_000,
    );
    void authenticatedWs.closed.then(() => {
      clearTimeout(timeout);
      resolveClose();
    });
  });

  console.log(`gateway auth negative test passed on ephemeral port ${port}`);
  console.log("  GET /, /metrics, /workflows, /v1/api/runs without bearer: rejected");
  console.log("  POST /rpc without bearer: rejected");
  console.log("  POST /rpc with wrong bearer: rejected");
  console.log("  idle and pre-connect WebSockets: policy-closed; reads/mutations and bad bearers: UNAUTHORIZED");
  console.log("  authenticated UI, metadata, HTTP RPC/API, WS read, and controlled WS mutation: forwarded");
  console.log("  issued grant expiry: Gateway stopped and closed authenticated sessions");
} catch (error) {
  failure = error;
} finally {
  await cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);
if (failure) {
  console.error("--- gateway stdout ---\n" + stdout);
  console.error("--- gateway stderr ---\n" + stderr);
  throw failure;
}
