// SPDX-License-Identifier: AGPL-3.0-only
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import type { PlatformConfig } from '@orkstage/runtime';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { isDocsPath, relaxForDocs } from './common/csp.js';
import { loadEnterpriseModule } from './enterprise.js';

const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * The API application with its HTTP setup (prefix, correlation ids, cookies, security headers),
 * not yet listening. `main.ts` adds the OpenAPI document and listens; the integration tests in
 * `test/` call it through Fastify's `inject`.
 */
export async function createApp(config: PlatformConfig): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    genReqId: () => randomUUID(),
    // Trust exactly the proxies in front of the API: `req.ip` (rate limits, audit) is then the
    // address the outermost trusted proxy saw, not a value the client can set.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: 1024 * 1024,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.register(await loadEnterpriseModule()), adapter, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');

  const fastify = app.getHttpAdapter().getInstance();
  // Correlation id: accept a well-formed inbound id, otherwise use the request id (spec §24).
  fastify.addHook('onRequest', async (req, reply) => {
    const inbound = req.headers['x-correlation-id'];
    req.correlationId = typeof inbound === 'string' && CORRELATION_ID.test(inbound) ? inbound : String(req.id);
    (req.raw as typeof req.raw & { correlationId?: string }).correlationId = req.correlationId;
    reply.header('x-correlation-id', req.correlationId);
    reply.header('x-request-id', String(req.id));
  });

  await app.register(fastifyCookie, { secret: config.SESSION_SECRET });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  });
  // Swagger UI needs inline styles and scripts: only its pages get them (common/csp.ts).
  fastify.addHook('onSend', async (req, reply, payload) => {
    const policy = reply.getHeader('content-security-policy');
    if (typeof policy === 'string' && isDocsPath(req.url)) reply.header('content-security-policy', relaxForDocs(policy));
    return payload;
  });
  // The web console reaches the API through its own origin (Next.js rewrites), so CORS stays closed.
  return app;
}
