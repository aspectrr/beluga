import { useState } from "react";
import { ConfigPage } from "./pages/Config";
import { LogsPage } from "./pages/Logs";
import { ChatPage } from "./pages/Chat";
import "./App.css";

type Page = "config" | "logs" | "chat";

export default function App() {
	const [page, setPage] = useState<Page>("config");

	return (
		<div className="app">
			<nav className="nav">
				<div className="nav-brand">🐋 Beluga</div>
				<div className="nav-links">
					<button
						className={page === "config" ? "active" : ""}
						onClick={() => setPage("config")}
					>
						Config
					</button>
					<button
						className={page === "logs" ? "active" : ""}
						onClick={() => setPage("logs")}
					>
						Logs
					</button>
					<button
						className={page === "chat" ? "active" : ""}
						onClick={() => setPage("chat")}
					>
						Chat
					</button>
				</div>
			</nav>
			<main className="main">
				{page === "config" && <ConfigPage />}
				{page === "logs" && <LogsPage />}
				{page === "chat" && <ChatPage />}
			</main>
		</div>
	);
}
