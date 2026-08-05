/** @jsxImportSource react */
import { useState } from "react";
import {
  ApprovalPanel,
  ConnectionBadge,
  MonitorButton,
  NodeChatStream,
  NodeOutputView,
  RunEventLog,
  RunList,
  RunTree,
  WorkflowUiShell,
} from "smithers-orchestrator/gateway-ui";
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from "smithers-orchestrator/ui";

export type ApprovalWorkflowAppProps = {
  /** Gateway workflow key; also the run/approval filter. */
  workflow: string;
  title: string;
  /** What approving this workflow's gate causes the workflow to do. */
  approvalDescription: string;
};

function initialRunId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("runId") ?? undefined;
}

/**
 * The captain's approve/merge surface for one workflow.
 *
 * Every merge decision goes through `ApprovalPanel`, which submits the Gateway
 * `submitApproval` RPC. The browser never merges: approving releases the
 * workflow's own gate, and the workflow re-checks the PR head and runs its
 * merge node itself.
 */
export function ApprovalWorkflowApp({ workflow, title, approvalDescription }: ApprovalWorkflowAppProps) {
  const [runId, setRunId] = useState<string | undefined>(initialRunId);
  const [nodeId, setNodeId] = useState<string | undefined>();
  const filter = { workflow, limit: 50 };

  return (
    <WorkflowUiShell
      title={title}
      meta={<ConnectionBadge />}
      actions={<MonitorButton runId={runId} />}
      testId={`${workflow}-approval-ui`}
    >
      <Card>
        <CardHeader>
          <CardTitle>Approve or deny</CardTitle>
        </CardHeader>
        <CardContent>
          <p>{approvalDescription}</p>
          <ApprovalPanel filter={filter} />
        </CardContent>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 0.8fr) minmax(320px, 1.4fr)", gap: 16 }}>
        <Card>
          <CardHeader>
            <CardTitle>Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <RunList filter={filter} activeRunId={runId} onSelect={setRunId} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Run tree</CardTitle>
          </CardHeader>
          <CardContent>
            {runId ? (
              <RunTree runId={runId} activeNodeId={nodeId} onSelectNode={(node) => setNodeId(node.id)} />
            ) : (
              <EmptyState title="Select a run" description="The live node tree appears here." />
            )}
          </CardContent>
        </Card>
      </div>

      {runId ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Card>
            <CardHeader>
              <CardTitle>Live events</CardTitle>
            </CardHeader>
            <CardContent>
              <RunEventLog runId={runId} maxEvents={200} selectedNodeId={nodeId} onSelectNode={setNodeId} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Selected node</CardTitle>
            </CardHeader>
            <CardContent>
              <NodeOutputView runId={runId} nodeId={nodeId} />
              <NodeChatStream runId={runId} nodeId={nodeId} />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </WorkflowUiShell>
  );
}
