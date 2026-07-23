type ToolTextResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
};

export function toolText(text: string): ToolTextResult {
	return { content: [{ type: "text", text }] };
}

export function toolError(error: unknown): ToolTextResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		isError: true,
		content: [{ type: "text", text: `Error: ${message}` }],
	};
}

export type ToolStructuredResult<T extends Record<string, unknown>> = {
	content: Array<{ type: "text"; text: string }>;
	structuredContent: T;
};

export function toolStructured<T extends Record<string, unknown>>(
	text: string,
	structuredContent: T,
): ToolStructuredResult<T> {
	return {
		content: [{ type: "text", text }],
		structuredContent,
	};
}
