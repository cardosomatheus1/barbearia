import { createHash } from 'node:crypto';
import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  analisar,
  aplicaveis,
  detectarColunas,
  lerCsv,
  type Analise,
  type Colunas,
  type LinhaAnalisada,
  type Veredito,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';

/**
 * A importação de base, do arquivo ao banco — SPEC §5.8.
 *
 * A regra é toda de `packages/core` e roda sem banco. Aqui mora o que precisa
 * dele: quem já existe, o que gravar, e como desfazer.
 *
 * ## Dois passos, e o do meio guarda pouco
 *
 * A SPEC exige preview antes de aplicar. Entre um passo e outro, o que fica
 * guardado são **só os quatro campos que viram cliente** — nunca o CSV inteiro,
 * que costuma trazer CPF, endereço e nome da mãe do sistema antigo. E some
 * assim que a importação é aplicada: a partir daí o dado mora em `customers`, e
 * a cópia seria uma segunda base de dado pessoal para vazar.
 *
 * ## O que a importação nunca faz
 *
 * **Não liga consentimento de marketing.** Nenhuma coluna do arquivo pode
 * fazê-lo, e não é rigor gratuito: consentimento precisa de data, IP e versão do
 * texto (CLAUDE.md §2), e nada disso atravessa uma exportação. Sem isso, importar
 * mil e duzentos clientes e disparar mil e duzentas mensagens de "sentimos sua
 * falta" no primeiro dia — o erro que a SPEC §5.8 nomeia — deixa de ser possível
 * por construção, não por lembrança: a varredura de retorno filtra
 * `accepts_marketing`, e o importado entra com ele falso.
 */

export interface ResumoDaImportacao {
  readonly id: string;
  readonly fileName: string;
  readonly separator: string;
  readonly status: 'previewed' | 'applied' | 'reverted';
  readonly resumo: Readonly<Record<Veredito, number>>;
  readonly total: number;
  readonly createdAt: string;
  readonly appliedAt: string | null;
  readonly revertedAt: string | null;
}

export interface Preview extends ResumoDaImportacao {
  readonly cabecalho: readonly string[];
  readonly colunas: Colunas;
  /** Uma amostra do que precisa de olho humano, não a base inteira na tela. */
  readonly problemas: readonly LinhaAnalisada[];
  /** Verdadeiro quando este arquivo já tinha sido enviado antes. */
  readonly repetida: boolean;
}

export type ImportacaoErro =
  | 'csv_invalido'
  | 'sem_coluna_de_nome'
  | 'sem_coluna_de_telefone'
  | 'arquivo_vazio'
  | 'nao_encontrada'
  | 'ja_aplicada'
  | 'nao_aplicada'
  | 'tem_movimento';

export class ImportacaoError extends Error {
  constructor(
    readonly code: ImportacaoErro,
    readonly detalhe?: Readonly<Record<string, number>>,
  ) {
    super(`Importação: ${code}`);
    this.name = 'ImportacaoError';
  }
}

/** Teto de linhas por arquivo. Acima disso a barbearia parte a exportação. */
export const TETO_DE_LINHAS = 20_000;

const AMOSTRA_DE_PROBLEMAS = 50;

interface LinhaGravavel {
  readonly nome: string;
  readonly telefone: string;
  readonly nascimento: string | null;
  readonly observacao: string | null;
  readonly novo: boolean;
}

const paraGravar = (linha: LinhaAnalisada): LinhaGravavel => ({
  nome: linha.nome,
  telefone: linha.telefone,
  nascimento: linha.nascimento,
  observacao: linha.observacao,
  novo: linha.veredito === 'novo',
});

/**
 * O que fica guardado entre conferir e aplicar.
 *
 * As duas metades vivem juntas porque somem juntas: `payload` é apagado ao
 * aplicar, e é o banco que recusa o contrário. Os `problemas` estão aqui — e
 * não recalculados na hora de mostrar — porque a tela redireciona depois do
 * envio, e o arquivo não existe mais do outro lado do redirecionamento.
 */
interface Guardado {
  readonly linhas: readonly LinhaGravavel[];
  readonly problemas: readonly LinhaAnalisada[];
}

/**
 * Os telefones que a barbearia já tem.
 *
 * Uma consulta, não uma por linha: com mil e duzentos clientes no arquivo, a
 * versão N+1 são mil e duzentas idas ao banco para responder o que uma responde.
 */
async function telefonesExistentes(tx: TransactionClient): Promise<Set<string>> {
  const linhas = await tx.$queryRaw<{ phone_e164: string }[]>`
    -- Filtra nulo desde o bloco 32: cadastro anonimizado tem telefone nulo, e
    -- ele não pode entrar no conjunto de deduplicação — quem foi apagado a
    -- pedido não volta porque alguém reimportou a base velha.
    SELECT phone_e164 FROM customers WHERE phone_e164 IS NOT NULL
  `;
  return new Set(linhas.map((linha) => linha.phone_e164));
}

interface LinhaDeImport {
  id: string;
  file_name: string;
  separator: string;
  status: 'previewed' | 'applied' | 'reverted';
  summary: unknown;
  created_at: Date;
  applied_at: Date | null;
  reverted_at: Date | null;
}

const zerado = (): Record<Veredito, number> => ({
  telefone_invalido: 0,
  sem_nome: 0,
  conflito: 0,
  repetido_no_arquivo: 0,
  ja_existe: 0,
  novo: 0,
});

function paraResumo(linha: LinhaDeImport): ResumoDaImportacao {
  const guardado = (linha.summary ?? {}) as Partial<Record<Veredito, number>> & { total?: number };
  const resumo = zerado();
  for (const chave of Object.keys(resumo) as Veredito[]) {
    resumo[chave] = Number(guardado[chave] ?? 0);
  }

  return {
    id: linha.id,
    fileName: linha.file_name,
    separator: linha.separator,
    status: linha.status,
    resumo,
    total: Number(guardado.total ?? 0),
    createdAt: linha.created_at.toISOString(),
    appliedAt: linha.applied_at?.toISOString() ?? null,
    revertedAt: linha.reverted_at?.toISOString() ?? null,
  };
}

/**
 * Lê o arquivo, confere contra a base e guarda o preview.
 *
 * `anoLimite` é o ano corrente **da unidade**, não do processo: é ele que decide
 * se `07/09/05` é 2005 ou 1905, e o fuso do servidor não tem opinião sobre isso.
 */
export async function analisarImportacao(params: {
  readonly tenantId: string;
  readonly staffId: string;
  readonly fileName: string;
  readonly conteudo: string;
  readonly anoLimite: number;
  readonly separador?: string | undefined;
  /** O relógio por parâmetro: o prazo do preview é regra, não `now()` do banco. */
  readonly agora: Date;
}): Promise<Preview> {
  let csv;
  try {
    csv = lerCsv(params.conteudo, params.separador);
  } catch {
    throw new ImportacaoError('csv_invalido');
  }

  if (csv.linhas.length === 0) throw new ImportacaoError('arquivo_vazio');
  if (csv.linhas.length > TETO_DE_LINHAS) {
    throw new ImportacaoError('csv_invalido', { linhas: csv.linhas.length });
  }

  const colunas = detectarColunas(csv.cabecalho);
  if (colunas.telefone === null) throw new ImportacaoError('sem_coluna_de_telefone');
  if (colunas.nome === null) throw new ImportacaoError('sem_coluna_de_nome');

  const sha = createHash('sha256').update(params.conteudo, 'utf8').digest('hex');

  return withTenant(params.tenantId, async (tx) => {
    /**
     * Preview abandonado não guarda dado pessoal para sempre.
     *
     * A limpeza pega carona aqui **e** roda na varredura diária de retenção
     * (`expirarPreviews`, abaixo). As duas, e não uma: aqui é a mais barata e
     * cobre quem volta; a varredura é a única que alcança **quem nunca mais
     * abriu a tela**, que é o caso mais provável e o único que nunca era limpo.
     *
     * O comentário anterior dizia que a tarefa por barbearia seria "maquinaria
     * demais para o problema", e o argumento tinha um furo: a barbearia que sobe
     * o CSV, olha a conferência e some deixava nome, telefone e aniversário da
     * base legada inteira — de gente que talvez nunca vire cliente — sem prazo
     * nenhum. É a mesma razão de a varredura de webhook existir mesmo com a
     * tarefa se reprogramando: o que se perde no caminho precisa de rede.
     */
    await expirarPreviews(tx, params.agora);

    // Idempotência (SPEC §5.8): o mesmo arquivo não vira duas importações. O
    // banco também recusa pelo índice único — isto é o caminho amável, que
    // devolve a importação anterior em vez de um erro de constraint.
    const anteriores = await tx.$queryRaw<LinhaDeImport[]>`
      SELECT id, file_name, separator, status, summary, created_at, applied_at, reverted_at
        FROM imports
       WHERE file_sha256 = ${sha} AND status <> 'reverted'
       LIMIT 1
    `;

    const analise = analisar({
      csv,
      colunas,
      jaExistem: await telefonesExistentes(tx),
      anoLimite: params.anoLimite,
    });

    const anterior = anteriores[0];
    if (anterior) {
      return {
        ...paraResumo(anterior),
        cabecalho: csv.cabecalho,
        colunas,
        problemas: problemasDe(analise),
        repetida: true,
      };
    }

    const guardar: Guardado = {
      linhas: aplicaveis(analise).map(paraGravar),
      problemas: problemasDe(analise),
    };
    const criadas = await tx.$queryRaw<LinhaDeImport[]>`
      INSERT INTO imports (tenant_id, file_name, file_sha256, separator, summary, payload, created_by)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.fileName}, ${sha}, ${csv.separador},
        ${JSON.stringify({ ...analise.resumo, total: analise.total })}::jsonb,
        ${JSON.stringify(guardar)}::jsonb,
        ${params.staffId}::uuid
      )
      RETURNING id, file_name, separator, status, summary, created_at, applied_at, reverted_at
    `;

    const criada = criadas[0];
    if (!criada) throw new ImportacaoError('csv_invalido');

    return {
      ...paraResumo(criada),
      cabecalho: csv.cabecalho,
      colunas,
      problemas: problemasDe(analise),
      repetida: false,
    };
  });
}

/**
 * O que a tela mostra linha a linha.
 *
 * Só o que pede decisão humana — telefone inválido, falta de nome e conflito. O
 * que vai entrar limpo é contagem, não lista: mil e duzentas linhas na tela não
 * ajudam ninguém a decidir se aplica.
 */
function problemasDe(analise: Analise): readonly LinhaAnalisada[] {
  return analise.linhas
    .filter(
      (linha) =>
        linha.veredito === 'telefone_invalido' ||
        linha.veredito === 'sem_nome' ||
        linha.veredito === 'conflito',
    )
    .slice(0, AMOSTRA_DE_PROBLEMAS);
}

export interface ResultadoDaAplicacao {
  readonly criados: number;
  readonly atualizados: number;
}

/**
 * A observação do sistema antigo vira a anotação da ficha.
 *
 * Sem isto a coluna seria lida, aparada e jogada fora — "campo que o motor
 * aceita e ninguém preenche é mentira" (CLAUDE.md §4). E o destino não é
 * inventado: `customer_preferences.observacoes` é exatamente onde "sempre
 * atrasa" mora desde o bloco 16, e é o que o barbeiro lê antes de atender.
 *
 * **Nunca sobrescreve.** Anotação escrita pelo barbeiro com o cliente na
 * cadeira vale mais que a que veio do sistema anterior; o arquivo preenche
 * quem está sem nota, e só.
 */
async function gravarObservacoes(
  tx: TransactionClient,
  guardadas: readonly LinhaGravavel[],
  gravadas: readonly { id: string; phone_e164: string }[],
  staffId: string,
): Promise<void> {
  const porTelefone = new Map(gravadas.map((linha) => [linha.phone_e164, linha.id]));

  const alvos = guardadas
    .filter((linha) => linha.observacao)
    .map((linha) => ({ id: porTelefone.get(linha.telefone), texto: linha.observacao as string }))
    .filter((alvo): alvo is { id: string; texto: string } => Boolean(alvo.id));

  if (alvos.length === 0) return;

  await tx.$executeRaw`
    INSERT INTO customer_preferences (customer_id, tenant_id, observacoes, updated_by)
    SELECT entrada.id::uuid,
           NULLIF(current_setting('app.tenant_id', true), '')::uuid,
           entrada.texto,
           ${staffId}::uuid
      FROM unnest(${alvos.map((a) => a.id)}::text[], ${alvos.map((a) => a.texto)}::text[])
             AS entrada(id, texto)
    ON CONFLICT (customer_id) DO UPDATE
       SET observacoes = COALESCE(NULLIF(btrim(customer_preferences.observacoes), ''),
                                  EXCLUDED.observacoes),
           updated_at = now()
  `;
}

/**
 * Grava o que o preview mostrou.
 *
 * Uma consulta para todas as linhas — `unnest` sobre arranjos, não um `INSERT`
 * por cliente. Com mil e duzentos clientes, a versão em laço são mil e duzentas
 * idas ao banco dentro de uma transação aberta.
 *
 * `ON CONFLICT` pelo telefone é a deduplicação contra a base já existente, e ela
 * **completa sem sobrescrever**: quem já tinha nome não passa a se chamar como o
 * sistema antigo o chamava. O arquivo preenche buraco; não corrige o que a
 * barbearia digitou depois.
 */
export async function aplicarImportacao(params: {
  readonly tenantId: string;
  readonly importId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly agora: Date;
  readonly ip?: string | undefined;
}): Promise<ResultadoDaAplicacao> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ status: string; payload: unknown; file_name: string }[]>`
      SELECT status, payload, file_name FROM imports
       WHERE id = ${params.importId}::uuid
       FOR UPDATE
    `;

    const importacao = linhas[0];
    if (!importacao) throw new ImportacaoError('nao_encontrada');
    if (importacao.status !== 'previewed') throw new ImportacaoError('ja_aplicada');

    const guardadas = ((importacao.payload ?? {}) as Partial<Guardado>).linhas ?? [];

    let criados = 0;
    let atualizados = 0;

    if (guardadas.length > 0) {
      const gravadas = await tx.$queryRaw<{ inserido: boolean; id: string; phone_e164: string }[]>`
        INSERT INTO customers (tenant_id, name, phone_e164, birth_date, import_id)
        SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
               entrada.nome, entrada.telefone, entrada.nascimento::date,
               ${params.importId}::uuid
          FROM unnest(
                 ${guardadas.map((l) => l.nome)}::text[],
                 ${guardadas.map((l) => l.telefone)}::text[],
                 ${guardadas.map((l) => l.nascimento)}::text[]
               ) AS entrada(nome, telefone, nascimento)
        ON CONFLICT (tenant_id, phone_e164) DO UPDATE
           -- Completa o que está vazio, nunca substitui o que a barbearia já
           -- sabe. E import_id fica como estava: quem já era cliente não passa
           -- a ser criação desta importação, senão desfazê-la apagaria gente
           -- que estava aqui antes.
           SET name       = CASE WHEN btrim(customers.name) = '' THEN EXCLUDED.name
                                 ELSE customers.name END,
               birth_date = COALESCE(customers.birth_date, EXCLUDED.birth_date),
               updated_at = now()
        RETURNING id, phone_e164, (xmax = 0) AS inserido
      `;

      for (const linha of gravadas) {
        if (linha.inserido) criados += 1;
        else atualizados += 1;
      }

      await gravarObservacoes(tx, guardadas, gravadas, params.staffId);
    }

    await tx.$executeRaw`
      UPDATE imports
         SET status = 'applied', applied_at = ${params.agora}, payload = NULL
       WHERE id = ${params.importId}::uuid
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'import.applied',
      entity: 'imports',
      entityId: params.importId,
      // Contagem, nunca a base: a trilha registra o que houve, não os mil e
      // duzentos nomes que entraram.
      after: { arquivo: importacao.file_name, criados, atualizados },
      ...(params.ip ? { ip: params.ip } : {}),
    });

    return { criados, atualizados };
  });
}

/**
 * Desfaz a importação inteira — SPEC §5.8, "importação errada é desfeita
 * inteira".
 *
 * Apaga **só o que ela criou**. Quem já era cliente e apenas teve o aniversário
 * preenchido continua; ele não veio do arquivo.
 *
 * **Recusa quando algum importado já se mexeu.** Cliente que já marcou horário,
 * abriu comanda ou entrou na fila deixou de ser um registro do arquivo e virou
 * gente da casa — apagá-lo levaria junto o agendamento de amanhã. A alternativa,
 * apagar só os parados, deixaria a base num meio-termo que ninguém pediu: "inteira"
 * é a palavra da SPEC, e um desfazer parcial é pior que um recusado com o motivo
 * na tela.
 */
export async function reverterImportacao(params: {
  readonly tenantId: string;
  readonly importId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly agora: Date;
  readonly ip?: string | undefined;
}): Promise<{ readonly apagados: number }> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ status: string; file_name: string }[]>`
      SELECT status, file_name FROM imports
       WHERE id = ${params.importId}::uuid
       FOR UPDATE
    `;

    const importacao = linhas[0];
    if (!importacao) throw new ImportacaoError('nao_encontrada');
    if (importacao.status !== 'applied') throw new ImportacaoError('nao_aplicada');

    const comMovimento = await tx.$queryRaw<{ quantos: bigint }[]>`
      SELECT count(*)::bigint AS quantos
        FROM customers c
       WHERE c.import_id = ${params.importId}::uuid
         AND (
           EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id = c.id)
           OR EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
           OR EXISTS (SELECT 1 FROM queue_entries q WHERE q.customer_id = c.id)
           OR EXISTS (SELECT 1 FROM customer_ledger l WHERE l.customer_id = c.id)
         )
    `;

    const presos = Number(comMovimento[0]?.quantos ?? 0);
    if (presos > 0) throw new ImportacaoError('tem_movimento', { clientes: presos });

    const apagados = await tx.$executeRaw`
      DELETE FROM customers WHERE import_id = ${params.importId}::uuid
    `;

    await tx.$executeRaw`
      UPDATE imports
         SET status = 'reverted', reverted_at = ${params.agora}
       WHERE id = ${params.importId}::uuid
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'import.reverted',
      entity: 'imports',
      entityId: params.importId,
      after: { arquivo: importacao.file_name, apagados },
      ...(params.ip ? { ip: params.ip } : {}),
    });

    return { apagados };
  });
}

/**
 * Uma importação, com o que ela deixou para conferir.
 *
 * Existe porque a tela **redireciona** depois do envio: no passo seguinte o
 * arquivo já não está em lugar nenhum, e sem isto o preview mostraria a
 * contagem sem as linhas que pedem decisão — que são justamente o motivo de o
 * passo existir.
 */
export async function lerImportacao(params: {
  readonly tenantId: string;
  readonly importId: string;
}): Promise<ResumoDaImportacao & { readonly problemas: readonly LinhaAnalisada[] }> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<(LinhaDeImport & { payload: unknown })[]>`
      SELECT id, file_name, separator, status, summary, payload,
             created_at, applied_at, reverted_at
        FROM imports
       WHERE id = ${params.importId}::uuid
    `;

    const linha = linhas[0];
    if (!linha) throw new ImportacaoError('nao_encontrada');

    const guardado = (linha.payload ?? {}) as Partial<Guardado>;
    return { ...paraResumo(linha), problemas: guardado.problemas ?? [] };
  });
}

/** As importações da barbearia, da mais recente para a mais antiga. */
export async function listarImportacoes(params: {
  readonly tenantId: string;
  readonly limite?: number;
}): Promise<readonly ResumoDaImportacao[]> {
  const limite = Math.min(Math.max(1, params.limite ?? 20), 100);

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeImport[]>`
      SELECT id, file_name, separator, status, summary, created_at, applied_at, reverted_at
        FROM imports
       ORDER BY created_at DESC
       LIMIT ${limite}
    `;
    return linhas.map(paraResumo);
  });
}

/**
 * Quantos dias um preview abandonado guarda dado pessoal.
 *
 * Sete, e o número é da mesma família do prazo de `reception_gaps`: é o
 * horizonte em que a cópia ainda **serve** — o dono subiu o arquivo, foi
 * conferir com alguém e volta na semana —, nunca o do cadastro. Guardar além
 * disso é risco sem contrapartida, e a convenção do repositório já diz que
 * cópia de dado pessoal fora de `customers` tem prazo escrito.
 */
export const DIAS_DO_PREVIEW = 7;

/**
 * Apaga o `payload` de todo preview vencido **desta** barbearia.
 *
 * Recebe a transação e não o tenant: os dois chamadores já estão dentro de uma
 * — a análise, que limpa o que a própria barbearia deixou, e a varredura diária
 * de retenção, que é a única que alcança quem nunca mais abriu a tela.
 *
 * Não apaga a **linha**: `imports` é o que torna a importação reversível por
 * `import_id`, e sem ela a base importada ficaria sem como voltar atrás. O que
 * vence é a cópia do arquivo, não o registro de que ele entrou — é a mesma
 * decisão da anonimização, que tira a pessoa de dentro do cadastro e deixa a
 * linha.
 */
export async function expirarPreviews(tx: TransactionClient, agora: Date): Promise<number> {
  return tx.$executeRaw`
    UPDATE imports
       SET payload = NULL
     WHERE status = 'previewed'
       AND payload IS NOT NULL
       AND created_at < ${agora}::timestamptz - make_interval(days => ${DIAS_DO_PREVIEW}::int)
  `;
}

/**
 * A mesma limpeza, abrindo o tenant — a porta que a varredura diária usa.
 *
 * `imports` tem RLS, então isto **não** pode ser uma varredura de plataforma:
 * sem tenant no contexto a consulta devolve zero linhas, em silêncio. É uma
 * tarefa por barbearia, como a retenção e a conciliação da nota, e ela pega
 * carona no `lgpd.retencao` que já roda todo dia com o tenant aberto — a
 * retenção do preview é retenção de dado pessoal, não um assunto novo.
 */
export async function varrerPreviewsVencidos(tenantId: string, agora: Date): Promise<number> {
  return withTenant(tenantId, (tx) => expirarPreviews(tx, agora));
}
