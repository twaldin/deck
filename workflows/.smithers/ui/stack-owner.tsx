/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { ApprovalWorkflowApp } from "./approval-workflow";

createGatewayReactRoot(
  <ApprovalWorkflowApp
    workflow="stack-owner"
    title="Stack Owner approvals"
    approvalDescription="One card covers the whole ordered stack: every PR number and URL with its CI state and mergeability. Approving submits the Gateway decision. The workflow then re-polls the stack and its own merge node submits each PR in order. Denying stops the run."
  />,
);
