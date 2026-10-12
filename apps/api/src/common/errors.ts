// SPDX-License-Identifier: AGPL-3.0-only
import { DomainError } from '@orkstage/domain';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** Application error with a stable code, mapped to the standard error body (spec §53). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new AppError(403, 'FORBIDDEN', message);
export const conflict = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError(422, code, message, details);

const DOMAIN_STATUS: Record<string, number> = {
  INVALID_STATE_TRANSITION: 409,
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const { status, code, message, details } = this.map(exception);

    if (status >= 500) {
      this.logger.error({ err: exception, correlationId: req.correlationId }, 'Unhandled error');
    }
    reply.status(status).send({
      error: { code, message, requestId: String(req.id), correlationId: req.correlationId ?? String(req.id), details },
    });
  }

  private map(e: unknown): { status: number; code: string; message: string; details: Record<string, unknown> } {
    if (e instanceof AppError) return { status: e.status, code: e.code, message: e.message, details: e.details };
    if (e instanceof ZodError) {
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'The request is invalid.',
        details: { issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      };
    }
    if (e instanceof DomainError) {
      return { status: DOMAIN_STATUS[e.code] ?? 422, code: e.code, message: e.message, details: e.details };
    }
    const prismaCode = (e as { code?: string })?.code;
    if (prismaCode === 'P2002') return { status: 409, code: 'CONFLICT', message: 'A record with these values already exists.', details: {} };
    if (prismaCode === 'P2025') return { status: 404, code: 'NOT_FOUND', message: 'Record not found.', details: {} };
    if (e instanceof HttpException) {
      const status = e.getStatus();
      return {
        status,
        code: status === HttpStatus.TOO_MANY_REQUESTS ? 'RATE_LIMITED' : HttpStatus[status] ?? 'HTTP_ERROR',
        message: status === HttpStatus.TOO_MANY_REQUESTS ? 'Too many requests. Slow down and retry later.' : e.message,
        details: {},
      };
    }
    // Never leak internals: no stack traces or raw messages in production responses.
    return { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', details: {} };
  }
}
