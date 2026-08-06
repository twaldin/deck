/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { ApprovalWorkflowApp } from "./approval-workflow";

createGatewayReactRoot(
  <ApprovalWorkflowApp
    workflow="pr-pipeline"
    title="PR Pipeline approvals"
    approvalDescription="Each card carries the evidence for one effort: a PR or a parent-to-child stack, with commit-bound head SHAs, CI, review state, and mergeability. One approval stamps the whole effort. The workflow re-checks every stamped head and submits stack cars to the GitHub merge queue parent first. Denying stops the run."
  />,
);
