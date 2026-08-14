/** An Error the global error handler maps to a non-500 response (see server.ts setErrorHandler). */
export function httpError(status: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}
