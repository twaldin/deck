/** Return true when a model returned the schema document instead of a result. */
export function isSchemaEcho(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.type === "string" &&
		(record.$schema !== undefined || record.properties !== undefined) &&
		record.required !== undefined;
}

/** Prompt text used by callers that need to correct a schema echo. */
export function schemaEchoCorrection(fields: string): string {
	return `Your last response repeated the JSON Schema. It is invalid. Return only one filled result object with these fields: ${fields}. Do not include $schema, type, properties, required, or additionalProperties.`;
}
