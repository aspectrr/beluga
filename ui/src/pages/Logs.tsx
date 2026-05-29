import { useState, useEffect, useCallback } from "react";
import { api, type Session, type Event } from "../api/client";

export function LogsPage() {
	const [sessions, setSessions] = useState<Session[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [events, setEvents] = useState<Event[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	const loadSessions = useCallback(async () => {
		try {
			const s = await api.listSessions();
			setSessions(s);
			setError("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load sessions");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadSessions();
	}, [loadSessions]);

	// Load events + stream when session selected
	useEffect(() => {
		if (!selectedId) {
			setEvents([]);
			return;
		}

		let mounted = true;
		let es: EventSource | null = null;

		const loadAndStream = async () => {
			try {
				const evts = await api.getEvents(selectedId);
				if (!mounted) return;
				setEvents(evts);

				const lastSeq = evts.length > 0 ? evts[evts.length - 1].seq : 0;
				es = api.streamEvents(selectedId, lastSeq);
				es.addEventListener("event", (e: MessageEvent) => {
					if (!mounted) return;
					const evt = JSON.parse(e.data) as Event;
					setEvents((prev) => [...prev, evt]);
				});
				es.onerror = () => {
					/* stream ends, ignore */
				};
			} catch (err) {
				if (mounted)
					setError(
						err instanceof Error ? err.message : "Failed to load events",
					);
			}
		};

		loadAndStream();
		return () => {
			mounted = false;
			es?.close();
		};
	}, [selectedId]);

	const statusBadge = (status: string) => `badge badge-${status}`;

	if (loading)
		return <div style={{ color: "var(--text-dim)" }}>Loading sessions…</div>;

	return (
		<div>
			<h1 style={{ marginBottom: 24, fontSize: 24 }}>Logs</h1>

			{error && (
				<div
					className="card"
					style={{
						borderColor: "var(--danger)",
						color: "var(--danger)",
						marginBottom: 16,
					}}
				>
					{error}
				</div>
			)}

			<div className="grid-2" style={{ alignItems: "start" }}>
				{/* Session list */}
				<div
					className="card"
					style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}
				>
					<h2>Sessions</h2>
					{sessions.length === 0 && (
						<p style={{ color: "var(--text-dim)", fontSize: 14 }}>
							No sessions yet.
						</p>
					)}
					{sessions.map((s) => (
						<div
							key={s.id}
							className={`session-row ${selectedId === s.id ? "active" : ""}`}
							style={
								selectedId === s.id
									? {
											background: "var(--border)",
											borderRadius: 6,
											padding: "10px 8px",
										}
									: {}
							}
							onClick={() => setSelectedId(s.id)}
						>
							<span className="id">{s.id.slice(0, 8)}…</span>
							<span>{s.agent || "—"}</span>
							<span>{s.source}</span>
							<span className={`badge ${statusBadge(s.status)}`}>
								{s.status}
							</span>
							<span style={{ fontSize: 12, color: "var(--text-dim)" }}>
								{new Date(s.createdAt).toLocaleString()}
							</span>
						</div>
					))}
					<button
						className="btn btn-sm"
						style={{ marginTop: 12 }}
						onClick={loadSessions}
					>
						Refresh
					</button>
				</div>

				{/* Event timeline */}
				<div
					className="card"
					style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}
				>
					<h2>
						Events{" "}
						{selectedId && (
							<span
								style={{
									color: "var(--text-dim)",
									fontWeight: 400,
									fontSize: 13,
								}}
							>
								({selectedId.slice(0, 8)}…)
							</span>
						)}
					</h2>
					{!selectedId && (
						<p style={{ color: "var(--text-dim)", fontSize: 14 }}>
							Select a session to view events.
						</p>
					)}
					{events.length === 0 && selectedId && (
						<p style={{ color: "var(--text-dim)", fontSize: 14 }}>No events.</p>
					)}
					<ul className="log-timeline">
						{events.map((e) => (
							<li key={e.id} className="log-event">
								<span className="seq">#{e.seq}</span>
								<span className="type" style={{ color: typeColor(e.type) }}>
									{e.type}
								</span>
								<span className="data">{summarizeEvent(e)}</span>
								<span
									style={{
										fontSize: 11,
										color: "var(--text-dim)",
										minWidth: 60,
									}}
								>
									{new Date(e.createdAt).toLocaleTimeString()}
								</span>
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	);
}

function typeColor(type: string): string {
	switch (type) {
		case "user_message":
			return "var(--accent)";
		case "agent_message":
			return "var(--success)";
		case "tool_call":
			return "var(--warn)";
		case "tool_result":
			return "var(--text-dim)";
		case "error":
			return "var(--danger)";
		case "status_transition":
			return "var(--text-dim)";
		default:
			return "var(--text)";
	}
}

function summarizeEvent(e: Event): string {
	const d = e.data;
	switch (e.type) {
		case "user_message":
			return truncate(String(d.content || ""), 120);
		case "agent_message":
			return truncate(String(d.content || ""), 120);
		case "tool_call":
			return `${d.tool_name}(${truncate(JSON.stringify(d.args || {}), 60)})`;
		case "tool_result":
			return d.is_error
				? `❌ ${truncate(String(d.output || ""), 80)}`
				: truncate(String(d.output || ""), 80);
		case "status_transition":
			return `${d.from} → ${d.to}`;
		case "error":
			return truncate(String(d.message || d.error || ""), 100);
		case "interrupt":
			return String(d.reason || "interrupted");
		default:
			return truncate(JSON.stringify(d), 100);
	}
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + "…" : s;
}
