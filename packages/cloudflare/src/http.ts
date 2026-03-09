/** Serialize a request body for fetch. */
export function serializeBody(body: unknown): BodyInit | null {
	if (body === null || body === undefined) return null;
	if (typeof body === "string") return body;
	return JSON.stringify(body);
}

/** Create a JSON Response with the given status code. */
export function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
