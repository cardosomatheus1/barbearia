import { semTenant } from '@barbearia/db';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';

/**
 * Recursos ligáveis por barbearia (bloco 26, SPEC Parte 1 §1.2).
 *
 * ## O que impede isto de virar um painel de interruptores que não ligam nada
 *
 * O catálogo é semeado por migração e o tipo abaixo é fechado. Não há tela que
 * crie recurso, e não há como declarar um código que o código não conheça — que
 * é exatamente como um sistema acaba com trinta flags das quais quatro fazem
 * alguma coisa.
 *
 * Cada um dos três primeiros tem consumidor de verdade desde o bloco 26: `fila`
 * e `importacao` são cobrados na guarda de permissão da API, e `avisos` no
 * worker, antes de gastar mensagem.
 *
 * ## O quarto é de outra natureza, e a diferença está escrita
 *
 * `fila`, `importacao` e `avisos` são **conteúdo de plano**: é o que faz o
 * Starter e o Business custarem diferente. `fiscal` não é isso — é um recurso
 * que ainda não estreou, e que a plataforma liga uma conta de cada vez enquanto
 * não há emissor contratado. Por isso ele nasce `false` no catálogo e **não**
 * entra em `plan_features`: só a linha de `tenant_features` que o toggle do
 * Super Admin escreve o liga.
 *
 * A tela do painel não fica com um item marcado "em breve", e essa é a
 * diferença para a convenção de *gatilho que ainda não funciona aparece
 * marcado, nunca escondido*: aquela regra é sobre o que **a barbearia** liga.
 * Quando quem decide é a plataforma, o recurso desligado não existe para o
 * outro lado — é a mesma razão de a guarda responder 404 e não 403.
 *
 * ## Três níveis, e o mais específico ganha (bloco 27)
 *
 * - `feature_flags.default_enabled` — o recurso vale para quem o plano não
 *   menciona? É o padrão de fábrica.
 * - `plan_features` — o plano contratado inclui? É o que dá conteúdo à tabela
 *   de preços: sem isto, Starter e Business custam diferente e entregam igual.
 * - `tenant_features` — decidimos algo para **esta** conta? Vence os dois, e é
 *   como o suporte concede cortesia sem mexer no plano de ninguém.
 *
 * `tenant_features` só guarda a **exceção**. Uma linha por barbearia por
 * recurso desde o começo repetiria mil vezes o que os dois níveis acima já
 * dizem — e mudar o padrão deixaria de mudar coisa alguma.
 */

export const RECURSOS = ['fila', 'importacao', 'avisos', 'fiscal'] as const;
export type CodigoDeRecurso = (typeof RECURSOS)[number];

export const ehRecurso = (valor: string): valor is CodigoDeRecurso =>
  (RECURSOS as readonly string[]).includes(valor);

export interface Recurso {
  readonly code: CodigoDeRecurso;
  readonly nome: string;
  readonly descricao: string;
  readonly padrao: boolean;
  /** Quantas barbearias fugiram do padrão. É o que diz se o recurso é polêmico. */
  readonly excecoes: number;
}

export interface RecursoDaBarbearia {
  readonly code: CodigoDeRecurso;
  readonly nome: string;
  readonly descricao: string;
  readonly ligado: boolean;
  /** Falso quando o valor vem do catálogo, e não de uma decisão sobre esta conta. */
  readonly proprio: boolean;
  /** O plano contratado inclui este recurso? É o que a tela precisa para dizer
   *  "cortesia" em vez de deixar parecer que o cliente está pagando por ele. */
  readonly noPlano: boolean;
}

interface LinhaDeCatalogo {
  code: string;
  name: string;
  description: string;
  default_enabled: boolean;
  excecoes: bigint;
}

export async function listarRecursos(): Promise<readonly Recurso[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeCatalogo[]>`
      SELECT f.code, f.name, f.description, f.default_enabled,
             count(tf.tenant_id) FILTER (WHERE tf.enabled <> f.default_enabled)::bigint AS excecoes
      FROM feature_flags f
      LEFT JOIN tenant_features tf ON tf.flag_code = f.code
      GROUP BY f.code, f.name, f.description, f.default_enabled
      ORDER BY f.name
    `;
    return linhas.filter((l) => ehRecurso(l.code)).map((l) => ({
      code: l.code as CodigoDeRecurso,
      nome: l.name,
      descricao: l.description,
      padrao: l.default_enabled,
      excecoes: Number(l.excecoes),
    }));
  });
}

interface LinhaDeRecursoDoTenant {
  code: string;
  name: string;
  description: string;
  ligado: boolean;
  proprio: boolean;
  no_plano: boolean;
}

/**
 * Os recursos de uma barbearia, com a origem de cada resposta.
 *
 * Uma consulta, com `LEFT JOIN` e `COALESCE`. Ler o catálogo e depois as
 * exceções seriam duas idas ao banco numa pergunta feita a cada requisição do
 * painel.
 */
export async function recursosDaBarbearia(
  tenantId: string,
): Promise<readonly RecursoDaBarbearia[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeRecursoDoTenant[]>`
      SELECT f.code, f.name, f.description,
             COALESCE(tf.enabled, pf.plan_code IS NOT NULL OR f.default_enabled) AS ligado,
             tf.tenant_id IS NOT NULL AS proprio,
             pf.plan_code IS NOT NULL AS no_plano
      FROM feature_flags f
      LEFT JOIN subscriptions s ON s.tenant_id = ${tenantId}::uuid
      LEFT JOIN plan_features pf ON pf.flag_code = f.code AND pf.plan_code = s.plan_code
      LEFT JOIN tenant_features tf
        ON tf.flag_code = f.code AND tf.tenant_id = ${tenantId}::uuid
      ORDER BY f.name
    `;
    return linhas.filter((l) => ehRecurso(l.code)).map((l) => ({
      code: l.code as CodigoDeRecurso,
      nome: l.name,
      descricao: l.description,
      ligado: l.ligado,
      proprio: l.proprio,
      noPlano: l.no_plano,
    }));
  });
}

/**
 * Está ligado?
 *
 * Mínima de propósito: roda em toda requisição de rota marcada e antes de todo
 * aviso enviado. Devolver a lista inteira aqui seria trabalho jogado fora no
 * caminho mais quente — a mesma decisão de `bloqueioDaBarbearia`.
 *
 * **Recurso desconhecido responde ligado.** É o único padrão seguro: um código
 * digitado errado numa rota nova derrubaria a rota em produção sem nada
 * vermelho no caminho. O tipo fechado já impede o engano em tempo de compilação.
 */
export async function recursoLigado(
  tenantId: string,
  code: CodigoDeRecurso,
): Promise<boolean> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ ligado: boolean }[]>`
      SELECT COALESCE(
               tf.enabled,
               pf.plan_code IS NOT NULL OR f.default_enabled
             ) AS ligado
      FROM feature_flags f
      LEFT JOIN subscriptions s ON s.tenant_id = ${tenantId}::uuid
      LEFT JOIN plan_features pf ON pf.flag_code = f.code AND pf.plan_code = s.plan_code
      LEFT JOIN tenant_features tf
        ON tf.flag_code = f.code AND tf.tenant_id = ${tenantId}::uuid
      WHERE f.code = ${code}
    `;
    return linhas[0]?.ligado ?? true;
  });
}

/**
 * Liga ou desliga para uma barbearia.
 *
 * Grava a exceção mesmo quando o valor coincide com o padrão. Parece
 * desperdício e não é: "esta barbearia foi analisada e ficou ligada" é
 * diferente de "ninguém olhou", e mudar o padrão depois não pode reverter uma
 * decisão que alguém tomou olhando para a conta.
 */
export async function definirRecurso(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
  readonly code: CodigoDeRecurso;
  readonly ligado: boolean;
}): Promise<void> {
  await semTenant(async (tx) => {
    const existe = await tx.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM tenant_platform WHERE tenant_id = ${entrada.tenantId}::uuid
    `;
    if (existe.length === 0) {
      throw new PlataformaError('unknown_tenant', 'Barbearia não encontrada');
    }

    await tx.$executeRaw`
      INSERT INTO tenant_features (tenant_id, flag_code, enabled, changed_at)
      VALUES (${entrada.tenantId}::uuid, ${entrada.code}, ${entrada.ligado}, now())
      ON CONFLICT (tenant_id, flag_code) DO UPDATE
        SET enabled = EXCLUDED.enabled, changed_at = now()
    `;

    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'tenant.feature_changed', {
      recurso: entrada.code,
      ligado: entrada.ligado,
    });
  });
}
