import {
	useState,
	useRef,
	useCallback,
	useEffect,
	type ReactNode,
} from "react";
import {
	useExternalStoreRuntime,
	AssistantRuntimeProvider,
	type ThreadMessageLike,
	type AppendMessage,
} from "@assistant-ui/react";
import { api, type Event } from "../api/client";
import { BelugaRuntimeContext } from "./BelugaRuntimeContext";

// ── Message types ─────────────────────────────────────────────

export interface TextContent {
	type: "text";
	text: string;
}

export interface ToolCallContent {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: unknown;
}

// Type helpers for assistant-ui compat
type ReadonlyJSONValue =
	| string
	| number
	| boolean
	| null
	| readonly ReadonlyJSONValue[]
	| { readonly [key: string]: ReadonlyJSONValue };
type ReadonlyJSONObject = { readonly [key: string]: ReadonlyJSONValue };

function toReadonlyJSON(val: unknown): ReadonlyJSONObject {
	if (val && typeof val === "object" && !Array.isArray(val)) {
		return val as ReadonlyJSONObject;
	}
	return {};
}

export type MessageContent = TextContent | ToolCallContent;

export interface BelugaMessage {
	role: "user" | "assistant";
	content: string | MessageContent[];
}

// ── Convert to ThreadMessageLike ──────────────────────────────

const convertMessage = (msg: BelugaMessage): ThreadMessageLike => {
	if (typeof msg.content === "string") {
		return {
			role: msg.role,
			content: [{ type: "text" as const, text: msg.content }],
		};
	}

	return {
		role: msg.role,
		content: msg.content.map((part) => {
			if (part.type === "text") {
				return { type: "text" as const, text: part.text };
			}
			// tool-call
			return {
				type: "tool-call" as const,
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				args: toReadonlyJSON(part.args),
				result: part.result,
			};
		}),
	};
};

// ── Provider ──────────────────────────────────────────────────

interface BelugaRuntimeProviderProps {
	agent: string;
	children: ReactNode;
}

export function BelugaRuntimeProvider({
	agent,
	children,
}: BelugaRuntimeProviderProps) {
	const [messages, setMessages] = useState<BelugaMessage[]>([]);
	const [isRunning, setIsRunning] = useState(false);
	const sessionIdRef = useRef<string | null>(null);
	const esRef = useRef<EventSource | null>(null);
	const seenSeqsRef = useRef<Set<number>>(new Set());
	const agentRef = useRef(agent);
	agentRef.current = agent;

	// Cleanup SSE on unmount
	useEffect(() => {
		return () => {
			esRef.current?.close();
		};
	}, []);

	// Map tool results back to their tool-call content parts
	const attachToolResult = useCallback(
		(callId: string, result: unknown, isError: boolean) => {
			setMessages((prev) =>
				prev.map((msg) => {
					if (typeof msg.content === "string") return msg;
					const content = msg.content.map((part) => {
						if (part.type === "tool-call" && part.toolCallId === callId) {
							return {
								...part,
								result: isError ? { error: String(result) } : result,
							};
						}
						return part;
					});
					return { ...msg, content };
				}),
			);
		},
		[],
	);

	// Append a tool_call to the last assistant message (or create a new one)
	const appendToolCall = useCallback(
		(toolName: string, callId: string, args: Record<string, unknown>) => {
			setMessages((prev) => {
				const toolPart: ToolCallContent = {
					type: "tool-call",
					toolCallId: callId,
					toolName,
					args,
				};

				// Try to append to last assistant message
				const lastMsg = prev[prev.length - 1];
				if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
					return [
						...prev.slice(0, -1),
						{ ...lastMsg, content: [...lastMsg.content, toolPart] },
					];
				}

				// Otherwise create a new assistant message
				return [...prev, { role: "assistant" as const, content: [toolPart] }];
			});
		},
		[],
	);

	const startStreaming = useCallback(
		(sessionId: string) => {
			esRef.current?.close();

			const streamEvents = async () => {
				try {
					const evts = await api.getEvents(sessionId);
					const chatMsgs: BelugaMessage[] = [];

					for (const e of evts) {
						seenSeqsRef.current.add(e.seq);
						pushEvent(e, chatMsgs);
					}
					setMessages(chatMsgs);

					const lastSeq = evts.length > 0 ? evts[evts.length - 1].seq : 0;
					const es = api.streamEvents(sessionId, lastSeq);
					esRef.current = es;

					es.addEventListener("event", (e: MessageEvent) => {
						const evt = JSON.parse(e.data) as Event;
						if (seenSeqsRef.current.has(evt.seq)) return;
						seenSeqsRef.current.add(evt.seq);
						handleStreamEvent(evt);
					});
					es.onerror = () => {};
				} catch (err) {
					setIsRunning(false);
					setMessages((prev) => [
						...prev,
						{
							role: "assistant",
							content: `⚠️ Failed to load session: ${err instanceof Error ? err.message : "Unknown error"}`,
						},
					]);
				}
			};

			streamEvents();
		},
		[attachToolResult, appendToolCall],
	);

	// Push an event onto a messages array (used for initial batch load)
	function pushEvent(e: Event, msgs: BelugaMessage[]) {
		if (e.type === "user_message") {
			msgs.push({
				role: "user",
				content: String(e.data.content || ""),
			});
		} else if (e.type === "agent_message") {
			// Check if last message was tool-calls only (no text), append text there
			const last = msgs[msgs.length - 1];
			if (
				last?.role === "assistant" &&
				Array.isArray(last.content) &&
				last.content.every((p) => p.type === "tool-call")
			) {
				(last.content as MessageContent[]).push({
					type: "text",
					text: String(e.data.content || ""),
				});
			} else {
				msgs.push({
					role: "assistant",
					content: String(e.data.content || ""),
				});
			}
		} else if (e.type === "tool_call") {
			const callId = String(e.data.call_id || `tc-${e.seq}`);
			const toolName = String(e.data.tool_name || "unknown");
			const args =
				typeof e.data.args === "object" && e.data.args !== null
					? (e.data.args as Record<string, unknown>)
					: {};

			const toolPart: ToolCallContent = {
				type: "tool-call",
				toolCallId: callId,
				toolName,
				args,
			};

			const last = msgs[msgs.length - 1];
			if (last?.role === "assistant" && Array.isArray(last.content)) {
				last.content.push(toolPart);
			} else {
				msgs.push({ role: "assistant", content: [toolPart] });
			}
		} else if (e.type === "tool_result") {
			const callId = String(e.data.call_id || "");
			const output = e.data.output;
			const isError = Boolean(e.data.is_error);

			// Find and update matching tool-call
			for (let i = msgs.length - 1; i >= 0; i--) {
				const msg = msgs[i];
				if (msg.role === "assistant" && Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "tool-call" && part.toolCallId === callId) {
							(part as ToolCallContent).result = isError
								? { error: String(output) }
								: tryParseJSON(String(output));
							return;
						}
					}
				}
			}
		}
	}

	// Handle a live streaming event
	function handleStreamEvent(evt: Event) {
		if (evt.type === "agent_message") {
			const text = String(evt.data.content || "");
			setMessages((prev) => {
				const last = prev[prev.length - 1];
				// Append text to a tool-call-only assistant message if that's the last one
				if (
					last?.role === "assistant" &&
					Array.isArray(last.content) &&
					last.content.every((p) => p.type === "tool-call")
				) {
					return [
						...prev.slice(0, -1),
						{
							...last,
							content: [...last.content, { type: "text" as const, text }],
						},
					];
				}
				return [...prev, { role: "assistant" as const, content: text }];
			});
		} else if (evt.type === "tool_call") {
			const callId = String(evt.data.call_id || `tc-${evt.seq}`);
			const toolName = String(evt.data.tool_name || "unknown");
			const args =
				typeof evt.data.args === "object" && evt.data.args !== null
					? (evt.data.args as Record<string, unknown>)
					: {};
			appendToolCall(toolName, callId, args);
		} else if (evt.type === "tool_result") {
			const callId = String(evt.data.call_id || "");
			const output = evt.data.output;
			const isError = Boolean(evt.data.is_error);
			attachToolResult(
				callId,
				isError ? String(output) : tryParseJSON(String(output)),
				isError,
			);
		} else if (
			evt.type === "status_transition" &&
			(evt.data.to === "completed" || evt.data.to === "failed")
		) {
			setIsRunning(false);
			if (evt.data.to === "failed") {
				setMessages((prev) => [
					...prev,
					{
						role: "assistant",
						content: `⚠️ Error: ${evt.data.reason || "Session failed"}`,
					},
				]);
			}
		} else if (evt.type === "error") {
			setMessages((prev) => [
				...prev,
				{
					role: "assistant",
					content: `⚠️ Error: ${evt.data.message || "Unknown error"}`,
				},
			]);
			setIsRunning(false);
		}
	}

	const onNew = useCallback(
		async (message: AppendMessage) => {
			const part = message.content[0];
			if (part?.type !== "text")
				throw new Error("Only text messages supported");
			const text = part.text;

			setMessages((prev) => [...prev, { role: "user", content: text }]);
			setIsRunning(true);

			try {
				if (!sessionIdRef.current) {
					const session = await api.createSession(
						"chat",
						crypto.randomUUID(),
						text,
						agentRef.current || undefined,
					);
					sessionIdRef.current = session.id;
					startStreaming(session.id);
				} else {
					await api.sendMessage(sessionIdRef.current, text);
				}
			} catch (err) {
				setIsRunning(false);
				setMessages((prev) => [
					...prev,
					{
						role: "assistant",
						content: `⚠️ ${err instanceof Error ? err.message : "Failed to send"}`,
					},
				]);
			}
		},
		[startStreaming],
	);

	const reset = useCallback(() => {
		esRef.current?.close();
		esRef.current = null;
		sessionIdRef.current = null;
		seenSeqsRef.current.clear();
		setMessages([]);
		setIsRunning(false);
	}, []);

	const cancel = useCallback(async () => {
		esRef.current?.close();
		esRef.current = null;
		setIsRunning(false);

		// Tell the backend to kill the agent loop
		const sid = sessionIdRef.current;
		if (sid) {
			try {
				await api.cancelSession(sid);
			} catch {
				// Backend cancellation failed — frontend already stopped streaming
			}
		}
	}, []);

	const runtime = useExternalStoreRuntime({
		isRunning,
		messages,
		convertMessage,
		onNew,
		onCancel: cancel,
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<BelugaRuntimeContext.Provider
				value={{ reset, cancel, agent, sessionId: sessionIdRef.current }}
			>
				{children}
			</BelugaRuntimeContext.Provider>
		</AssistantRuntimeProvider>
	);
}

// ── Helpers ───────────────────────────────────────────────────

function tryParseJSON(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}
