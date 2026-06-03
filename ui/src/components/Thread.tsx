import {
	ThreadPrimitive,
	ComposerPrimitive,
	MessagePrimitive,
	ActionBarPrimitive,
	useThread,
} from "@assistant-ui/react";
import { useBelugaRuntime } from "./BelugaRuntimeContext";

// ── Main Thread ───────────────────────────────────────────────

export function Thread() {
	return (
		<ThreadPrimitive.Root className="aui-thread-root">
			<ThreadPrimitive.Viewport className="aui-thread-viewport">
				<ThreadWelcome />
				<ThreadPrimitive.Messages
					components={{
						UserMessage,
						AssistantMessage,
					}}
				/>
				<TypingIndicator />
			</ThreadPrimitive.Viewport>
			<div className="aui-composer-area">
				<ThreadScrollToBottom />
				<Composer />
			</div>
		</ThreadPrimitive.Root>
	);
}

// ── Typing indicator ──────────────────────────────────────────

function TypingIndicator() {
	const isRunning = useThread((s) => s.isRunning);
	if (!isRunning) return null;
	return (
		<div className="aui-typing-indicator">
			<span className="aui-dot" />
			<span className="aui-dot" />
			<span className="aui-dot" />
		</div>
	);
}

// ── Welcome ───────────────────────────────────────────────────

function ThreadWelcome() {
	return (
		<ThreadPrimitive.Empty>
			<div className="aui-thread-welcome">
				<span className="aui-thread-welcome-icon">🐋</span>
				<p className="aui-thread-welcome-msg">
					Send a message to start chatting.
				</p>
				<div className="aui-thread-welcome-suggestions">
					<ThreadPrimitive.Suggestion
						className="aui-suggestion"
						prompt="What can you do?"
						method="replace"
					>
						What can you do?
					</ThreadPrimitive.Suggestion>
					<ThreadPrimitive.Suggestion
						className="aui-suggestion"
						prompt="Help me debug an issue"
						method="replace"
					>
						Help me debug an issue
					</ThreadPrimitive.Suggestion>
					<ThreadPrimitive.Suggestion
						className="aui-suggestion"
						prompt="Explain how the agents work"
						method="replace"
					>
						Explain how the agents work
					</ThreadPrimitive.Suggestion>
				</div>
			</div>
		</ThreadPrimitive.Empty>
	);
}

// ── User Message ──────────────────────────────────────────────

function UserMessage() {
	return (
		<MessagePrimitive.Root className="aui-msg aui-msg-user">
			<div className="aui-msg-row aui-msg-row-user">
				<div className="aui-msg-content aui-msg-content-user">
					<MessagePrimitive.Content />
				</div>
			</div>
			<UserActionBar />
		</MessagePrimitive.Root>
	);
}

function UserActionBar() {
	return (
		<ActionBarPrimitive.Root
			className="aui-action-bar"
			hideWhenRunning
			autohide="not-last"
		>
			<ActionBarPrimitive.Copy asChild>
				<button className="aui-action-btn" title="Copy">
					{String.fromCodePoint(0x1f4cb)}
				</button>
			</ActionBarPrimitive.Copy>
			<ActionBarPrimitive.Edit asChild>
				<button className="aui-action-btn" title="Edit">
					✏️
				</button>
			</ActionBarPrimitive.Edit>
		</ActionBarPrimitive.Root>
	);
}

// ── Assistant Message ─────────────────────────────────────────

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="aui-msg aui-msg-assistant">
			<div className="aui-msg-row aui-msg-row-assistant">
				<div className="aui-msg-avatar">🤖</div>
				<div className="aui-msg-content aui-msg-content-assistant">
					<MessagePrimitive.Content
						components={{
							tools: {
								Fallback: ToolCallDisplay,
							},
						}}
					/>
				</div>
			</div>
			<AssistantActionBar />
		</MessagePrimitive.Root>
	);
}

function AssistantActionBar() {
	return (
		<ActionBarPrimitive.Root
			className="aui-action-bar"
			hideWhenRunning
			autohide="not-last"
			autohideFloat="single-branch"
		>
			<ActionBarPrimitive.Copy asChild>
				<button className="aui-action-btn" title="Copy">
					{String.fromCodePoint(0x1f4cb)}
				</button>
			</ActionBarPrimitive.Copy>
			<ActionBarPrimitive.Reload asChild>
				<button className="aui-action-btn" title="Regenerate">
					🔄
				</button>
			</ActionBarPrimitive.Reload>
		</ActionBarPrimitive.Root>
	);
}

// ── Tool Call Display ─────────────────────────────────────────

function ToolCallDisplay({
	toolName,
	args,
	result,
	status,
}: {
	toolName: string;
	args: Record<string, unknown>;
	result?: unknown;
	status: { type: string; reason?: string };
}) {
	const isLoading =
		status.type === "running" || status.type === "requires_action";
	const hasError = status.type === "incomplete" && status.reason === "error";

	return (
		<div className="aui-tool-call">
			<div className="aui-tool-call-header">
				<span className="aui-tool-call-icon">
					{isLoading ? "⏳" : hasError ? "❌" : "🔧"}
				</span>
				<span className="aui-tool-call-name">{toolName}</span>
				{isLoading && <span className="aui-tool-call-status">Running…</span>}
				{hasError && (
					<span className="aui-tool-call-status aui-tool-call-error">
						Error
					</span>
				)}
				{!isLoading && !hasError && (
					<span className="aui-tool-call-status aui-tool-call-done">Done</span>
				)}
			</div>
			{args && typeof args === "object" && Object.keys(args).length > 0 && (
				<div className="aui-tool-call-section">
					<span className="aui-tool-call-label">Args</span>
					<pre className="aui-tool-call-pre">
						{JSON.stringify(args, null, 2)}
					</pre>
				</div>
			)}
			{result !== undefined && (
				<div className="aui-tool-call-section">
					<span className="aui-tool-call-label">Result</span>
					<pre className="aui-tool-call-pre aui-tool-call-result">
						{typeof result === "string"
							? result
							: JSON.stringify(result, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}

// ── Composer ──────────────────────────────────────────────────

function Composer() {
	const { reset, sessionId } = useBelugaRuntime();
	const isRunning = useThread((s) => s.isRunning);

	return (
		<div className="aui-composer-wrapper">
			<ComposerPrimitive.Root className="aui-composer">
				<ComposerPrimitive.Input
					className="aui-composer-input"
					placeholder="Type a message…"
				/>
				{isRunning ? (
					<ComposerPrimitive.Cancel className="aui-composer-stop">
						⏹ Stop
					</ComposerPrimitive.Cancel>
				) : (
					<ComposerPrimitive.Send className="aui-composer-send">
						Send
					</ComposerPrimitive.Send>
				)}
			</ComposerPrimitive.Root>
			{sessionId && (
				<button className="aui-new-chat-btn" onClick={reset}>
					New Chat
				</button>
			)}
		</div>
	);
}

// ── Scroll to bottom ──────────────────────────────────────────

function ThreadScrollToBottom() {
	return (
		<ThreadPrimitive.ScrollToBottom className="aui-scroll-btn">
			↓
		</ThreadPrimitive.ScrollToBottom>
	);
}
