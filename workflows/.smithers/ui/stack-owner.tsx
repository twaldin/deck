/** @jsxImportSource react */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { ApprovalWorkflowApp } from "./approval-workflow";

createGatewayReactRoot(<ApprovalWorkflowApp workflow="stack-owner" title="Stack Owner approvals" approvalDescription="Review the complete ordered PR stack before approving its durable merge decision. Approval is sent to the Gateway and keeps merge authority inside the workflow." />);
