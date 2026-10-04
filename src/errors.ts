export type ErrorCode =
  | 'INVALID_PARAM'
  | 'NOT_FOUND'
  | 'DANGLING_REF'
  | 'INSUFFICIENT_SPACE'
  | 'LIMIT_EXCEEDED'
  | 'HEAP_NOT_INITIALIZED'
  | 'HEAP_ALREADY_INITIALIZED'
  | 'CONFLICT'
  | 'INTERNAL';

export class GcError extends Error {
  code: ErrorCode;
  status: number;
  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'GcError';
    this.code = code;
    this.status = status;
  }
}

export const invalidParam = (m: string) => new GcError('INVALID_PARAM', m, 400);
export const notFound = (m: string) => new GcError('NOT_FOUND', m, 404);
