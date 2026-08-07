import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('NetLink Control Plane')
    .setDescription(
      [
        'The NetLink cloud control plane.',
        '',
        'It handles identity, device trust, permissions, invitations and signalling.',
        'It deliberately does **not** carry file contents, screen frames or print',
        'payloads — those travel directly between the owner’s devices.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .addTag('health', 'Liveness and readiness')
    .addTag('auth', 'Registration, verification, sign-in and sessions')
    .addTag('devices', 'Enrolled device identities')
    .addTag('activity', 'Security audit trail')
    .build();
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
  return document;
}
