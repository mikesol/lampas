import { type JobStore, RequestBodySchema } from "@lampas/core";

/** Adds CORS headers to a response. */
function corsHeaders(response: Response): Response {
	response.headers.set("Access-Control-Allow-Origin", "*");
	response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	response.headers.set("Access-Control-Allow-Headers", "Content-Type");
	return response;
}

/** Creates a JSON error response with CORS headers. */
function errorResponse(status: number, message: string): Response {
	return corsHeaders(
		new Response(JSON.stringify({ error: message }), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

/** Creates a JSON success response with CORS headers. */
function jsonResponse(status: number, body: unknown): Response {
	return corsHeaders(
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

async function handleForward(request: Request, jobStore: JobStore): Promise<Response> {
	let rawBody: unknown;
	try {
		rawBody = await request.json();
	} catch {
		return errorResponse(400, "Request body must be valid JSON");
	}

	const result = RequestBodySchema.safeParse(rawBody);
	if (!result.success) {
		const messages = result.error.issues.map((i) => i.message);
		return errorResponse(400, messages.join("; "));
	}

	const job = await jobStore.createJob(result.data);
	return jsonResponse(202, { job_id: job.id, status: job.status });
}

async function handleGetJob(jobId: string, jobStore: JobStore): Promise<Response> {
	const job = await jobStore.getJob(jobId);
	if (!job) {
		return errorResponse(404, "Job not found");
	}
	return jsonResponse(200, job);
}

/**
 * Routes an incoming HTTP request to the appropriate handler.
 *
 * Supports POST /forward and GET /jobs/:id. Returns proper HTTP error
 * responses for validation failures, wrong methods, and unknown routes.
 */
export async function handleRequest(request: Request, jobStore: JobStore): Promise<Response> {
	if (request.method === "OPTIONS") {
		return corsHeaders(new Response(null, { status: 204 }));
	}

	const url = new URL(request.url);

	if (url.pathname === "/forward") {
		if (request.method !== "POST") {
			return errorResponse(405, "Method not allowed");
		}
		return handleForward(request, jobStore);
	}

	const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
	if (jobMatch) {
		if (request.method !== "GET") {
			return errorResponse(405, "Method not allowed");
		}
		return handleGetJob(jobMatch[1], jobStore);
	}

	return errorResponse(404, "Not found");
}
