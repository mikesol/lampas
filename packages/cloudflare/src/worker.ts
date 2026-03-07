import type { Env } from "./job-do.js";

function corsHeaders(response: Response): Response {
	response.headers.set("Access-Control-Allow-Origin", "*");
	response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	response.headers.set("Access-Control-Allow-Headers", "Content-Type");
	return response;
}

function errorResponse(status: number, message: string): Response {
	return corsHeaders(
		new Response(JSON.stringify({ error: message }), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return corsHeaders(new Response(null, { status: 204 }));
		}

		const url = new URL(request.url);

		if (url.pathname === "/forward") {
			if (request.method !== "POST") {
				return errorResponse(405, "Method not allowed");
			}
			const jobId = crypto.randomUUID();
			const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
			const doRequest = new Request("http://do", {
				method: "POST",
				headers: {
					"X-Lampas-Job-Id": jobId,
					"Content-Type": request.headers.get("Content-Type") ?? "application/json",
				},
				body: request.body,
			});
			const response = await stub.fetch(doRequest);
			return corsHeaders(
				new Response(response.body, {
					status: response.status,
					headers: response.headers,
				}),
			);
		}

		const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
		if (jobMatch) {
			if (request.method !== "GET") {
				return errorResponse(405, "Method not allowed");
			}
			const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobMatch[1]));
			const response = await stub.fetch(new Request("http://do", { method: "GET" }));
			return corsHeaders(
				new Response(response.body, {
					status: response.status,
					headers: response.headers,
				}),
			);
		}

		return errorResponse(404, "Not found");
	},
} satisfies ExportedHandler<Env>;
