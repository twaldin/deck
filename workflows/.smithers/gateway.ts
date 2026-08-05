import { Gateway, mdxPlugin } from "smithers-orchestrator";
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

const parsedPort = Number(process.env.PORT ?? "7331");
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 7331;
const host = process.env.HOST ?? "127.0.0.1";
const gateway = new Gateway({ heartbeatMs: 15_000, workspaceRoot });

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

await gateway.listen({ host, port });
console.log(`Smithers Gateway listening on http://${host}:${port}`);
