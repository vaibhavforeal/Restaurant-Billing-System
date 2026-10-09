export const dateTime = (value: number | null) => value === null ? "—" : new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unable to complete this request";
