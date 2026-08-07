import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { assertRlsEnforced } from '@barbearia/db';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  // Antes de servir a primeira requisição: se a conexão ignora RLS, o
  // isolamento entre barbearias não existe. Melhor não subir.
  await assertRlsEnforced();

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

  // A API fica atrás de proxy; sem isso o rate limit enxerga um IP só.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.enableShutdownHooks();

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  new Logger('bootstrap').log(`API ouvindo em :${port}`);
}

void bootstrap();
