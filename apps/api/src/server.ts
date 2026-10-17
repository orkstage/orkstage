// SPDX-License-Identifier: AGPL-3.0-only
import 'reflect-metadata';
import { loadConfig, loadDotEnv } from '@orkstage/runtime';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createApp } from './app.js';

async function bootstrap() {
  loadDotEnv();
  const config = loadConfig(); // fail fast before anything starts
  const app = await createApp(config);

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
