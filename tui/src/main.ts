import { emitKeypressEvents } from "node:readline";
import { loadConfig } from "@deck/core";
import { z } from "zod";
import { answerCard, sendOwnerMessage } from "./actions";
import { BrokerStatusClient } from "./broker";
import { renderAccounts, renderBoard, renderEffort, sanitizeTerminalLines, sortBoardEfforts, wrapTerminalLines } from "./render";
import { DeckStateReader } from "./state";
import type { AccountsViewData, BoardViewData, EffortViewData, LoadIssue } from "./types";

const cliArgsSchema = z.union([z.tuple([]), z.tuple([z.literal("--once")])]);
const REFRESH_INTERVAL_MS = 2_000;

type Screen = { kind: "board" } | { kind: "effort"; effortId: string } | { kind: "accounts" };

type Prompt =
	| {
		kind: "answer-choice";
		effortId: string;
		cardId: string;
		expectedRevision: number;
		options: string[];
	}
	| {
		kind: "answer-text";
		effortId: string;
		cardId: string;
		expectedRevision: number;
		buffer: string;
	}
	| { kind: "message"; effortId: string; buffer: string };

interface Keypress {
	name?: string;
	ctrl?: boolean;
	meta?: boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class DeckTui {
	private readonly stateReader = new DeckStateReader();
	private readonly brokerClient = new BrokerStatusClient();
	private readonly heartbeatIntervalMs = loadConfig().router.heartbeatIntervalMs;
	private screen: Screen = { kind: "board" };
	private prompt: Prompt | null = null;
	private board: BoardViewData = { efforts: [], issues: [] };
	private effort: EffortViewData | null = null;
	private accounts: AccountsViewData = { usage: null, broker: null, issues: [] };
	private selectedEffort = 0;
	private selectedCard = 0;
	private effortScroll = 0;
	private accountsScroll = 0;
	private followSelectedCard = true;
	private statusLine = "";
	private refreshing = false;
	private acting = false;
	private refreshTimer: NodeJS.Timeout | null = null;
	private stopped = false;

	private readonly onKeypress = (text: string | undefined, key: Keypress): void => {
		void this.handleKeypress(text ?? "", key);
	};

	private readonly onResize = (): void => {
		this.draw();
	};

	private readonly onInterrupt = (): void => {
		this.stop(130);
	};

	async start(): Promise<void> {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("interactive mode requires a TTY; use --once for headless output");
		}
		await this.refresh();
		process.stdin.setEncoding("utf8");
		emitKeypressEvents(process.stdin);
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("keypress", this.onKeypress);
		process.stdout.on("resize", this.onResize);
		process.once("SIGINT", this.onInterrupt);
		process.stdout.write("\x1b[?25l");
		this.refreshTimer = setInterval(() => {
			void this.refresh();
		}, REFRESH_INTERVAL_MS);
		this.draw();
	}

	private stop(exitCode: number): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
		process.stdin.off("keypress", this.onKeypress);
		process.stdout.off("resize", this.onResize);
		process.off("SIGINT", this.onInterrupt);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
		process.stdout.write("\x1b[?25h\x1b[0m\n");
		process.exit(exitCode);
	}

	private async refresh(): Promise<void> {
		if (this.refreshing || this.stopped) return;
		this.refreshing = true;
		try {
			if (this.screen.kind === "board") {
				const previousOrder = sortBoardEfforts(this.board.efforts);
				const selectedId = previousOrder[this.selectedEffort]?.effort_id;
				this.board = this.stateReader.loadBoard();
				const nextOrder = sortBoardEfforts(this.board.efforts);
				const retainedIndex = selectedId === undefined
					? -1
					: nextOrder.findIndex(manifest => manifest.effort_id === selectedId);
				if (retainedIndex >= 0) this.selectedEffort = retainedIndex;
				if (nextOrder.length === 0) this.selectedEffort = 0;
				else this.selectedEffort = Math.min(this.selectedEffort, nextOrder.length - 1);
			} else if (this.screen.kind === "effort") {
				this.effort = this.stateReader.loadEffort(this.screen.effortId);
				const openCards = this.effort.manifest?.cards.filter(entry => entry.status === "open") ?? [];
				if (openCards.length === 0) this.selectedCard = 0;
				else this.selectedCard = Math.min(this.selectedCard, openCards.length - 1);
			} else {
				const accounts = this.stateReader.loadAccounts();
				const statusResult = await this.brokerClient.status();
				if (statusResult.ok) {
					accounts.broker = statusResult.status;
				} else {
					const socketIssue: LoadIssue = { source: "broker.sock", message: statusResult.error };
					accounts.issues.push(socketIssue);
				}
				this.accounts = accounts;
			}
		} catch (error) {
			this.statusLine = `refresh failed: ${errorMessage(error)}`;
		} finally {
			this.refreshing = false;
			this.draw();
		}
	}

	private draw(): void {
		if (this.stopped || !process.stdout.isTTY) return;
		const now = Date.now();
		const viewportRows = process.stdout.rows || 24;
		const viewportColumns = process.stdout.columns || 80;
		let promptLines: string[] = [];
		const inputWidth = Math.max(1, viewportColumns - 3);
		if (this.prompt?.kind === "answer-choice") {
			promptLines = ["", "ANSWER CARD: press an option number, f for free text, or Esc to cancel."];
		} else if (this.prompt?.kind === "answer-text") {
			promptLines = [
				"",
				"ANSWER CARD (free text; Enter submits, Esc cancels):",
				`> ${this.prompt.buffer.slice(-inputWidth)}_`,
			];
		} else if (this.prompt?.kind === "message") {
			promptLines = [
				"",
				"MESSAGE OWNER (Enter sends, Esc cancels):",
				`> ${this.prompt.buffer.slice(-inputWidth)}_`,
			];
		}
		promptLines = wrapTerminalLines(promptLines, viewportColumns);
		const statusLines = this.statusLine.length === 0
			? []
			: sanitizeTerminalLines(["", this.statusLine.slice(0, Math.max(1, viewportColumns - 1))]);
		const contentRows = Math.max(1, viewportRows - 2 - promptLines.length - statusLines.length);

		let lines: string[];
		if (this.screen.kind === "board") {
			lines = renderBoard(
				this.board,
				this.selectedEffort,
				now,
				this.heartbeatIntervalMs,
				contentRows,
				viewportColumns,
			);
			lines.push("", "↑/↓ select  Enter open  a accounts  r refresh  q quit");
		} else if (this.screen.kind === "effort") {
			const effort = this.effort ?? {
				effortId: this.screen.effortId,
				manifest: null,
				charter: null,
				events: [],
				inbox: [],
				issues: [],
			};
			const rendered = wrapTerminalLines(
				renderEffort(effort, this.selectedCard, now, this.heartbeatIntervalMs),
				viewportColumns,
			);
			const maxOffset = Math.max(0, rendered.length - contentRows);
			if (this.followSelectedCard) {
				const selectedLine = rendered.findIndex(line => line.startsWith(">"));
				if (selectedLine >= 0 && selectedLine < this.effortScroll) this.effortScroll = selectedLine;
				if (selectedLine >= this.effortScroll + contentRows) {
					this.effortScroll = selectedLine - Math.floor(contentRows / 2);
				}
			}
			this.effortScroll = Math.min(Math.max(0, this.effortScroll), maxOffset);
			const last = Math.min(rendered.length, this.effortScroll + contentRows);
			lines = rendered.slice(this.effortScroll, last);
			lines.push(
				"",
				`↑/↓ card Enter answer m msg PgUp/PgDn scroll b board q quit ${this.effortScroll + 1}-${last}/${rendered.length}`,
			);
		} else {
			const rendered = wrapTerminalLines(renderAccounts(this.accounts, now), viewportColumns);
			const maxOffset = Math.max(0, rendered.length - contentRows);
			this.accountsScroll = Math.min(Math.max(0, this.accountsScroll), maxOffset);
			const last = Math.min(rendered.length, this.accountsScroll + contentRows);
			lines = rendered.slice(this.accountsScroll, last);
			lines.push("", `PgUp/PgDn scroll  b board  r refresh  q quit  ${this.accountsScroll + 1}-${last}/${rendered.length}`);
		}

		lines.push(...promptLines, ...statusLines);
		process.stdout.write(`\x1b[2J\x1b[H${sanitizeTerminalLines(lines).join("\n")}`);
	}

	private async handleKeypress(text: string, key: Keypress): Promise<void> {
		if (this.acting || this.stopped) return;
		if (key.ctrl === true && key.name === "c") {
			this.stop(130);
			return;
		}
		if (this.prompt !== null) {
			await this.handlePromptKeypress(text, key);
			return;
		}

		if (key.name === "q") {
			this.stop(0);
			return;
		}
		if (key.name === "r") {
			await this.refresh();
			return;
		}
		if (key.name === "a") {
			this.screen = { kind: "accounts" };
			this.accountsScroll = 0;
			this.statusLine = "";
			await this.refresh();
			return;
		}
		if (key.name === "b" || key.name === "escape") {
			this.screen = { kind: "board" };
			this.statusLine = "";
			await this.refresh();
			return;
		}
		if (key.name === "pageup" || key.name === "pagedown") {
			const direction = key.name === "pageup" ? -1 : 1;
			const pageSize = Math.max(1, (process.stdout.rows || 24) - 4);
			if (this.screen.kind === "effort") {
				this.followSelectedCard = false;
				this.effortScroll = Math.max(0, this.effortScroll + direction * pageSize);
			}
			if (this.screen.kind === "accounts") {
				this.accountsScroll = Math.max(0, this.accountsScroll + direction * pageSize);
			}
			this.draw();
			return;
		}
		if (key.name === "up") {
			if (this.screen.kind === "board") this.selectedEffort = Math.max(0, this.selectedEffort - 1);
			if (this.screen.kind === "effort") {
				this.selectedCard = Math.max(0, this.selectedCard - 1);
				this.followSelectedCard = true;
			}
			this.draw();
			return;
		}
		if (key.name === "down") {
			if (this.screen.kind === "board") {
				const count = this.board.efforts.length;
				if (count > 0) this.selectedEffort = Math.min(count - 1, this.selectedEffort + 1);
			}
			if (this.screen.kind === "effort") {
				const count = this.effort?.manifest?.cards.filter(entry => entry.status === "open").length ?? 0;
				if (count > 0) this.selectedCard = Math.min(count - 1, this.selectedCard + 1);
				this.followSelectedCard = true;
			}
			this.draw();
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			if (this.screen.kind === "board") {
				const effort = sortBoardEfforts(this.board.efforts)[this.selectedEffort];
				if (effort !== undefined) {
					this.screen = { kind: "effort", effortId: effort.effort_id };
					this.selectedCard = 0;
					this.effortScroll = 0;
					this.followSelectedCard = true;
					this.statusLine = "";
					await this.refresh();
				}
			} else if (this.screen.kind === "effort") {
				this.beginAnswer();
				this.draw();
			}
			return;
		}
		if (key.name === "m" && this.screen.kind === "effort") {
			this.prompt = { kind: "message", effortId: this.screen.effortId, buffer: "" };
			this.statusLine = "";
			this.draw();
		}
	}

	private beginAnswer(): void {
		const manifest = this.effort?.manifest;
		if (manifest === null || manifest === undefined) {
			this.statusLine = "Cannot answer: manifest unavailable.";
			return;
		}
		const entry = manifest.cards.filter(candidate => candidate.status === "open")[this.selectedCard];
		if (entry === undefined) {
			this.statusLine = "No open card selected.";
			return;
		}
		this.prompt = {
			kind: "answer-choice",
			effortId: manifest.effort_id,
			cardId: entry.id,
			expectedRevision: manifest.revision,
			options: entry.card.options,
		};
		this.statusLine = "";
	}

	private async handlePromptKeypress(text: string, key: Keypress): Promise<void> {
		const prompt = this.prompt;
		if (prompt === null) return;
		if (key.name === "escape") {
			this.prompt = null;
			this.statusLine = "Cancelled.";
			this.draw();
			return;
		}
		if (prompt.kind === "answer-choice") {
			if (key.name === "f") {
				this.prompt = { ...prompt, kind: "answer-text", buffer: "" };
				this.draw();
				return;
			}
			if (/^[1-9]$/.test(text)) {
				const option = prompt.options[Number(text) - 1];
				if (option !== undefined) await this.submitAnswer(prompt, option);
			}
			return;
		}

		if (key.name === "return" || key.name === "enter") {
			if (prompt.buffer.trim().length === 0) {
				this.statusLine = prompt.kind === "message" ? "Message cannot be empty." : "Answer cannot be empty.";
				this.draw();
				return;
			}
			if (prompt.kind === "message") await this.submitMessage(prompt);
			else await this.submitAnswer(prompt, prompt.buffer);
			return;
		}
		if (key.name === "backspace") {
			prompt.buffer = Array.from(prompt.buffer).slice(0, -1).join("");
			this.draw();
			return;
		}
		if (key.ctrl !== true && key.meta !== true && text.length > 0) {
			prompt.buffer += text;
			this.draw();
		}
	}

	private async submitAnswer(
		prompt: Extract<Prompt, { kind: "answer-choice" | "answer-text" }>,
		answer: string,
	): Promise<void> {
		this.acting = true;
		try {
			const result = answerCard(prompt.effortId, prompt.cardId, answer, prompt.expectedRevision);
			this.prompt = null;
			this.statusLine = `Answered card ${prompt.cardId}; queued ${result.command.cmd_id} for owner delivery.`;
			if (this.screen.kind === "effort") this.effort = this.stateReader.loadEffort(this.screen.effortId);
		} catch (error) {
			this.prompt = null;
			this.statusLine = `Answer failed: ${errorMessage(error)}`;
			if (this.screen.kind === "effort") this.effort = this.stateReader.loadEffort(this.screen.effortId);
		} finally {
			this.acting = false;
			this.draw();
		}
	}

	private async submitMessage(prompt: Extract<Prompt, { kind: "message" }>): Promise<void> {
		this.acting = true;
		try {
			const command = sendOwnerMessage(prompt.effortId, prompt.buffer);
			this.prompt = null;
			this.statusLine = `Queued owner message ${command.cmd_id}; awaiting delivery receipt.`;
			if (this.screen.kind === "effort") this.effort = this.stateReader.loadEffort(this.screen.effortId);
		} catch (error) {
			this.prompt = null;
			this.statusLine = `Message failed: ${errorMessage(error)}`;
			if (this.screen.kind === "effort") this.effort = this.stateReader.loadEffort(this.screen.effortId);
		} finally {
			this.acting = false;
			this.draw();
		}
	}
}

export function renderBoardOnce(
	reader = new DeckStateReader(),
	now = Date.now(),
	heartbeatIntervalMs = loadConfig().router.heartbeatIntervalMs,
): string {
	return renderBoard(reader.loadBoard(), -1, now, heartbeatIntervalMs).join("\n");
}

async function main(): Promise<void> {
	const parsedArgs = cliArgsSchema.safeParse(process.argv.slice(2));
	if (!parsedArgs.success) {
		console.error("usage: bun src/main.ts [--once]");
		process.exitCode = 2;
		return;
	}
	if (parsedArgs.data[0] === "--once") {
		console.log(renderBoardOnce());
		return;
	}
	await new DeckTui().start();
}

if (import.meta.main) {
	main().catch(error => {
		console.error(errorMessage(error));
		process.exitCode = 1;
	});
}
