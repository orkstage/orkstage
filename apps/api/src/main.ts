import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { loadConfig, loadDotEnv } from '@orkstage/runtime';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';

const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

async function bootstrap() {
  loadDotEnv();
  const config = loadConfig(); // fail fast before anything starts

  const adapter = new FastifyAdapter({
    genReqId: () => randomUUID(),
    // Trust exactly the proxies in front of the API: `req.ip` (rate limits, audit) is then the
    // address the outermost trusted proxy saw, not a value the client can set.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: 1024 * 1024,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { bufferLogs: true });
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
        // Swagger UI needs inline styles/scripts; scoped to the docs route by the UI itself.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  });
  // The web console reaches the API through its own origin (Next.js rewrites), so CORS stays closed.

  const docs = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('OrkStage Control API')
      .setVersion('v1')
      .setDescription('OrkStage — command every stage of your cloud. Control plane for multi-cloud customer environments. See docs/API.md.')
      .addServer(config.API_PUBLIC_URL)
      .addCookieAuth('orkstage_session')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'ork_<env>_<id>_<secret>', description: 'Organization API key (scoped). Sessions use the cookie instead.' }, 'apiKey')
      .addSecurityRequirements('apiKey')
      .addSecurityRequirements('cookie')
      .addGlobalParameters({ name: 'x-orkstage-csrf', in: 'header', required: false, description: 'Cookie sessions: send "1" on POST/PATCH/PUT/DELETE. Not needed with an API key.' })
      .build(),
  );
  if (config.API_DOCS_ENABLED ?? config.NODE_ENV !== 'production') SwaggerModule.setup('api/docs', app, docs);

  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
}

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
