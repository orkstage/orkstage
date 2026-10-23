// SPDX-License-Identifier: AGPL-3.0-only
import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { catchError, from, mergeMap, type Observable, of, throwError } from 'rxjs';
import { REDIS } from '../infra/infra.module.js';
import { AppError } from './errors.js';

/** How long a finished request's response is kept for retries. */
const KEPT_SECONDS = 24 * 3600;
/** How long a running request holds its key: a request that dies must not block it forever. */
const RUNNING_SECONDS = 300;
const KEY = /^[A-Za-z0-9_.:-]{8,200}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface Entry {
  state: 'running' | 'done';
  /** The same key may only be retried with the same request. */
  fingerprint: string;
  body?: unknown;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * `Idempotency-Key` on mutating requests (open item 21): the first successful response for a key is
 * kept for 24 hours, per caller (a person or an API key), and a retry of the same request gets it
 * again (with `idempotent-replayed: true`) instead of doing the work twice. The route's own status
 * code applies to the replay, so only the body is kept. A key reused for a different request is
 * refused (422), and so is a retry while the first request still runs (409). Failed requests keep
 * nothing: retrying them runs them again.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers['idempotency-key'];
    if (header === undefined || !MUTATING.has(req.method)) return next.handle();
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !KEY.test(key)) throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 8 to 200 letters, digits or the characters - _ . :');
    const p = req.principal;
    const caller = p?.apiKey ? `key:${p.apiKey.id}` : p ? `user:${p.userId}` : null;
    if (!caller) return next.handle(); // public routes: nothing to scope a key to

    const redisKey = `idempotency:${caller}:${sha256(key)}`;
    const fingerprint = sha256(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`);
    return from(this.claim(redisKey, fingerprint)).pipe(
      mergeMap((done) => {
        if (done) {
          ctx.switchToHttp().getResponse<FastifyReply>().header('idempotent-replayed', 'true');
          return of(done.body);
        }
        return next.handle().pipe(
          mergeMap(async (body: unknown) => {
            const entry: Entry = { state: 'done', fingerprint, body: body ?? null };
            await this.redis.set(redisKey, JSON.stringify(entry), 'EX', KEPT_SECONDS);
            return body;
          }),
          catchError((err: unknown) => from(this.redis.del(redisKey)).pipe(mergeMap(() => throwError(() => err)))),
        );
      }),
    );
  }

  /** Holds the key for this request (null), or returns the finished entry to replay. */
  private async claim(redisKey: string, fingerprint: string, attempt = 0): Promise<Entry | null> {
    const running: Entry = { state: 'running', fingerprint };
    if (await this.redis.set(redisKey, JSON.stringify(running), 'EX', RUNNING_SECONDS, 'NX')) return null;
    const raw = await this.redis.get(redisKey);
    // Expired between the two calls: claim it again, once.
    if (!raw) return attempt === 0 ? this.claim(redisKey, fingerprint, 1) : null;
    const entry = JSON.parse(raw) as Entry;
    if (entry.fingerprint !== fingerprint) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
    if (entry.state === 'running') throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still running. Retry later.');
    return entry;
  }
}
