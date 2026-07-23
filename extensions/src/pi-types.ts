import type { TSchema } from "typebox";

export interface ToolTextContent {
	type: "text";
	text: string;
}

export interface ToolResult {
	content: ToolTextContent[];
	details: Record<string, unknown>;
	terminate?: boolean;
}

export interface DeckTool {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	parameters: TSchema;
	prepareArguments?(params: unknown): unknown;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		context: unknown,
	): Promise<ToolResult>;
}

export type DeckHook = "session_start" | "message_start" | "turn_end";
export type DeckHookHandler = (event: unknown, context: unknown) => Promise<void> | void;

export interface DeckExtensionApi {
	registerTool(tool: DeckTool): void;
	on(event: DeckHook, handler: DeckHookHandler): void;
	sendMessage(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: Record<string, unknown>;
		},
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
}
