import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O `.env.example` é **a lista**, e a lista tinha sete de trinta.
 *
 * ## Por que isto é guarda de go-live, e não capricho
 *
 * O `AGENT_AUTHORITY.md` trata "variável de ambiente que não está no
 * `.env.example`" como parada obrigatória, e o próprio arquivo diz de si mesmo
 * que é a lista. Só que ele listava `DATABASE_URL`, `STAFF_EMAIL_PEPPER` e mais
 * cinco — enquanto o código lia `MFA_SECRET_KEY`, `API_KEY_PEPPER`,
 * `WEBHOOK_SECRET_KEY`, `WHATSAPP_TOKEN_KEY`, `PSP_MODO`, `FISCAL_MODO` e o
 * resto.
 *
 * **Todas as chaves de cifra estavam de fora.** Elas falham alto quando
 * ausentes, o que é a decisão certa — e transforma o dia do deploy numa
 * sequência de subir, quebrar, ler o erro, acrescentar uma variável, repetir.
 * Pior: `PSP_MODO` e `FISCAL_MODO` **não** falham alto (ausente é "nenhum", de
 * propósito), então a instalação sobe, parece pronta, e não cobra nem emite
 * nota. Uma lista incompleta é como alguém conclui que `WEBHOOK_SECRET_KEY` é
 * opcional.
 *
 * ## Por que derivada, e não uma lista ao lado
 *
 * Porque a lista ao lado é exatamente a que ninguém atualiza — é o defeito que
 * este teste existe para pegar, e cometê-lo aqui dentro seria irônico. A
 * varredura lê `process.env[...]` do **fonte** dos pacotes e das aplicações.
 */

const RAIZ = join(import.meta.dirname, '..');

/** Onde o produto roda. `scripts/` e teste ficam de fora — ver `SO_DE_FORA`. */
const PRODUCAO = ['packages', 'apps'];

/**
 * O que o produto lê e **não** vai para o `.env.example`, com o motivo.
 *
 * Não é "as que dão trabalho": é a lista das que não são configuração de quem
 * instala, e cada linha diz por quê.
 */
const SO_DE_FORA = {
  NODE_ENV: 'do runtime, não de quem instala',
  APP_VERSION: 'injetada pelo build',
  DATABASE_URL: 'já está no arquivo',
  // Ambiente de teste e de medição: quem os define é o próprio script.
  SEED_DATABASE_URL: 'suíte de integração; definida por scripts/*/test.sh',
  APP_DATABASE_URL: 'idem',
  DEMO_DATABASE_URL: 'medição; definida por scripts/medicao.sh',
  MEDICAO_PRINTS: 'medição',
  MEDICAO_SLUG: 'medição',
  MEDICAO_SENHA: 'medição',
  SUPER_ADMIN_PASSWORD: 'script de criação da conta de plataforma, uma vez',
  RATE_LIMIT_SHORT: 'comentada no arquivo, com o padrão de produção',
  RATE_LIMIT_LONG: 'idem',
};

/** `NEXT_*` e `__NEXT_*` são internos do framework, não configuração nossa. */
const ehDoFramework = (nome) => nome.startsWith('NEXT_') || nome.startsWith('__NEXT') ||
  nome.startsWith('VERCEL');

function fontes(dir, achados = []) {
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada === 'dist' || entrada === '.next') continue;
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) {
      fontes(caminho, achados);
    } else if (/\.(ts|tsx|mjs)$/.test(entrada) && !entrada.includes('.test.')) {
      achados.push(caminho);
    }
  }
  return achados;
}

describe('o .env.example é a lista', () => {
  /**
   * Com folga, e não por lentidão tolerada.
   *
   * O caso lê 448 arquivos do fonte, e o portão roda dez etapas em paralelo
   * contra a mesma máquina: sob carga, os 5s do padrão do vitest estouram numa
   * varredura que sozinha leva 60ms. Guarda que fica vermelha por disputa de
   * CPU é guarda que alguém desliga.
   */
  it('toda variável que o produto lê está declarada', { timeout: 30_000 }, () => {
    const declaradas = new Set(
      readFileSync(join(RAIZ, '.env.example'), 'utf8')
        .split('\n')
        .map((l) => l.replace(/^#\s*/, '').match(/^([A-Z_][A-Z0-9_]*)=/)?.[1])
        .filter(Boolean),
    );

    const lidas = new Map();
    for (const raiz of PRODUCAO) {
      for (const arquivo of fontes(join(RAIZ, raiz))) {
        const codigo = readFileSync(arquivo, 'utf8');
        for (const casa of codigo.matchAll(/process\.env(?:\[['"]([A-Z_][A-Z0-9_]*)['"]\]|\.([A-Z_][A-Z0-9_]*))/g)) {
          const nome = casa[1] ?? casa[2];
          if (!lidas.has(nome)) lidas.set(nome, arquivo.slice(RAIZ.length + 1));
        }
      }
    }

    const faltando = [...lidas]
      .filter(([nome]) => !declaradas.has(nome) && !SO_DE_FORA[nome] && !ehDoFramework(nome))
      .map(([nome, onde]) => `${nome} (lida em ${onde})`);

    expect(
      faltando,
      'variável lida pelo produto e ausente do .env.example. ' +
        'Ou ela entra no arquivo, ou entra em SO_DE_FORA com o motivo escrito — ' +
        'uma lista incompleta é como alguém conclui que a chave de cifra é opcional.',
    ).toEqual([]);
  });

  it('a guarda enxerga a variável que não está declarada', () => {
    /**
     * Guarda que não alcança o defeito que a motivou é pior que guarda nenhuma.
     * Esta prova o alcance com as duas formas que o código usa.
     */
    const declaradas = new Set(['JA_ESTA']);
    const acha = (codigo) =>
      [...codigo.matchAll(/process\.env(?:\[['"]([A-Z_][A-Z0-9_]*)['"]\]|\.([A-Z_][A-Z0-9_]*))/g)]
        .map((m) => m[1] ?? m[2])
        .filter((n) => !declaradas.has(n));

    expect(acha(`const a = process.env['MFA_SECRET_KEY'];`)).toEqual(['MFA_SECRET_KEY']);
    expect(acha(`const b = process.env.FISCAL_MODO;`)).toEqual(['FISCAL_MODO']);
    expect(acha(`const c = process.env['JA_ESTA'];`)).toEqual([]);
  });
});

describe('o compose entrega ao contêiner o que o código lê', () => {
  /**
   * A terceira lista, e a que faltava.
   *
   * O `.env.example` já era conferido contra o **fonte**. O que ninguém
   * conferia era o `deploy/compose.yml`: ele só entrega ao processo o que
   * repassa explicitamente, e uma variável ausente ali chega como `undefined`
   * **com o `.env` preenchido**.
   *
   * É a forma mais silenciosa do defeito do campo que o motor aceita e ninguém
   * preenche: o operador cola a variável, reinicia, e o produto se comporta
   * como se ela não existisse — sem erro, sem log, sem nada vermelho. Foi
   * exatamente o que aconteceu com `WHATSAPP_MODO` e as três `META_*` no dia
   * em que elas nasceram.
   */
  const compose = readFileSync(new URL('../deploy/compose.yml', import.meta.url), 'utf8');

  /**
   * O que a instalação **não** precisa conhecer.
   *
   * `ADMIN_DATABASE_URL` e `APP_DB_PASSWORD` o compose monta sozinho; o resto é
   * de teste, de medição ou da máquina de quem desenvolve. A lista é curta de
   * propósito: ela é o lugar onde uma variável de produção se esconderia.
   */
  const FORA_DO_COMPOSE = new Set([
    'NODE_ENV',
    'SEED_DATABASE_URL',
    'PORT',
    'WORKER_INTERVALO_MS',
    'RATE_LIMIT_SHORT',
    'RATE_LIMIT_LONG',
    'PULAR_BUILD_DAS_DEPENDENCIAS',
    'SEMENTE_BARBEARIA',
    'SEMENTE_DONO',
    'SEMENTE_EMAIL',
    'SEMENTE_SENHA',
    'SEMENTE_TELEFONE',
    'MEDICAO_PRINTS',
    'DB_PILOTO',
    'RECRIAR',
    'SEMEAR',
    'DESTINO',
    'TZ',
  ]);

  it('toda variável do .env.example chega ao contêiner', () => {
    const exemplo = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const declaradas = [...exemplo.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);

    const ausentes = declaradas.filter(
      (nome) => !FORA_DO_COMPOSE.has(nome) && !new RegExp(`^\\s*${nome}:`, 'm').test(compose),
    );

    expect(
      ausentes,
      'estas estão no .env.example e o compose não as repassa: preenchê-las no ' +
        '.env do servidor não faria efeito nenhum, e nada ficaria vermelho',
    ).toEqual([]);
  });
});
