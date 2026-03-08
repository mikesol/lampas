import { type ChildProcess, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

const WORKER_BASE = "http://localhost:8787";

/**
 * Spawns `npx wrangler dev --port 8787` and waits until the worker
 * responds to HTTP requests before resolving.
 */
export async function startWorker(): Promise<ChildProcess> {
	const child = spawn("npx", ["wrangler", "dev", "--port", "8787"], {
		cwd: new URL("../..", import.meta.url).pathname,
		stdio: "pipe",
		env: { ...process.env, NODE_ENV: "test" },
	});

	child.stderr?.on("data", (chunk: Buffer) => {
		if (process.env.DEBUG_E2E) console.error("[wrangler]", chunk.toString());
	});

	await waitForReady(WORKER_BASE, 30_000);
	return child;
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fetch(url);
			return;
		} catch {
			await sleep(250);
		}
	}
	throw new Error(`Worker at ${url} did not become ready within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin wrapper around `fetch` that prepends the local worker base URL.
 */
export function lampas(path: string, options?: RequestInit): Promise<Response> {
	return fetch(`${WORKER_BASE}${path}`, options);
}

// ---------------------------------------------------------------------------
// Mock upstream server
// ---------------------------------------------------------------------------

type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface MockUpstream {
	/** Replace the request handler for subsequent requests. */
	setHandler(handler: HttpHandler): void;
	/** Shut down the server. */
	close(): Promise<void>;
	/** The port the server is listening on. */
	port: number;
}

/**
 * Creates an HTTP server that acts as the upstream API target.
 * Default handler returns `200 {"result":"ok"}`.
 */
export async function createMockUpstream(port = 9001): Promise<MockUpstream> {
	let handler: HttpHandler = (_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ result: "ok" }));
	};

	const server = createServer((req, res) => handler(req, res));

	await new Promise<void>((resolve) => {
		server.listen(port, () => resolve());
	});

	return {
		setHandler(h: HttpHandler) {
			handler = h;
		},
		close() {
			return new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
		port,
	};
}

// ---------------------------------------------------------------------------
// Mock callback server
// ---------------------------------------------------------------------------

export interface CapturedRequest {
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

export interface MockCallback {
	/**
	 * Returns a promise that resolves when a POST arrives at the given path.
	 * Rejects if no request arrives within `timeoutMs`.
	 */
	waitForRequest(path: string, timeoutMs?: number): Promise<CapturedRequest>;
	/** Returns all captured requests for a path. */
	getRequests(path: string): CapturedRequest[];
	/** Configure the response status code for a specific path. */
	setStatus(path: string, status: number): void;
	/**
	 * Configure a sequence of status codes for a path.
	 * E.g. `[500, 200]` means the first request gets 500, the second gets 200.
	 * Once the sequence is exhausted, subsequent requests get the last status.
	 */
	setStatusSequence(path: string, statuses: number[]): void;
	/** Clear all captured requests, status overrides, and pending waiters. */
	reset(): void;
	/** Shut down the server. */
	close(): Promise<void>;
	/** The port the server is listening on. */
	port: number;
}

interface Waiter {
	path: string;
	resolve: (req: CapturedRequest) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Creates an HTTP server that captures incoming POST requests
 * for test assertions.
 */
export async function createMockCallback(port = 9002): Promise<MockCallback> {
	const requests = new Map<string, CapturedRequest[]>();
	const consumedCounts = new Map<string, number>();
	const statusOverrides = new Map<string, number>();
	const statusSequences = new Map<string, number[]>();
	const waiters: Waiter[] = [];

	function getStatusForPath(path: string): number {
		const seq = statusSequences.get(path);
		if (seq && seq.length > 0) {
			// If only one left, peek but don't remove (it becomes the permanent status)
			if (seq.length === 1) {
				return seq[0];
			}
			const status = seq.shift();
			if (status !== undefined) return status;
		}
		return statusOverrides.get(path) ?? 200;
	}

	const server = createServer((req, res) => {
		const reqPath = req.url ?? "/";
		const chunks: Buffer[] = [];

		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const captured: CapturedRequest = {
				path: reqPath,
				headers: req.headers,
				body: Buffer.concat(chunks).toString("utf-8"),
			};

			const list = requests.get(reqPath) ?? [];
			list.push(captured);
			requests.set(reqPath, list);

			// Resolve only the first matching waiter (FIFO)
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i].path === reqPath) {
					const waiter = waiters[i];
					clearTimeout(waiter.timer);
					waiter.resolve(captured);
					waiters.splice(i, 1);
					break;
				}
			}

			const status = getStatusForPath(reqPath);
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ received: true }));
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(port, () => resolve());
	});

	return {
		waitForRequest(path: string, timeoutMs = 10_000): Promise<CapturedRequest> {
			// Check if we already have an unconsumed matching request
			const existing = requests.get(path);
			const consumed = consumedCounts.get(path) ?? 0;
			if (existing && existing.length > consumed) {
				consumedCounts.set(path, consumed + 1);
				return Promise.resolve(existing[consumed]);
			}

			return new Promise<CapturedRequest>((resolve, reject) => {
				const timer = setTimeout(() => {
					const idx = waiters.findIndex((w) => w.resolve === resolve);
					if (idx !== -1) waiters.splice(idx, 1);
					reject(new Error(`No request on ${path} within ${timeoutMs}ms`));
				}, timeoutMs);

				waiters.push({ path, resolve, reject, timer });
			});
		},

		getRequests(path: string): CapturedRequest[] {
			return requests.get(path) ?? [];
		},

		setStatus(path: string, status: number) {
			statusOverrides.set(path, status);
			statusSequences.delete(path);
		},

		setStatusSequence(path: string, statuses: number[]) {
			statusSequences.set(path, [...statuses]);
			statusOverrides.delete(path);
		},

		reset() {
			requests.clear();
			consumedCounts.clear();
			statusOverrides.clear();
			statusSequences.clear();
			for (const waiter of waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("MockCallback reset"));
			}
			waiters.length = 0;
		},

		close() {
			return new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},

		port,
	};
}
