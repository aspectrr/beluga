import { useState, useEffect, useCallback, useRef } from "react";
import {
	api,
	type Provider,
	type AgentConfig,
	type ProviderModel,
} from "../api/client";

// ── Searchable Model Dropdown ──────────────────────────────────

function ModelSelect({
	models,
	value,
	onChange,
	placeholder,
	disabled,
}: {
	models: ProviderModel[];
	value: string;
	onChange: (model: string) => void;
	placeholder?: string;
	disabled?: boolean;
}) {
	const [search, setSearch] = useState("");
	const [open, setOpen] = useState(false);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// Close on outside click
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (
				wrapperRef.current &&
				!wrapperRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, []);

	const filtered = models.filter((m) =>
		m.id.toLowerCase().includes(search.toLowerCase()),
	);

	const displayValue =
		value || (search ? search : placeholder || "Select model…");

	return (
		<div
			ref={wrapperRef}
			className={`model-select ${open ? "open" : ""}`}
			style={{ position: "relative" }}
		>
			<div
				className="model-select-trigger"
				style={{
					display: "flex",
					alignItems: "center",
					gap: 4,
					padding: "8px 12px",
					background: "var(--bg)",
					border: "1px solid var(--border)",
					borderRadius: 6,
					cursor: disabled ? "not-allowed" : "text",
					opacity: disabled ? 0.5 : 1,
				}}
				onClick={() => {
					if (disabled) return;
					setOpen(true);
					setTimeout(() => inputRef.current?.focus(), 0);
				}}
			>
				{!open && (
					<span
						style={{
							flex: 1,
							color: value ? "var(--text)" : "var(--text-dim)",
							fontSize: 14,
						}}
					>
						{displayValue}
					</span>
				)}
				{open && (
					<input
						ref={inputRef}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search models…"
						style={{
							flex: 1,
							border: "none",
							background: "transparent",
							padding: 0,
							fontSize: 14,
							color: "var(--text)",
							outline: "none",
						}}
					/>
				)}
				<span
					style={{
						color: "var(--text-dim)",
						fontSize: 11,
						flexShrink: 0,
					}}
				>
					▼
				</span>
			</div>

			{open && (
				<div
					className="model-select-dropdown"
					style={{
						position: "absolute",
						top: "100%",
						left: 0,
						right: 0,
						zIndex: 100,
						background: "var(--surface)",
						border: "1px solid var(--border)",
						borderRadius: 6,
						marginTop: 4,
						maxHeight: 240,
						overflowY: "auto",
					}}
				>
					{search && !models.some((m) => m.id === search) && (
						<div
							style={{
								padding: "8px 12px",
								cursor: "pointer",
								fontSize: 13,
								color: "var(--accent)",
								borderBottom: "1px solid var(--border)",
							}}
							onClick={() => {
								onChange(search);
								setSearch("");
								setOpen(false);
							}}
						>
							Use custom: "{search}"
						</div>
					)}
					{filtered.length === 0 && !search && (
						<div
							style={{
								padding: "8px 12px",
								color: "var(--text-dim)",
								fontSize: 13,
							}}
						>
							No models available. Save provider endpoint first.
						</div>
					)}
					{filtered.map((m) => (
						<div
							key={m.id}
							style={{
								padding: "8px 12px",
								cursor: "pointer",
								fontSize: 13,
								background:
									m.id === value ? "rgba(88,166,255,0.1)" : "transparent",
								color: m.id === value ? "var(--accent)" : "var(--text)",
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
							}}
							onMouseEnter={(e) =>
								(e.currentTarget.style.background = "rgba(88,166,255,0.08)")
							}
							onMouseLeave={(e) =>
								(e.currentTarget.style.background =
									m.id === value ? "rgba(88,166,255,0.1)" : "transparent")
							}
							onClick={() => {
								onChange(m.id);
								setSearch("");
								setOpen(false);
							}}
						>
							{m.id}
							{m.owned_by && (
								<span
									style={{
										color: "var(--text-dim)",
										marginLeft: 8,
										fontSize: 11,
									}}
								>
									{m.owned_by}
								</span>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ── Config Page ────────────────────────────────────────────────

export function ConfigPage() {
	const [providers, setProviders] = useState<Provider[]>([]);
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	// Edit state
	const [editingProvider, setEditingProvider] =
		useState<Partial<Provider> | null>(null);
	const [editingAgent, setEditingAgent] = useState<string | null>(null);
	const [agentEdits, setAgentEdits] = useState<
		Record<string, Partial<AgentConfig>>
	>({});

	// Model cache per provider
	const [providerModels, setProviderModels] = useState<
		Record<string, ProviderModel[]>
	>({});
	const [modelsLoading, setModelsLoading] = useState<Set<string>>(new Set());

	const load = useCallback(async () => {
		try {
			const [p, a] = await Promise.all([api.listProviders(), api.listAgents()]);
			setProviders(p);
			setAgents(a);
			setError("");
		} catch (e: any) {
			setError(e.message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	// Fetch models for a specific provider
	const fetchModels = useCallback(
		async (providerName: string) => {
			if (providerModels[providerName]) return; // already cached
			setModelsLoading((prev) => new Set(prev).add(providerName));
			try {
				const models = await api.listProviderModels(providerName);
				setProviderModels((prev) => ({ ...prev, [providerName]: models }));
			} catch {
				// Silently fail — models will just be empty
			} finally {
				setModelsLoading((prev) => {
					const n = new Set(prev);
					n.delete(providerName);
					return n;
				});
			}
		},
		[providerModels],
	);

	// ── Provider CRUD ──────────────────────────────────────────
	const saveProvider = async () => {
		if (!editingProvider?.name) return;
		try {
			await api.saveProvider(editingProvider.name, {
				endpoint: editingProvider.endpoint || "",
				apiKey: editingProvider.apiKey || "",
				model: editingProvider.model || "",
			});
			// Fetch models for the newly saved provider
			const name = editingProvider.name;
			setEditingProvider(null);
			await load();
			// Refresh models after save (endpoint may have changed)
			setProviderModels((prev) => {
				const n = { ...prev };
				delete n[name]; // clear cache so it re-fetches
				return n;
			});
			fetchModels(name);
		} catch (e: any) {
			setError(e.message);
		}
	};

	const deleteProvider = async (name: string) => {
		try {
			await api.deleteProvider(name);
			setProviderModels((prev) => {
				const n = { ...prev };
				delete n[name];
				return n;
			});
			load();
		} catch (e: any) {
			setError(e.message);
		}
	};

	// ── Agent config ──────────────────────────────────────────
	const saveAgent = async (name: string) => {
		const edits = agentEdits[name];
		if (!edits) return;
		try {
			await api.updateAgent(name, edits);
			setEditingAgent(null);
			setAgentEdits((prev) => {
				const n = { ...prev };
				delete n[name];
				return n;
			});
			load();
		} catch (e: any) {
			setError(e.message);
		}
	};

	if (loading)
		return <div style={{ color: "var(--text-dim)" }}>Loading config…</div>;

	return (
		<div>
			<h1 style={{ marginBottom: 24, fontSize: 24 }}>Configuration</h1>

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

			{/* ── Providers ──────────────────────────────────────── */}
			<div className="card">
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: 12,
					}}
				>
					<h2>Providers</h2>
					<button
						className="btn btn-primary btn-sm"
						onClick={() =>
							setEditingProvider({
								name: "",
								endpoint: "",
								apiKey: "",
								model: "",
							})
						}
					>
						+ Add Provider
					</button>
				</div>

				{editingProvider && (
					<div
						className="card"
						style={{ borderStyle: "dashed", marginBottom: 12 }}
					>
						<div className="grid-3">
							<div className="form-group">
								<label>Name</label>
								<input
									value={editingProvider.name || ""}
									onChange={(e) =>
										setEditingProvider({
											...editingProvider,
											name: e.target.value,
										})
									}
									placeholder="openai"
								/>
							</div>
							<div className="form-group">
								<label>Endpoint</label>
								<input
									value={editingProvider.endpoint || ""}
									onChange={(e) =>
										setEditingProvider({
											...editingProvider,
											endpoint: e.target.value,
										})
									}
									placeholder="https://api.openai.com/v1"
								/>
							</div>
							<div className="form-group">
								<label>API Key</label>
								<input
									type="password"
									value={editingProvider.apiKey || ""}
									onChange={(e) =>
										setEditingProvider({
											...editingProvider,
											apiKey: e.target.value,
										})
									}
									placeholder="${OPENAI_API_KEY}"
								/>
							</div>
						</div>
						<div className="grid-2">
							<div className="form-group">
								<label>Default Model</label>
								<ModelSelect
									models={
										editingProvider.name
											? (providerModels[editingProvider.name] ?? [])
											: []
									}
									value={editingProvider.model || ""}
									onChange={(model) =>
										setEditingProvider({
											...editingProvider,
											model,
										})
									}
									placeholder="gpt-4o"
									disabled={!editingProvider.name}
								/>
								{editingProvider.name &&
									!providerModels[editingProvider.name] &&
									!modelsLoading.has(editingProvider.name) && (
										<button
											className="btn btn-sm"
											style={{ marginTop: 4, fontSize: 11 }}
											onClick={() => fetchModels(editingProvider.name!)}
										>
											Load models from endpoint
										</button>
									)}
								{modelsLoading.has(editingProvider.name ?? "") && (
									<span
										style={{
											fontSize: 11,
											color: "var(--text-dim)",
											marginTop: 4,
										}}
									>
										Loading models…
									</span>
								)}
							</div>
							<div
								style={{
									display: "flex",
									alignItems: "flex-end",
									gap: 8,
									paddingBottom: 12,
								}}
							>
								<button
									className="btn btn-primary btn-sm"
									onClick={saveProvider}
								>
									Save
								</button>
								<button
									className="btn btn-sm"
									onClick={() => setEditingProvider(null)}
								>
									Cancel
								</button>
							</div>
						</div>
					</div>
				)}

				{providers.length === 0 && (
					<p style={{ color: "var(--text-dim)", fontSize: 14 }}>
						No providers configured. Agents will use the default LLM config.
					</p>
				)}

				{providers.map((p) => (
					<div
						key={p.name}
						style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							padding: "8px 0",
							borderBottom: "1px solid var(--border)",
						}}
					>
						<div>
							<strong>{p.name}</strong>
							<span
								style={{
									color: "var(--text-dim)",
									marginLeft: 8,
									fontSize: 13,
								}}
							>
								{p.model}
							</span>
							<span
								style={{
									color: "var(--text-dim)",
									marginLeft: 8,
									fontSize: 12,
								}}
							>
								{p.endpoint}
							</span>
						</div>
						<div style={{ display: "flex", gap: 6 }}>
							<button
								className="btn btn-sm"
								onClick={() => {
									setEditingProvider({
										name: p.name,
										endpoint: p.endpoint,
										apiKey: p.apiKey,
										model: p.model,
									});
									fetchModels(p.name);
								}}
							>
								Edit
							</button>
							<button
								className="btn btn-danger btn-sm"
								onClick={() => deleteProvider(p.name)}
							>
								Delete
							</button>
						</div>
					</div>
				))}
			</div>

			{/* ── Agents ─────────────────────────────────────────── */}
			<div className="card">
				<h2>Agents</h2>
				{agents.map((agent) => {
					const isEditing = editingAgent === agent.name;
					const edits = agentEdits[agent.name] || {};
					const selectedProvider = edits.provider ?? agent.provider ?? "";
					const providerModelsList = selectedProvider
						? (providerModels[selectedProvider] ?? [])
						: [];
					const currentModel = edits.model ?? agent.model ?? "";

					return (
						<div
							key={agent.name}
							style={{
								padding: "12px 0",
								borderBottom: "1px solid var(--border)",
							}}
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
								}}
							>
								<div>
									<strong style={{ fontSize: 15 }}>{agent.name}</strong>
									{agent.provider && (
										<span
											style={{
												color: "var(--accent)",
												marginLeft: 8,
												fontSize: 12,
											}}
										>
											via {agent.provider}
										</span>
									)}
									{agent.model && (
										<span
											style={{
												color: "var(--text-dim)",
												marginLeft: 8,
												fontSize: 13,
											}}
										>
											{agent.model}
										</span>
									)}
									<span
										className={`badge ${agent.enabled ? "badge-completed" : "badge-failed"}`}
										style={{ marginLeft: 8 }}
									>
										{agent.enabled ? "enabled" : "disabled"}
									</span>
								</div>
								<button
									className="btn btn-sm"
									onClick={() => {
										if (isEditing) {
											setEditingAgent(null);
										} else {
											setEditingAgent(agent.name);
											setAgentEdits({
												...agentEdits,
												[agent.name]: {
													provider: agent.provider,
													model: agent.model,
													enabled: agent.enabled,
												},
											});
											// Pre-load models for current provider
											if (agent.provider) {
												fetchModels(agent.provider);
											}
										}
									}}
								>
									{isEditing ? "Close" : "Edit"}
								</button>
							</div>

							{isEditing && (
								<div
									style={{
										marginTop: 12,
										paddingLeft: 8,
										borderLeft: "2px solid var(--border)",
									}}
								>
									<div className="grid-3">
										<div className="form-group">
											<label>Provider</label>
											<select
												value={selectedProvider}
												onChange={(e) => {
													const newProvider = e.target.value || undefined;
													setAgentEdits({
														...agentEdits,
														[agent.name]: {
															...edits,
															provider: newProvider,
															// Clear model override when switching providers
															model: undefined,
														},
													});
													if (newProvider) {
														fetchModels(newProvider);
													}
												}}
											>
												<option value="">Default LLM</option>
												{providers.map((p) => (
													<option key={p.name} value={p.name}>
														{p.name} ({p.model})
													</option>
												))}
											</select>
										</div>
										<div className="form-group">
											<label>
												Model
												{selectedProvider && currentModel && (
													<span
														style={{
															color: "var(--text-dim)",
															fontWeight: 400,
															textTransform: "none",
														}}
													>
														{" "}
														(per-agent override)
													</span>
												)}
											</label>
											{selectedProvider ? (
												<>
													<ModelSelect
														models={providerModelsList}
														value={currentModel}
														onChange={(model) =>
															setAgentEdits({
																...agentEdits,
																[agent.name]: {
																	...edits,
																	model,
																},
															})
														}
														placeholder="Use provider default"
													/>
													{currentModel && (
														<button
															className="btn btn-sm"
															style={{
																marginTop: 4,
																fontSize: 11,
															}}
															onClick={() =>
																setAgentEdits({
																	...agentEdits,
																	[agent.name]: {
																		...edits,
																		model: undefined,
																	},
																})
															}
														>
															Clear override (use provider default)
														</button>
													)}
												</>
											) : (
												<div
													style={{
														color: "var(--text-dim)",
														fontSize: 13,
														padding: "8px 0",
													}}
												>
													Select a provider to choose a model.
												</div>
											)}
										</div>
										<div className="form-group">
											<label>Status</label>
											<select
												value={
													edits.enabled !== undefined
														? String(edits.enabled)
														: String(agent.enabled)
												}
												onChange={(e) =>
													setAgentEdits({
														...agentEdits,
														[agent.name]: {
															...edits,
															enabled: e.target.value === "true",
														},
													})
												}
											>
												<option value="true">Enabled</option>
												<option value="false">Disabled</option>
											</select>
										</div>
									</div>
									<button
										className="btn btn-primary btn-sm"
										style={{ marginTop: 8 }}
										onClick={() => saveAgent(agent.name)}
									>
										Save
									</button>
								</div>
							)}
						</div>
					);
				})}
				{agents.length === 0 && (
					<p style={{ color: "var(--text-dim)", fontSize: 14 }}>
						No agents found.
					</p>
				)}
			</div>
		</div>
	);
}
