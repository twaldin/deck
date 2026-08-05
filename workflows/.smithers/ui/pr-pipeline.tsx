/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { ApprovalWorkflowApp } from "./approval-workflow";

createGatewayReactRoot(<ApprovalWorkflowApp workflow="pr-pipeline" title="PR Pipeline approvals" approvalDescription="Review the PR evidence, then approve the durable stamp + merge-word gate. Approval advances the workflow to its own head re-check and merge compute node." />);
