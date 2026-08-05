/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { ApprovalWorkflowApp } from "./approval-workflow";

createGatewayReactRoot(
  <ApprovalWorkflowApp
    workflow="pr-pipeline"
    title="PR Pipeline approvals"
    approvalDescription="Each card carries the PR evidence for one gate: PR number and URL, CI state, review state and mergeability. Approving submits the Gateway decision. The workflow then re-checks the PR head and its own merge node submits the PR to the GitHub merge queue. Denying stops the run."
  />,
);
