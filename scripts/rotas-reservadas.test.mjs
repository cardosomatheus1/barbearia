import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Toda rota de primeiro nível do site é um slug que a barbearia não pode ter.
 *
 * ## O defeito que trouxe este arquivo
 *
 * `SLUGS_RESERVADOS` nasceu com sete nomes e a frase "só o que hoje existe como
 * rota de primeiro nível". O `apps/web` cresceu quatro rotas por baixo dela —
 * `plataforma`, `buscar`, `ir`, `pagamento` — e a lista não se mexeu. Cada uma
 * dessas é um endereço que uma barbearia podia registrar e perder.
 *
 * O Next dá prioridade a segmento estático sobre dinâmico: com o slug
 * `plataforma`, a barbearia continua no banco e continua na busca, mas `/{slug}`
 * nunca é consultado — a pasta `app/plataforma/` casa primeiro. Não há exceção,
 * não há log, nada fica vermelho. Chega ao suporte como "meu link não abre".
 *
 * ## Por que derivada, e não uma lista ao lado
 *
 * Porque a lista ao lado **é** o defeito: foi ela que divergiu. Uma segunda
 * escrita à mão diverge de novo na próxima rota criada, e da mesma forma
 * silenciosa. Aqui os nomes saem das pastas de `apps/web/src/app`; quem cria a
 * rota faz o teste ficar vermelho no mesmo commit.
 *
 * ## Por que fora dos dois pacotes
 *
 * `SLUGS_RESERVADOS` mora em `packages/core` porque `crm` e `identity` precisam
 * dela e a seta entre os dois não permite que um guarde para o outro. Nenhum
 * deles pode aprender que `apps/web` existe — e a suíte do `crm` roda contra
 * Postgres, enquanto esta conferência não toca banco nenhum e precisa rodar
 * sempre. É a mesma forma, e o mesmo motivo, de
 * `scripts/recursos-da-navegacao.test.mjs`.
 */

const RAIZ = join(import.meta.dirname, '..');

const APP = join(RAIZ, 'apps/web/src/app');
const FONTE = join(RAIZ, 'packages/core/src/slug.ts');

/**
 * O que está reservado sem ter pasta em `app/`, com o motivo de cada um.
 *
 * Não é "as que sobraram": é a lista das reservas que não vêm de uma rota do
 * Next, e cada linha diz de onde vem. Reserva sem motivo escrito reprova.
 */
const SEM_PASTA = {
  api: 'o Caddy trata `/api/*` e manda para `api:3000` — nunca chega ao Next (deploy/Caddyfile)',
  www: 'o bloco `www.{$DOMINIO}` do Caddyfile redireciona para o domínio canônico',
  _next: 'prefixo do próprio framework (`_next/static`, `_next/image`)',
  // As três abaixo não têm rota hoje, e ficam porque soltá-las é porta de mão
  // única: slug é permanente (SPEC Parte 1 §1.5), então no dia em que a rota
  // existir o endereço já pode ser de uma barbearia — e aí não há o que fazer.
  // Nenhuma delas é nome que uma barbearia de verdade usaria.
  app: 'reserva de convenção, sem rota hoje',
  static: 'reserva de convenção: nome usual de prefixo de arquivo estático',
  assets: 'reserva de convenção, pelo mesmo motivo de `static`',
};

/**
 * Os segmentos de primeiro nível que o site ocupa.
 *
 * Deriva da **pasta**, e não de quem tem `page.tsx`, por causa do `ir`: ele não
 * tem página própria, só `ir/[slug]/route.ts`. Quem derivasse de "pasta com
 * página" perderia o `ir` em silêncio — e ali a colisão nem é a home, são as
 * sub-páginas (`/ir/agendar`, `/ir/entrar`) sumindo de uma barbearia que ainda
 * enxerga a própria página inicial.
 */
function rotasDoWeb() {
  const rotas = [];
  for (const entrada of readdirSync(APP, { withFileTypes: true })) {
    if (!entrada.isDirectory()) continue;
    const nome = entrada.name;

    // `[slug]` é a página da barbearia. O dinâmico é o que a lista protege, não
    // o que ela reserva.
    if (nome.startsWith('[')) continue;

    // Grupo de rota `(x)`, rota paralela `@x` e pasta privada `_x` mudam o que
    // vira segmento na URL, e nenhuma existe hoje. Tratá-las agora seria código
    // que ninguém executa; ignorá-las seria a falha calada que este arquivo
    // existe para impedir — um `(marketing)/precos/page.tsx` põe `precos` no
    // primeiro nível sem passar por aqui. Então a guarda para e pede socorro.
    if (/^[(@_]/.test(nome)) {
      throw new Error(
        `apps/web/src/app/${nome}: esta guarda só sabe ler pasta comum e ` +
          `segmento dinâmico. Grupo de rota, rota paralela e pasta privada mudam ` +
          `quais nomes chegam ao primeiro nível da URL — ensine-a a ler este caso ` +
          `antes de seguir, porque ignorá-lo deixa uma rota fora de SLUGS_RESERVADOS.`,
      );
    }

    rotas.push(nome);
  }
  return rotas.sort();
}

/** `export const SLUGS_RESERVADOS: ReadonlySet<string> = new Set([...])` */
function reservadosDeclarados() {
  const fonte = readFileSync(FONTE, 'utf8');
  const bloco = fonte.match(/export const SLUGS_RESERVADOS[^=]*=\s*new Set\(\[([^\]]*)\]/);
  if (!bloco) throw new Error(`não achei SLUGS_RESERVADOS em ${FONTE}`);
  // O bloco é comentado por dentro, e comentário não é entrada da lista.
  const semComentario = bloco[1].replace(/\/\/[^\n]*/g, '');
  return [...semComentario.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** A comparação, isolada para que o caso vermelho use exatamente a mesma. */
function faltamNaLista(rotas, reservados) {
  const tem = new Set(reservados);
  return rotas.filter((rota) => !tem.has(rota));
}

describe('rota de primeiro nível × slug reservado', () => {
  it('a varredura enxerga os dois lados', () => {
    // Varredura que não acha nada passa verde por não ter olhado — e este teste
    // inteiro depende de duas leituras de disco e de um regex sobre fonte.
    expect(rotasDoWeb().length).toBeGreaterThan(0);
    expect(reservadosDeclarados().length).toBeGreaterThan(0);
    // Está lendo `app/`, e não uma pasta qualquer que também tem subpastas.
    expect(rotasDoWeb()).toContain('admin');
  });

  it('toda rota do site está reservada como slug', () => {
    expect(
      faltamNaLista(rotasDoWeb(), reservadosDeclarados()),
      'rota de primeiro nível que uma barbearia ainda pode registrar como slug. ' +
        'Ela entra em SLUGS_RESERVADOS (packages/core/src/slug.ts) — senão o Next ' +
        'serve a rota no lugar da página da barbearia, sem erro nenhum, e o dono ' +
        'só descobre pelo cliente que não conseguiu agendar.',
    ).toEqual([]);
  });

  it('toda reserva sem pasta tem o motivo escrito', () => {
    const rotas = new Set(rotasDoWeb());
    const orfas = reservadosDeclarados().filter((r) => !rotas.has(r) && !SEM_PASTA[r]);
    expect(
      orfas,
      'reserva que não corresponde a rota nenhuma e não está em SEM_PASTA. ' +
        'Ou ela sai da lista, ou entra lá com o motivo — reserva sem motivo é ' +
        'endereço tirado da barbearia sem que ninguém saiba dizer por quê.',
    ).toEqual([]);
  });

  it('a lista não reserva a própria barbearia', () => {
    // `[slug]` é a página pública. Se a derivação passasse a devolvê-lo — ou o
    // `slug` sem colchete — a guarda começaria a exigir a reserva do que ela
    // existe para proteger.
    expect(rotasDoWeb()).not.toContain('[slug]');
    expect(rotasDoWeb()).not.toContain('slug');
  });

  it('a conferência acusa a rota que não está na lista', () => {
    // Guarda que não fica vermelha não guarda nada. É o defeito real, na forma
    // em que ele existiu: `plataforma` no disco e ausente da lista.
    expect(faltamNaLista(['admin', 'plataforma'], ['admin'])).toEqual(['plataforma']);
    expect(faltamNaLista(['admin'], ['admin'])).toEqual([]);
  });
});
