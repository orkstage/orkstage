import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { loadConfig, loadDotEnv } from '@co/runtime';
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
    trustProxy: true,
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
      .addCookieAuth('co_session')
      .addGlobalParameters({ name: 'x-co-csrf', in: 'header', required: false, description: 'Send "1" on POST/PATCH/PUT/DELETE.' })
      .build(),
  );
  SwaggerModule.setup('api/docs', app, docs);

  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
}

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
