/** @jsxImportSource react */
import { useState } from "react";
import { useGatewayApprovals } from "smithers-orchestrator/gateway-react";
import {
  ApprovalPanel,
  ConnectionBadge,
  MonitorButton,
  NodeChatStream,
  NodeOutputView,
  RunEventLog,
  RunList,
  RunTree,
  StatusPill,
  WorkflowUiShell,
} from "smithers-orchestrator/gateway-ui";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, KpiStat, SmithersUiStyles } from "smithers-orchestrator/ui";

type ApprovalRow = { runId: string; nodeId: string; iteration: number; workflowKey?: string; requestTitle?: string; requestSummary?: string };

export type ApprovalWorkflowAppProps = {
  workflow: "pr-pipeline" | "stack-owner";
  title: string;
  approvalDescription: string;
};

function ApprovalEvidence({ workflow }: { workflow: ApprovalWorkflowAppProps["workflow"] }) {
  const approvals = useGatewayApprovals({ filter: { workflow, limit: 50 } });
  const rows = (approvals.data ?? []) as ApprovalRow[];
  return (
    <Card>
      <CardHeader><CardTitle>Pending approval evidence</CardTitle><KpiStat label="Waiting" value={String(rows.length)} hint="Each card is a live Gateway approval." /></CardHeader>
      <CardContent>
        {rows.length === 0 ? <EmptyState title="No pending approvals" description="The workflow is not waiting for a captain decision." /> : rows.map((row) => (
          <article key={`${row.runId}:${row.nodeId}:${row.iteration}`}>
            <div><strong>{row.requestTitle ?? row.nodeId}</strong> <Badge variant="outline">{row.workflowKey ?? workflow}</Badge></div>
            <p>{row.requestSummary ?? "The workflow will continue after approval."}</p>
            <small>Run {row.runId} · node {row.nodeId} · iteration {row.iteration}</small>
          </article>
        ))}
      </CardContent>
    </Card>
  );
}

export function ApprovalWorkflowApp({ workflow, title, approvalDescription }: ApprovalWorkflowAppProps) {
  const [runId, setRunId] = useState<string | undefined>(() => typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("runId") ?? undefined);
  const [nodeId, setNodeId] = useState<string | undefined>();
  return (
    <WorkflowUiShell title={title} meta={<ConnectionBadge />} actions={<MonitorButton runId={runId} />} testId={`${workflow}-approval-ui`}>
      <SmithersUiStyles />
      <Card><CardHeader><CardTitle>Captain control</CardTitle><StatusPill status={runId ? "running" : "queued"} label={runId ? "Run selected" : "Select a run"} /></CardHeader><CardContent><p>{approvalDescription}</p></CardContent></Card>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 0.8fr) minmax(320px, 1.4fr)", gap: 16 }}>
        <Card><CardHeader><CardTitle>Runs</CardTitle></CardHeader><CardContent><RunList filter={{ workflow, limit: 50 }} activeRunId={runId} onSelect={setRunId} /></CardContent></Card>
        <Card><CardHeader><CardTitle>Run tree</CardTitle></CardHeader><CardContent>{runId ? <RunTree runId={runId} activeNodeId={nodeId} onSelectNode={(node) => setNodeId(node.id)} /> : <EmptyState title="Select a run" description="The live node tree appears here." />}</CardContent></Card>
      </div>
      <ApprovalEvidence workflow={workflow} />
      <Card><CardHeader><CardTitle>Approve or deny</CardTitle></CardHeader><CardContent><p>Approve submits the Gateway submitApproval RPC. The workflow then re-checks its head and performs its own merge path. No browser action runs gh pr merge directly.</p><ApprovalPanel filter={{ workflow, limit: 50 }} /></CardContent></Card>
      {runId ? <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}><Card><CardHeader><CardTitle>Live events</CardTitle></CardHeader><CardContent><RunEventLog runId={runId} maxEvents={200} selectedNodeId={nodeId} onSelectNode={setNodeId} /></CardContent></Card><Card><CardHeader><CardTitle>Selected node</CardTitle></CardHeader><CardContent><NodeOutputView runId={runId} nodeId={nodeId} /><NodeChatStream runId={runId} nodeId={nodeId} /></CardContent></Card></div> : null}
    </WorkflowUiShell>
  );
}
