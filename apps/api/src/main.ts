import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { assertRlsEnforced } from '@barbearia/db';
import { AppModule } from './app.module.js';
import { TETO_DO_ARQUIVO } from './admin/importacao.schemas.js';
import { guardarCorpoCru } from './common/corpo-cru.js';
import { ajustarKeepAlive } from './common/keep-alive.js';

async function bootstrap(): Promise<void> {
  // Antes de servir a primeira requisição: se a conexão ignora RLS, o
  // isolamento entre barbearias não existe. Melhor não subir.
  await assertRlsEnforced();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  /**
   * O corpo cresceu por causa de uma rota só: a importação de base.
   *
   * O padrão do Express é 100 kB, e uma exportação de mil e duzentos clientes
   * passa disso. O teto sobe para o mesmo valor que o schema da rota já recusa,
   * para que a resposta seja o 400 explicando "arquivo grande demais" em vez do
   * 413 genérico do parser, que não diz qual é o limite nem o que fazer.
   *
   * Vale para toda a API, e é o custo aceito de não trazer um segundo parser só
   * para uma rota. As outras continuam limitadas pelos próprios schemas, que
   * recusam campo grande na borda.
   *
   * Pelo `useBodyParser` do Nest, e não importando `express` direto: o pacote
   * chega aqui por dentro do `@nestjs/platform-express` e não é dependência
   * declarada de `apps/api`. Importá-lo compilava e derrubava a API no
   * `node dist/main.js` — que os testes não pegam, porque eles montam a
   * aplicação sem passar por este arquivo.
   */
  /**
   * `verify` guarda o corpo cru, e existe por uma rota só: o webhook do
   * adquirente (bloco 29).
   *
   * A assinatura HMAC é sobre os bytes que o provedor assinou. Reserializar o
   * objeto já analisado mudaria espaço em branco e ordem de chave, e a
   * conferência passaria a depender do `JSON.stringify` do Node em vez do que
   * o adquirente mandou — o que **passa** em teste e falha em produção.
   *
   * A função mora em `common/corpo-cru.ts` e não aqui: os testes montam a
   * aplicação sem passar por este arquivo e aplicam o **mesmo** parser. Uma
   * configuração que só vale em produção é uma configuração que ninguém testa.
   */
  app.useBodyParser('json', { limit: TETO_DO_ARQUIVO, verify: guardarCorpoCru });

  // A API fica atrás de proxy; sem isso o rate limit enxerga um IP só.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  /**
   * E, pela mesma razão de estar atrás de proxy, a conexão ociosa precisa viver
   * mais que a dele. O porquê está em `common/keep-alive.ts`; aqui fica só a
   * chamada, porque é este o único lugar onde o servidor HTTP existe.
   */
  ajustarKeepAlive(app.getHttpServer());

  app.enableShutdownHooks();

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  new Logger('bootstrap').log(`API ouvindo em :${port}`);
}

void bootstrap();
