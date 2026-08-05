import { Gateway, mdxPlugin } from "smithers-orchestrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, "..");
const workspaceRoot = resolve(process.env.SMITHERS_WORKSPACE_ROOT ?? process.cwd());
// Workflow modules use the nearest .smithers directory to select their DB. The
// gateway imports source files, but must build their Smithers APIs against the
// live workspace, not the source checkout.
process.chdir(workspaceRoot);

const parsedPort = Number(process.env.PORT ?? "7331");
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 7331;
const host = process.env.HOST ?? "127.0.0.1";
const gateway = new Gateway({ heartbeatMs: 15_000, workspaceRoot });

type WorkflowMount = { key: string; title: string; entryFile: string };
const mounts: WorkflowMount[] = [
  { key: "create-workflow", title: "Create Workflow", entryFile: resolve(here, "workflows/create-workflow.tsx") },
  { key: "create-skill", title: "Create Skill", entryFile: resolve(here, "workflows/create-skill.tsx") },
  { key: "docs-driven-development", title: "Docs Driven Development", entryFile: resolve(here, "workflows/docs-driven-development.tsx") },
  { key: "share-pack", title: "Share Pack", entryFile: resolve(here, "workflows/share-pack.tsx") },
  { key: "pr-pipeline", title: "PR Pipeline", entryFile: resolve(sourceRoot, "pr-pipeline/pipeline.tsx") },
  { key: "stack-owner", title: "Stack Owner", entryFile: resolve(sourceRoot, "stack-owner-workflow/pipeline.tsx") },
];

async function mountWorkflow({ key, title, entryFile }: WorkflowMount) {
  try {
    const mod = await import(pathToFileURL(entryFile).href);
    const uiEntry = resolve(here, "ui", `${key}.tsx`);
    gateway.register(key, mod.default, {
      entryFile,
      ...(key === "pr-pipeline" || key === "stack-owner"
        ? { ui: { entry: uiEntry, path: `/workflows/${key}`, title } }
        : {}),
    });
    const mounted = (gateway as any).workflows?.get?.(key)?.ui ?? gateway.resolvedUiFor?.(key, (gateway as any).workflows?.get?.(key));
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
