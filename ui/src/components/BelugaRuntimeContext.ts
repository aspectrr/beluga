import { createContext, useContext } from "react";

interface BelugaRuntimeContextValue {
	reset: () => void;
	cancel: () => void;
	agent: string;
	sessionId: string | null;
}

export const BelugaRuntimeContext = createContext<BelugaRuntimeContextValue>({
	reset: () => {},
	cancel: () => {},
	agent: "",
	sessionId: null,
});

export const useBelugaRuntime = () => useContext(BelugaRuntimeContext);
