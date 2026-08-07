import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import type { IncomingMessage } from 'node:http';
import helmet from 'helmet';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';
import { buildOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get(ConfigService<AppConfig, true>);
  const logger = new Logger('Bootstrap');

  // Agents sign a digest of the exact request bytes, so the raw buffer has to
  // be kept. Re-serialising the parsed body would work only as long as key
  // order survived the round trip, which is not something to rely on.
  app.use(
    json({
      limit: '1mb',
      verify: (req: IncomingMessage & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(urlencoded({ extended: false, limit: '1mb' }));

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  // Behind a reverse proxy the client address arrives in X-Forwarded-For; without
  // this, every audit record and rate-limit bucket would show the proxy's address.
  app.set('trust proxy', 1);

  app.setGlobalPrefix(config.get('API_PREFIX', { infer: true }));

  const origins = config
    .get('CORS_ORIGINS', { infer: true })
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  if (config.get('ENABLE_OPENAPI', { infer: true })) {
    buildOpenApiDocument(app);
    logger.log('OpenAPI available at /docs');
  }

  // Native `ws` rather than socket.io: the desktop app is the only client, it
  // uses the browser WebSocket API, and the extra protocol layer buys nothing.
  app.useWebSocketAdapter(new WsAdapter(app));

  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  // 0.0.0.0 so the API is reachable from a container; a real deployment puts a
  // TLS-terminating proxy in front of it rather than exposing this port.
  const host = config.get('HOST', { infer: true });
  await app.listen(port, host);
  logger.log(`NetLink API listening on http://${host}:${port}`);
}

void bootstrap();
