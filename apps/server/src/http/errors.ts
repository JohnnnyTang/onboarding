import { type ErrorCode, HttpErrorSchema, type ValidationError } from "@bgp/schema";
import type { FastifyReply } from "fastify";

/** An error whose code and message are safe to send to any client. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly errors?: ValidationError[],
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found`);
export const forbidden = () => new ApiError(403, "FORBIDDEN", "Access denied");
export const conflict = (message: string) => new ApiError(409, "CONFLICT", message);
export const validationFailed = (message: string, errors: ValidationError[]) =>
  new ApiError(400, "VALIDATION_FAILED", message, errors);

export function sendError(reply: FastifyReply, error: ApiError): FastifyReply {
  const body = HttpErrorSchema.parse({
    error: {
      code: error.code,
      message: error.message,
      ...(error.errors ? { errors: error.errors } : {}),
    },
  });
  return reply.code(error.status).send(body);
}

interface Issue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}
/** The part of a Zod schema the HTTP layer uses; keeps zod itself out of the server. */
export interface Parser<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };
}

export function issuesToErrors(issues: readonly Issue[], prefix = ""): ValidationError[] {
  return issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter((part) => part !== "").join("."),
    message: issue.message,
  }));
}

/** Parse request data; failures list every schema issue without echoing the input. */
export function parseRequest<T>(
  schema: Parser<T>,
  value: unknown,
  code: "BAD_MESSAGE" | "VALIDATION_FAILED" = "BAD_MESSAGE",
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(
    400,
    code,
    code === "BAD_MESSAGE" ? "Invalid request" : "Validation failed",
    issuesToErrors(result.error.issues),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Database IDs are UUIDs; any other string names nothing. */
export function resourceId(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw notFound(what);
  return value;
}
