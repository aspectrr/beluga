import { useState, useRef, useEffect } from "react";
import { api, type Event, type AgentConfig } from "../api/client";

interface ChatMessage {
	role: "user" | "agent" | "system";
	content: string;
}

export function ChatPage() {
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [selectedAgent, setSelectedAgent] = useState("");
	const [input, setInput] = useState("");
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [sessionAgent, setSessionAgent] = useState<string | null>(null);
	const [status, setStatus] = useState<"idle" | "running" | "done" | "error">(
		"idle",
	);
	const [error, setError] = useState("");
	const messagesEnd = useRef<HTMLDivElement>(null);
	const esRef = useRef<EventSource | null>(null);

	const scrollToBottom = () => {
		messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
	};

	// Load agents on mount
	useEffect(() => {
		api
			.listAgents()
			.then((a) => {
				setAgents(a);
				// Default to "default" agent if available
				const defaultAgent = a.find(
					(ag) => ag.name === "default" && ag.enabled,
				);
				if (defaultAgent) setSelectedAgent("default");
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		scrollToBottom();
	}, [messages]);

	// Stream events for current session
	useEffect(() => {
		if (!sessionId) return;

		let mounted = true;

		const stream = async () => {
			try {
				const evts = await api.getEvents(sessionId);
				if (!mounted) return;

				const chatMsgs: ChatMessage[] = [];
				for (const e of evts) {
					if (e.type === "user_message") {
						chatMsgs.push({
							role: "user",
							content: String(e.data.content || ""),
						});
					} else if (e.type === "agent_message") {
						chatMsgs.push({
							role: "agent",
							content: String(e.data.content || ""),
						});
					} else if (e.type === "error") {
						chatMsgs.push({
							role: "system",
							content: String(
								e.data.message || e.data.error || "Unknown error",
							),
						});
					}
				}
				setMessages(chatMsgs);

				const lastSeq = evts.length > 0 ? evts[evts.length - 1].seq : 0;
				const es = api.streamEvents(sessionId, lastSeq);
				esRef.current = es;

				es.addEventListener("event", (e: MessageEvent) => {
					if (!mounted) return;
					const evt = JSON.parse(e.data) as Event;

					if (evt.type === "agent_message") {
						setMessages((prev) => [
							...prev,
							{
								role: "agent",
								content: String(evt.data.content || ""),
							},
						]);
					} else if (
						evt.type === "status_transition" &&
						evt.data.to === "completed"
					) {
						setStatus("done");
					} else if (
						evt.type === "status_transition" &&
						evt.data.to === "failed"
					) {
						setStatus("error");
					} else if (evt.type === "error") {
						setMessages((prev) => [
							...prev,
							{
								role: "system",
								content: String(evt.data.message || "Error"),
							},
						]);
						setStatus("error");
					}
				});
				es.onerror = () => {
					/* stream closed */
				};
			} catch (err) {
				if (mounted)
					setError(err instanceof Error ? err.message : "Stream error");
			}
		};

		stream();
		return () => {
			mounted = false;
			esRef.current?.close();
			esRef.current = null;
		};
	}, [sessionId]);

	const sendMessage = async () => {
		const text = input.trim();
		if (!text) return;
		setInput("");
		setError("");
		setMessages((prev) => [...prev, { role: "user", content: text }]);
		setStatus("running");

		try {
			if (!sessionId) {
				const source = "chat";
				const sourceId = crypto.randomUUID();
				const agent = selectedAgent || undefined;
				const session = await api.createSession(source, sourceId, text, agent);
				setSessionId(session.id);
				setSessionAgent(agent ?? null);
			} else {
				await api.sendMessage(sessionId, text);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to send");
			setStatus("error");
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	};

	const resetChat = () => {
		esRef.current?.close();
		setSessionId(null);
		setSessionAgent(null);
		setMessages([]);
		setStatus("idle");
		setError("");
	};

	// Resolve display info for current agent
	const activeAgent = sessionAgent
		? agents.find((a) => a.name === sessionAgent)
		: null;
	const agentDisplayName = (activeAgent?.name ?? selectedAgent) || "default";

	return (
		<div>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: 16,
				}}
			>
				<h1 style={{ fontSize: 24 }}>Chat</h1>
				<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
					{!sessionId ? (
						<div className="form-group" style={{ marginBottom: 0 }}>
							<select
								value={selectedAgent}
								onChange={(e) => setSelectedAgent(e.target.value)}
								style={{ width: 180 }}
								disabled={status === "running"}
							>
								{agents
									.filter((a) => a.enabled)
									.map((a) => (
										<option key={a.name} value={a.name}>
											{a.name}
											{a.model
												? ` (${a.model})`
												: a.provider
													? ` (${a.provider})`
													: ""}
										</option>
									))}
							</select>
						</div>
					) : (
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 8,
							}}
						>
							<span
								style={{
									fontSize: 13,
									color: "var(--text-dim)",
								}}
							>
								Chatting with
							</span>
							<span
								className="badge badge-running"
								style={{ fontSize: 13, padding: "4px 12px" }}
							>
								{agentDisplayName}
							</span>
							{activeAgent?.model && (
								<span
									style={{
										fontSize: 11,
										color: "var(--text-dim)",
									}}
								>
									{activeAgent.model}
								</span>
							)}
						</div>
					)}
					{sessionId && (
						<button className="btn btn-sm" onClick={resetChat}>
							New Chat
						</button>
					)}
				</div>
			</div>

			<div className="chat-container">
				<div className="chat-messages">
					{messages.length === 0 && (
						<div
							style={{
								textAlign: "center",
								color: "var(--text-dim)",
								padding: 40,
							}}
						>
							{sessionId
								? "Continue the conversation…"
								: `Send a message to start chatting with ${agentDisplayName}.`}
						</div>
					)}
					{messages.map((m, i) => (
						<div key={i} className={`chat-message ${m.role}`}>
							<div className="msg-content">{m.content}</div>
							<div className="msg-meta">{m.role}</div>
						</div>
					))}
					{status === "running" &&
						messages.length > 0 &&
						messages[messages.length - 1].role === "user" && (
							<div className="chat-message agent">
								<div
									className="msg-content"
									style={{
										color: "var(--text-dim)",
									}}
								>
									Thinking…
								</div>
							</div>
						)}
					<div ref={messagesEnd} />
				</div>

				{error && (
					<div
						style={{
							color: "var(--danger)",
							fontSize: 13,
							marginBottom: 8,
						}}
					>
						{error}
					</div>
				)}

				<div className="chat-input-row">
					<input
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={
							sessionId
								? "Continue the conversation…"
								: `Message ${agentDisplayName}…`
						}
						disabled={status === "running"}
					/>
					<button
						className="btn btn-primary"
						onClick={sendMessage}
						disabled={status === "running" || !input.trim()}
					>
						Send
					</button>
				</div>
			</div>
		</div>
	);
}
