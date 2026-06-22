import { env } from "@/env";

type Level = "trace" | "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<Level, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
};

function shouldLog(level: Level) {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[env.LOG_LEVEL];
}

function fmt(scope: string, level: Level, msg: string, meta?: Record<string, unknown>) {
	const payload: Record<string, unknown> = {
		ts: new Date().toISOString(),
		level,
		scope,
		msg,
	};
	if (meta && Object.keys(meta).length > 0) payload.meta = meta;
	return JSON.stringify(payload);
}

export function createLogger(scope: string) {
	return {
		trace(msg: string, meta?: Record<string, unknown>) {
			if (shouldLog("trace")) console.debug(fmt(scope, "trace", msg, meta));
		},
		debug(msg: string, meta?: Record<string, unknown>) {
			if (shouldLog("debug")) console.debug(fmt(scope, "debug", msg, meta));
		},
		info(msg: string, meta?: Record<string, unknown>) {
			if (shouldLog("info")) console.info(fmt(scope, "info", msg, meta));
		},
		warn(msg: string, meta?: Record<string, unknown>) {
			if (shouldLog("warn")) console.warn(fmt(scope, "warn", msg, meta));
		},
		error(msg: string, meta?: Record<string, unknown>) {
			if (shouldLog("error")) console.error(fmt(scope, "error", msg, meta));
		},
	};
}

export type Logger = ReturnType<typeof createLogger>;
