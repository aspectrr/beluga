import { useState, useEffect } from "react";
import { api, type AgentConfig } from "../api/client";
import { BelugaRuntimeProvider } from "../components/BelugaRuntimeProvider";
import { useBelugaRuntime } from "../components/BelugaRuntimeContext";
import { Thread } from "../components/Thread";

export function ChatPage() {
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [selectedAgent, setSelectedAgent] = useState("default");
	const [ready, setReady] = useState(false);

	// Load agents on mount
	useEffect(() => {
		api
			.listAgents()
			.then((a) => {
				setAgents(a);
				const defaultAgent = a.find(
					(ag) => ag.name === "default" && ag.enabled,
				);
				if (defaultAgent) setSelectedAgent("default");
			})
			.catch(() => {})
			.finally(() => setReady(true));
	}, []);

	if (!ready) {
		return <div style={{ color: "var(--text-dim)" }}>Loading agents…</div>;
	}

	return (
		<BelugaRuntimeProvider agent={selectedAgent}>
			<ChatHeader
				agents={agents}
				selectedAgent={selectedAgent}
				onAgentChange={setSelectedAgent}
			/>
			<Thread />
		</BelugaRuntimeProvider>
	);
}

function ChatHeader({
	agents,
	selectedAgent,
	onAgentChange,
}: {
	agents: AgentConfig[];
	selectedAgent: string;
	onAgentChange: (agent: string) => void;
}) {
	const { reset, sessionId, agent } = useBelugaRuntime();
	const activeAgent = agents.find((a) => a.name === (agent || selectedAgent));
	const displayName = activeAgent?.name || selectedAgent || "default";

	return (
		<div className="chat-header">
			<h1 style={{ fontSize: 24 }}>Chat</h1>
			<div className="chat-header-actions">
				{!sessionId ? (
					<div className="form-group" style={{ marginBottom: 0 }}>
						<select
							value={selectedAgent}
							onChange={(e) => onAgentChange(e.target.value)}
							style={{ width: 180 }}
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
					<div className="chat-agent-info">
						<span className="chat-agent-label">Chatting with</span>
						<span className="badge badge-running">{displayName}</span>
						{activeAgent?.model && (
							<span className="chat-agent-model">{activeAgent.model}</span>
						)}
					</div>
				)}
				{sessionId && (
					<button className="btn btn-sm" onClick={reset}>
						New Chat
					</button>
				)}
			</div>
		</div>
	);
}
