export type ErrorCode =
  | "E_INVALID_ARG"
  | "E_NOT_FOUND"
  | "E_DANGLING_REF"
  | "E_NO_SPACE"
  | "E_LIMIT"
  | "E_NO_HEAP"
  | "E_INTERNAL";

export class GcError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = "GcError";
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new GcError(code, message);
}
