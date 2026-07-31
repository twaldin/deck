/**
 * Calm: a presentation-only transcript toggle, ported from fm2.
 *
 * While active it hides collapsed thinking, every tool row's shell (pi's
 * built-ins, deck's orchestrator tools, and tools other extensions register,
 * such as @aliou/pi-processes' process tool), and deck operational user rows
 * (the `[deck] ` wake/stale injections from extension/index.ts). Pi's `Working...` row stays visible. Nothing here
 * touches delivery, ordering, session storage, or model context: hidden rows
 * remain ordinary messages that the model and /export both still see.
 *
 * The last /calm choice persists at DECK_V2_HOME/config/calm across sessions.
 *
 * Verified against pi 0.82.0, which exposes built-in ToolDefinitions,
 * renderShell: "self", AssistantMessageComponent.updateContent and
 * InteractiveMode.addMessageToChat. Each presentation adapter probes the exact
 * API it patches and degrades independently with a diagnostic if a future pi
 * removes it; a newer version is never rejected on its number alone.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolRenderResultOptions,
	UserMessageComponent as PiUserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, getKeybindings, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { deckV2Home } from "./home";

/**
 * Every operational injection the extension sends carries this prefix, so it is
 * both the producer's marker (extension/index.ts) and Calm's classifier. An
 * ordinary captain prompt that happens to start with it would be hidden too;
 * that is the accepted cost of a marker the captain can also read.
 */
export const DECK_OPERATIONAL_PREFIX = "[deck] ";

// ---- visibility state ------------------------------------------------------

let calm = false;
let stockExportRendering = false;

export function setCalmPresentation(active: boolean): void {
	calm = active;
}

export function calmPresentationIsActive(): boolean {
	return calm;
}

/** During /export and /share the stock renderers run so artifacts stay complete. */
export function setCalmStockExportRendering(active: boolean): void {
	stockExportRendering = active;
}

export function calmPresentationHides(): boolean {
	return calm && !stockExportRendering;
}

export function isDeckOperationalText(text: string): boolean {
	return text.startsWith(DECK_OPERATIONAL_PREFIX);
}

// ---- persisted preference ---------------------------------------------------

export function calmPreferencePath(): string {
	return join(deckV2Home(), "config", "calm");
}

export function loadCalmPreference(): boolean {
	try {
		return readFileSync(calmPreferencePath(), "utf8").trim() === "on";
	} catch {
		return false;
	}
}

export function persistCalmPreference(active: boolean): void {
	const preferencePath = calmPreferencePath();
	mkdirSync(dirname(preferencePath), { recursive: true });
	const temporaryPath = `${preferencePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, active ? "on\n" : "off\n", {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporaryPath, preferencePath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

// ---- presentation adapters ---------------------------------------------------
// Each adapter probes the exact pi API it patches. If a future pi removes that
// seam, only the affected adapter degrades; /calm and the rest keep working.

function installAdapter(name: string, install: () => void): void {
	try {
		install();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(`deck calm: ${name} presentation adapter unavailable, skipping. ${reason}`);
	}
}

type AssistantMessage = Parameters<
	PiCodingAgent.AssistantMessageComponent["updateContent"]
>[0];

type AssistantMessagePresentationState = {
	hiddenThinkingLabel: string;
	hideThinkingBlock: boolean;
	lastMessage?: AssistantMessage;
};

// Introduction-version symbols stay stable so a compatible upgrade cannot
// double-patch a live process.
const CALM_ASSISTANT_LAYOUT_PATCH = Symbol.for("deck:calm-assistant-layout:pi-0.82.0");
const CALM_TOOL_SHELL_LAYOUT_PATCH = Symbol.for("deck:calm-tool-shell-layout:pi-0.82.0");
const CALM_OPERATIONAL_USER_LAYOUT_PATCH = Symbol.for(
	"deck:calm-operational-user-layout:pi-0.82.0",
);

type CalmAssistantLayoutPatch = { hidesThinking: () => boolean };

/**
 * Collapsed-thinking rows: setHiddenThinkingLabel("") blanks the label but pi
 * still reserves the row. Filtering thinking blocks out of the presentation
 * copy removes the reserved space; the real message is untouched.
 */
export function installCalmAssistantLayout(): void {
	const registry = globalThis as typeof globalThis & {
		[key: symbol]: CalmAssistantLayoutPatch | undefined;
	};
	const hidesThinking = (): boolean => calmPresentationHides();
	const installed = registry[CALM_ASSISTANT_LAYOUT_PATCH];
	if (installed) {
		installed.hidesThinking = hidesThinking;
		return;
	}

	const patch: CalmAssistantLayoutPatch = { hidesThinking };
	const AssistantMessageComponent = PiCodingAgent.AssistantMessageComponent;
	if (typeof AssistantMessageComponent !== "function") {
		throw new Error("deck calm requires pi AssistantMessageComponent");
	}
	const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
	if (typeof originalUpdateContent !== "function") {
		throw new Error("deck calm requires pi AssistantMessageComponent.updateContent");
	}

	AssistantMessageComponent.prototype.updateContent = function (
		message: AssistantMessage,
	): void {
		const state = this as unknown as AssistantMessagePresentationState;
		const hideThinking =
			state.hiddenThinkingLabel === "" && state.hideThinkingBlock && patch.hidesThinking();
		const presentationMessage = hideThinking
			? {
					...message,
					content: message.content.filter((block) => block.type !== "thinking"),
				}
			: message;

		originalUpdateContent.call(this, presentationMessage);
		if (presentationMessage !== message) state.lastMessage = message;
	};

	registry[CALM_ASSISTANT_LAYOUT_PATCH] = patch;
}

type CalmToolShellLayoutPatch = { hidesToolShells: () => boolean };

/**
 * Tool rows: every tool call in the interactive transcript renders through
 * ToolExecutionComponent, regardless of which extension registered the tool.
 * Wrapping registerTool cannot reach tools other extensions register (each
 * extension gets its own ExtensionAPI object), so this one seam is what makes
 * Calm cover deck's orchestrator tools, ask_captain, and the process tool.
 */
export function installCalmToolShellLayout(): void {
	const registry = globalThis as typeof globalThis & {
		[key: symbol]: CalmToolShellLayoutPatch | undefined;
	};
	const hidesToolShells = (): boolean => calmPresentationHides();
	const installed = registry[CALM_TOOL_SHELL_LAYOUT_PATCH];
	if (installed) {
		installed.hidesToolShells = hidesToolShells;
		return;
	}

	const patch: CalmToolShellLayoutPatch = { hidesToolShells };
	const ToolExecutionComponent = PiCodingAgent.ToolExecutionComponent;
	if (typeof ToolExecutionComponent !== "function") {
		throw new Error("deck calm requires pi ToolExecutionComponent");
	}
	const originalRender = ToolExecutionComponent.prototype.render;
	if (typeof originalRender !== "function") {
		throw new Error("deck calm requires pi ToolExecutionComponent.render");
	}

	ToolExecutionComponent.prototype.render = function (width: number): string[] {
		if (patch.hidesToolShells()) return [];
		return originalRender.call(this, width);
	};

	registry[CALM_TOOL_SHELL_LAYOUT_PATCH] = patch;
}

type UserMessageConstructorArgs = ConstructorParameters<typeof PiUserMessageComponent>;
type UserMessageLike = { role: string; content: unknown };
type AddMessageOptions = { populateHistory?: boolean };
type InteractiveModePresentation = {
	chatContainer: {
		children: unknown[];
		addChild(component: PiUserMessageComponent): void;
	};
	editor: { addToHistory?(text: string): void };
	getMarkdownThemeWithSettings(): UserMessageConstructorArgs[1];
	getUserMessageText(message: UserMessageLike): string;
	outputPad: number;
};
type InteractiveModePrototype = {
	addMessageToChat(
		this: InteractiveModePresentation,
		message: UserMessageLike,
		options?: AddMessageOptions,
	): void;
};
type CalmOperationalUserLayoutPatch = {
	hidesOperationalInput: () => boolean;
	isOperationalInput: (text: string) => boolean;
};

function contentIsTextOnly(content: unknown): boolean {
	if (typeof content === "string") return true;
	if (!Array.isArray(content) || content.length === 0) return false;
	return content.every(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string",
	);
}

/**
 * Deck operational user rows (wake/stale `[deck] ` injections): pi adds the
 * spacer and the row together in InteractiveMode.addMessageToChat, so a
 * zero-height wrapper for classified rows is the only way to hide the whole
 * block. Message delivery is untouched; only that presentation changes.
 */
export function installCalmOperationalUserLayout(): void {
	const registry = globalThis as typeof globalThis & {
		[key: symbol]: CalmOperationalUserLayoutPatch | undefined;
	};
	const hidesOperationalInput = (): boolean => calmPresentationHides();
	const installed = registry[CALM_OPERATIONAL_USER_LAYOUT_PATCH];
	if (installed) {
		installed.hidesOperationalInput = hidesOperationalInput;
		installed.isOperationalInput = isDeckOperationalText;
		return;
	}

	const patch: CalmOperationalUserLayoutPatch = {
		hidesOperationalInput,
		isOperationalInput: isDeckOperationalText,
	};
	const InteractiveMode = PiCodingAgent.InteractiveMode;
	if (typeof InteractiveMode !== "function") {
		throw new Error("deck calm requires pi InteractiveMode");
	}
	const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
	const originalAddMessageToChat = prototype.addMessageToChat;
	if (typeof originalAddMessageToChat !== "function") {
		throw new Error("deck calm requires pi InteractiveMode.addMessageToChat");
	}
	const UserMessageComponent = PiCodingAgent.UserMessageComponent;
	if (typeof UserMessageComponent !== "function") {
		throw new Error("deck calm requires pi UserMessageComponent");
	}

	class CalmOperationalUserMessageComponent extends UserMessageComponent {
		private readonly hasLeadingSpacer: boolean;

		constructor(
			text: UserMessageConstructorArgs[0],
			markdownTheme: UserMessageConstructorArgs[1],
			outputPad: number,
			hasLeadingSpacer: boolean,
		) {
			super(text, markdownTheme, outputPad);
			this.hasLeadingSpacer = hasLeadingSpacer;
		}

		override render(width: number): string[] {
			if (patch.hidesOperationalInput()) return [];
			const lines = super.render(width);
			return this.hasLeadingSpacer ? ["", ...lines] : lines;
		}
	}

	prototype.addMessageToChat = function (
		message: UserMessageLike,
		options?: AddMessageOptions,
	): void {
		if (message.role !== "user" || !contentIsTextOnly(message.content)) {
			originalAddMessageToChat.call(this, message, options);
			return;
		}
		const text = this.getUserMessageText(message);
		if (!text || !patch.isOperationalInput(text)) {
			originalAddMessageToChat.call(this, message, options);
			return;
		}
		const component = new CalmOperationalUserMessageComponent(
			text,
			this.getMarkdownThemeWithSettings(),
			this.outputPad,
			this.chatContainer.children.length > 0,
		);
		this.chatContainer.addChild(component);
		if (options?.populateHistory) this.editor.addToHistory?.(text);
	};

	registry[CALM_OPERATIONAL_USER_LAYOUT_PATCH] = patch;
}

// ---- built-in tool wrapping ---------------------------------------------------

type DefinitionFactory<TParams extends TSchema, TDetails, TState> = (
	cwd: string,
) => ToolDefinition<TParams, TDetails, TState>;

type RenderContext<TParams extends TSchema, TDetails, TState> = Parameters<
	NonNullable<ToolDefinition<TParams, TDetails, TState>["renderCall"]>
>[2];
type RenderArgs<TParams extends TSchema, TDetails, TState> = Parameters<
	NonNullable<ToolDefinition<TParams, TDetails, TState>["renderCall"]>
>[0];
type RenderTheme<TParams extends TSchema, TDetails, TState> = Parameters<
	NonNullable<ToolDefinition<TParams, TDetails, TState>["renderCall"]>
>[1];
type RenderResult<TParams extends TSchema, TDetails, TState> = Parameters<
	NonNullable<ToolDefinition<TParams, TDetails, TState>["renderResult"]>
>[0];

type StandardShellState = {
	shell?: Box;
	call?: Component;
	result?: Component;
};

/**
 * Register Calm: wraps pi's seven built-in tools with renderShell: "self" so
 * an active Calm can remove their complete shells, registers /calm, and
 * restores the persisted choice on every session start.
 */
export function registerCalm(pi: ExtensionAPI): void {
	installAdapter("collapsed-thinking", installCalmAssistantLayout);
	installAdapter("operational-user-row", installCalmOperationalUserLayout);
	installAdapter("tool-shell", installCalmToolShellLayout);

	let exportRendering = false;
	let removeTerminalInputHandler: (() => void) | undefined;

	function registerBuiltIn<TParams extends TSchema, TDetails, TState>(
		factory: DefinitionFactory<TParams, TDetails, TState>,
	): void {
		const definitions = new Map<string, ToolDefinition<TParams, TDetails, TState>>();
		const definitionFor = (cwd: string): ToolDefinition<TParams, TDetails, TState> => {
			let definition = definitions.get(cwd);
			if (!definition) {
				definition = factory(cwd);
				definitions.set(cwd, definition);
			}
			return definition;
		};

		const original = definitionFor(process.cwd());
		const originalRenderCall = original.renderCall;
		const originalRenderResult = original.renderResult;
		const originalSelfShell = original.renderShell === "self";
		const standardShells = new WeakMap<object, StandardShellState>();

		if (!originalRenderCall || !originalRenderResult) {
			throw new Error(`deck calm requires both render slots for pi built-in tool ${original.name}`);
		}

		const shellStateFor = (
			context: RenderContext<TParams, TDetails, TState>,
		): StandardShellState => {
			const rowState = context.state as object;
			let shellState = standardShells.get(rowState);
			if (!shellState) {
				shellState = {};
				standardShells.set(rowState, shellState);
			}
			return shellState;
		};

		// Tools without their own shell normally get pi's standard status-colored
		// box; with renderShell: "self" that box is ours to rebuild.
		const refreshStandardShell = (
			state: StandardShellState,
			theme: RenderTheme<TParams, TDetails, TState>,
			context: RenderContext<TParams, TDetails, TState>,
		): Box => {
			const background = context.isPartial
				? (text: string) => theme.bg("toolPendingBg", text)
				: context.isError
					? (text: string) => theme.bg("toolErrorBg", text)
					: (text: string) => theme.bg("toolSuccessBg", text);
			const shell = state.shell ?? new Box(1, 1, background);
			state.shell = shell;
			shell.setBgFn(background);
			shell.clear();
			if (state.call) shell.addChild(state.call);
			if (state.result) shell.addChild(state.result);
			return shell;
		};

		pi.registerTool({
			...original,
			renderShell: "self",

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return definitionFor(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
			},

			renderCall(
				args: RenderArgs<TParams, TDetails, TState>,
				theme: RenderTheme<TParams, TDetails, TState>,
				context: RenderContext<TParams, TDetails, TState>,
			) {
				if (exportRendering) return originalRenderCall(args, theme, context);
				if (calmPresentationHides()) return new Container();
				if (originalSelfShell) return originalRenderCall(args, theme, context);

				const state = shellStateFor(context);
				state.call = originalRenderCall(args, theme, {
					...context,
					lastComponent: state.call,
				});
				return refreshStandardShell(state, theme, context);
			},

			renderResult(
				rawResult: unknown,
				options: ToolRenderResultOptions,
				theme: RenderTheme<TParams, TDetails, TState>,
				context: RenderContext<TParams, TDetails, TState>,
			) {
				const result = rawResult as RenderResult<TParams, TDetails, TState>;
				if (exportRendering) return originalRenderResult(result, options, theme, context);
				if (calmPresentationHides()) return new Container();
				if (originalSelfShell) return originalRenderResult(result, options, theme, context);

				const state = shellStateFor(context);
				state.result = originalRenderResult(result, options, theme, {
					...context,
					lastComponent: state.result,
				});
				refreshStandardShell(state, theme, context);
				return new Container();
			},
		});
	}

	registerBuiltIn(createReadToolDefinition);
	registerBuiltIn(createBashToolDefinition);
	registerBuiltIn(createEditToolDefinition);
	registerBuiltIn(createWriteToolDefinition);
	registerBuiltIn(createGrepToolDefinition);
	registerBuiltIn(createFindToolDefinition);
	registerBuiltIn(createLsToolDefinition);

	pi.on("session_start", (_event, ctx) => {
		exportRendering = false;
		setCalmPresentation(loadCalmPreference());
		setCalmStockExportRendering(false);
		// Headless contexts (print/RPC, and test fakes) have no ui surface.
		const ui = ctx.ui as typeof ctx.ui | undefined;
		if (ui === undefined) return;
		ui.setWorkingVisible(true);
		ui.setHiddenThinkingLabel(calmPresentationIsActive() ? "" : undefined);
		removeTerminalInputHandler?.();
		if (typeof ui.onTerminalInput !== "function") return;
		// /export and /share must render the stock transcript even while Calm is
		// active, so the boundary is the submit of one of those commands.
		removeTerminalInputHandler = ui.onTerminalInput((data) => {
			if (!getKeybindings().matches(data, "tui.input.submit")) return undefined;
			const input = ui.getEditorText().trim();
			if (input !== "/share" && input !== "/export" && !input.startsWith("/export ")) {
				return undefined;
			}
			exportRendering = true;
			setCalmStockExportRendering(true);
			setTimeout(() => {
				exportRendering = false;
				setCalmStockExportRendering(false);
				// Toggling Ctrl+O state and back forces a full transcript redraw
				// through a supported control, then restores the captain's state.
				const expanded = ui.getToolsExpanded();
				ui.setToolsExpanded(!expanded);
				ui.setToolsExpanded(expanded);
			}, 0);
			return undefined;
		});
	});

	pi.registerCommand("calm", {
		description: "Toggle deck's conversation-only transcript presentation.",
		handler: async (_args, ctx) => {
			const active = !calmPresentationIsActive();
			persistCalmPreference(active);
			setCalmPresentation(active);
			const ui = ctx.ui as typeof ctx.ui | undefined;
			if (ui === undefined) return;
			ui.setWorkingVisible(true);
			ui.setHiddenThinkingLabel(active ? "" : undefined);
			const expanded = ui.getToolsExpanded();
			ui.setToolsExpanded(!expanded);
			ui.setToolsExpanded(expanded);
		},
	});
}
