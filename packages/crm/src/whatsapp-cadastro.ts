import { withTenant, type TransactionClient } from '@barbearia/db';
import { type EstadoDoWhatsApp, type WhatsAppProvider } from '@barbearia/core';
import { audit, cifrarCom, decifrarCom } from '@barbearia/identity';
import { recusar } from './whatsapp-erros.js';

/**
 * A chave do token do WhatsApp é **própria**, não a do segundo fator.
 *
 * Uma por finalidade: com uma só, girar a chave do segundo fator — operação
 * normal de segurança — deixaria ilegível o token de todas as barbearias ao
 * mesmo tempo, e o defeito apareceria como "a mensagem parou de sair" dias
 * depois. É o precedente do segredo próprio do webhook da Stripe.
 */
const CHAVE_DO_TOKEN = 'WHATSAPP_TOKEN_KEY';

/**
 * WhatsApp oficial, do banco para a Meta (bloco 55, SPEC §4.12).
 *
 * ## Por que mora em `crm`
 *
 * O canal é conversa com o cliente, que é o assunto deste pacote — e ele já
 * depende de `jobs` (por `enfileirar`) e de `identity` (por `audit`), que são
 * exatamente as duas coisas que o WhatsApp precisa. Um pacote próprio importaria
 * os mesmos dois e acrescentaria uma seta ao grafo para não fazer nada novo.
 *
 * ## O que ele não faz
 *
 * Não cancela agendamento. O botão "Cancelar" que o cliente toca vira uma linha
 * em `whatsapp_inbound` e uma tarefa na fila; quem mexe na agenda é
 * `packages/scheduling`, pela função injetada no `Contexto` do worker. A seta
 * não volta — é o mesmo desenho de `varrerRetencao`.
 */

export interface CadastroDoWhatsApp {
  readonly estado: EstadoDoWhatsApp;
  readonly phoneNumberId: string | null;
  readonly wabaId: string | null;
  readonly numeroVisivel: string | null;
  readonly motivo: string | null;
  readonly verificadoEm: string | null;
  /**
   * **Se** existe token, nunca qual é.
   *
   * A tela precisa dizer "o token está salvo" e oferecer trocá-lo; devolver o
   * valor faria toda abertura da tela de configurações mandar uma credencial
   * viva pela rede, para dentro de um HTML que fica no histórico do navegador.
   */
  readonly temToken: boolean;
  /**
   * As permissões que a Meta concedeu a este token, ou `null` (bloco 88).
   *
   * **Obrigatório e não opcional**, e a polaridade é o motivo: `escopos?` chega
   * `undefined` na primeira consulta que esquecer dele, e a tela leria isso
   * como "não dá para dizer" — calando o aviso justamente onde ele importa, com
   * o compilador satisfeito. É a regra do campo novo num tipo que decide
   * visibilidade, e aqui o silêncio é o erro caro.
   *
   * Nomes crus da Meta, não um booleano: quem os interpreta é
   * `podeGerenciarTemplates`, em `core`, e a pergunta seguinte se responde lá
   * sem migração.
   */
  readonly escopos: readonly string[] | null;
}

const NUMERO_DA_META = /^[0-9]{5,32}$/;

export async function cadastroDoWhatsApp(
  tenantId: string,
  locationId: string,
  tx?: TransactionClient,
): Promise<CadastroDoWhatsApp | null> {
  const dentro = async (t: TransactionClient) => {
    const linhas = await t.$queryRaw<
      {
        status: EstadoDoWhatsApp;
        phone_number_id: string | null;
        waba_id: string | null;
        display_phone: string | null;
        status_reason: string | null;
        verified_at: Date | null;
        tem_token: boolean;
        granted_scopes: string[] | null;
      }[]
    >`
      SELECT status::text AS status, phone_number_id, waba_id, display_phone,
             status_reason, verified_at, granted_scopes,
             (access_token_cipher IS NOT NULL) AS tem_token
        FROM whatsapp_settings
       WHERE location_id = ${locationId}::uuid
    `;
    const linha = linhas[0];
    if (!linha) return null;
    return {
      estado: linha.status,
      phoneNumberId: linha.phone_number_id,
      wabaId: linha.waba_id,
      numeroVisivel: linha.display_phone,
      motivo: linha.status_reason,
      verificadoEm: linha.verified_at?.toISOString() ?? null,
      temToken: linha.tem_token,
      escopos: linha.granted_scopes,
    };
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

/**
 * Salva o cadastro, cifrando o token.
 *
 * O token é opcional na entrada e **ausente significa "não mexa"**: a tela não
 * o devolve, então ela não pode reenviá-lo, e escrever `null` por omissão
 * apagaria a credencial toda vez que alguém corrigisse o número visível. É a
 * mesma regra de campo opcional que o bloco 37 escreveu.
 */
export async function salvarCadastroDoWhatsApp(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly numeroVisivel: string | null;
  readonly token?: string | null;
  /**
   * O que a Meta concedeu, quando quem chama falou com ela (bloco 88).
   *
   * Opcional aqui e obrigatório na leitura, e os dois estão certos: o
   * formulário do bloco 55 é o caminho de quem já tem os ids e **nunca** fala
   * com a Meta, então ele não tem o que declarar. Ausente é "não mexa", como o
   * token — escrever `null` por omissão apagaria o que o Embedded Signup
   * descobriu toda vez que alguém corrigisse o número visível pela tela.
   */
  readonly escopos?: readonly string[] | null;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<CadastroDoWhatsApp> {
  if (!NUMERO_DA_META.test(params.phoneNumberId) || !NUMERO_DA_META.test(params.wabaId)) {
    recusar('numero_invalido');
  }

  const cifrado = params.token ? cifrarCom(CHAVE_DO_TOKEN, params.token) : null;

  return withTenant(params.tenantId, async (tx) => {
    const antes = await cadastroDoWhatsApp(params.tenantId, params.locationId, tx);

    /**
     * O estado sai do que existe, e não do corpo da requisição.
     *
     * Deixar a tela mandar `ativo` faria "está ativo?" ser uma opinião do
     * cliente HTTP. Com token e ids, o cadastro entra em `aguardando_verificacao`
     * — quem o promove a `ativo` é a Meta respondendo, pela conciliação.
     *
     * ## Salvar não rebaixa o que já foi provado (bloco 91)
     *
     * A versão anterior escrevia `aguardando_verificacao` **sempre** que houvesse
     * token. Com isso, trocar o token de um canal ativo — rotação de credencial,
     * que é operação normal de segurança — devolvia a barbearia para "falta
     * confirmar o número", com `verified_at` preenchido na mesma linha. Os dois
     * campos passavam a discordar sobre o mesmo fato, e a tela mandava a pessoa
     * repetir um passo que ela já tinha feito.
     *
     * Aconteceu em produção: a conciliação promoveu às 15:00, o dono salvou o
     * token permanente às 15:0X, e o painel voltou a dizer que faltava verificar.
     *
     * A escada respeita o que existe: sem token não há cadastro; `suspenso` é
     * decisão da Meta e salvar não a desfaz — quem sai dela é a conciliação, que
     * é a única que fala com ela; posse já provada continua provada, porque
     * `verified_at` é um fato do passado e não muda por alguém colar um token
     * novo.
     */
    const temToken = cifrado !== null || (antes?.temToken ?? false);
    const estado: EstadoDoWhatsApp = !temToken
      ? 'nao_configurado'
      : antes?.estado === 'suspenso'
        ? 'suspenso'
        : antes?.verificadoEm
          ? 'ativo'
          : 'aguardando_verificacao';

    // A unidade vem do servidor, mas a conferência sob RLS fica: a chave
    // estrangeira aceita a de outra barbearia, porque a checagem referencial
    // ignora row security.
    const escopos = params.escopos === undefined ? null : (params.escopos as string[] | null);

    /**
     * O motivo vai **na linha proposta**, e não só no `DO UPDATE` (bloco 91).
     *
     * `ON CONFLICT` trata violação de índice único; a `CHECK` é avaliada na
     * linha que o `INSERT` propõe, **antes** de o conflito ser detectado. Com
     * `status_reason` fora da lista de colunas, um cadastro suspenso chegava à
     * `CHECK` como suspenso-sem-motivo e morria ali — o `DO UPDATE` que
     * preservaria o motivo nunca era alcançado.
     *
     * Levou uma reprodução em psql para achar: a mensagem do Postgres aponta a
     * constraint e o `DETAIL` mostra a linha do `INSERT`, com `created_at` igual
     * a `updated_at` — que é a pista de que não é a linha atualizada.
     */
    const motivo = estado === 'suspenso' ? (antes?.motivo ?? null) : null;

    const gravadas = await tx.$executeRaw`
      INSERT INTO whatsapp_settings
        (location_id, tenant_id, status, phone_number_id, waba_id, display_phone,
         access_token_cipher, granted_scopes, status_reason, updated_by)
      SELECT ${params.locationId}::uuid,
             NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${estado}::whatsapp_status,
             ${params.phoneNumberId}, ${params.wabaId}, ${params.numeroVisivel},
             ${cifrado}, ${escopos}::text[], ${motivo}, ${params.staffId}::uuid
       WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)
      ON CONFLICT (location_id) DO UPDATE SET
        status = EXCLUDED.status,
        phone_number_id = EXCLUDED.phone_number_id,
        waba_id = EXCLUDED.waba_id,
        display_phone = EXCLUDED.display_phone,
        -- Ausente é "não mexa": COALESCE mantém o que já estava.
        access_token_cipher = COALESCE(EXCLUDED.access_token_cipher,
                                       whatsapp_settings.access_token_cipher),
        -- Mesma regra, e pelo mesmo motivo: quem salva pelo formulário não fala
        -- com a Meta e não tem escopo a declarar. Sobrescrever com nulo faria
        -- corrigir o número visível apagar o que o Embedded Signup descobriu.
        granted_scopes = COALESCE(EXCLUDED.granted_scopes,
                                  whatsapp_settings.granted_scopes),
        -- Quem decidiu o motivo foi a linha proposta, acima: suspenso conserva o
        -- que estava, e todo outro estado o limpa. Motivo velho ao lado de um
        -- cadastro que voltou a funcionar é a tela explicando uma falha que já
        -- passou.
        status_reason = EXCLUDED.status_reason,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
    `;
    if (gravadas === 0) recusar('nao_configurado');

    /**
     * A rota do número **anterior** sai (bloco 88).
     *
     * `whatsapp_settings` é por unidade e o `ON CONFLICT (location_id)` acima
     * sobrescreve a linha inteira, então trocar de número deixava a linha velha
     * de `whatsapp_numbers` órfã — apontando para esta barbearia, para sempre,
     * por um `phone_number_id` que já não é dela.
     *
     * Hoje isso é estado morto; no dia em que a Meta reciclar aquele id para
     * outra empresa, o webhook dela cai aqui dentro: telefone e texto de
     * cliente alheio gravados sob o nosso tenant, que é exatamente o vazamento
     * que o `WHERE` de dono logo abaixo existe para impedir — na direção
     * contrária. Uma barbearia trocando de conta da Meta é o caminho normal
     * depois de um bloqueio, não caso raro.
     *
     * Sem `tenant_id` no `WHERE`: a política de remoção da 0078 é quem filtra, e
     * repeti-la aqui mascararia política ausente.
     *
     * O `location_id`, ao contrário, **não** é defesa repetida — ele é a regra.
     * Numa rede, a unidade que assumiu o número antigo da outra é dona legítima
     * daquela linha: sem o filtro, a matriz reconectando com um número novo
     * apagaria a rota da filial que ficou com o velho, e o webhook da filial
     * passaria a chegar sem dono. Trocar de número entre unidades é raro; ficar
     * sem receber mensagem por causa disso não teria explicação nenhuma na tela.
     */
    if (antes?.phoneNumberId && antes.phoneNumberId !== params.phoneNumberId) {
      await tx.$executeRaw`
        DELETE FROM whatsapp_numbers
         WHERE phone_number_id = ${antes.phoneNumberId}
           AND location_id = ${params.locationId}::uuid
      `;
    }

    if (antes?.wabaId && antes.wabaId !== params.wabaId) {
      await tx.$executeRaw`
        DELETE FROM whatsapp_wabas
         WHERE waba_id = ${antes.wabaId}
           AND location_id = ${params.locationId}::uuid
      `;
      await tx.$executeRaw`
        DELETE FROM whatsapp_waba_owners o
         WHERE o.waba_id = ${antes.wabaId}
           AND o.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           AND NOT EXISTS (SELECT 1 FROM whatsapp_wabas r WHERE r.waba_id = o.waba_id)
      `;
    }

    /**
     * A rota do webhook, em dia com o cadastro.
     *
     * Sem esta linha o webhook da Meta chegaria com um `phone_number_id` que
     * ninguém sabe de quem é — e sem tenant não há como ler nada que tenha RLS.
     * Mora na mesma transação do cadastro porque as duas coisas são o mesmo
     * fato: este número é desta barbearia.
     */
    /**
     * A sobrescrita é condicionada à dona da linha.
     *
     * Sem o `WHERE`, a segunda barbearia a reivindicar o mesmo
     * `phone_number_id` **levava o roteamento** — e com ele o telefone e o texto
     * que os clientes da primeira escrevem, que passavam a ser gravados sob o
     * tenant de quem tomou. A política da migração 0078 é a camada que
     * sobrevive a uma reescrita deste arquivo; esta é a que produz a frase.
     *
     * A recusa tem a **mesma mensagem** de qualquer outra falha de gravação:
     * "este número é de outra barbearia" confirmaria o id para quem o adivinhou,
     * e é o precedente do OTP, que responde igual para telefone existente e
     * inexistente.
     */
    const roteamento = await tx.$executeRaw`
      INSERT INTO whatsapp_numbers (phone_number_id, tenant_id, location_id)
      VALUES (${params.phoneNumberId},
              NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${params.locationId}::uuid)
      ON CONFLICT (phone_number_id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        location_id = EXCLUDED.location_id
      WHERE whatsapp_numbers.tenant_id
            = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    `;
    if (roteamento === 0) {
      recusar('numero_indisponivel');
    }


    const donaDaWaba = await tx.$executeRaw`
      INSERT INTO whatsapp_waba_owners (waba_id, tenant_id)
      VALUES (${params.wabaId}, NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      ON CONFLICT (waba_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
       WHERE whatsapp_waba_owners.tenant_id
             = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    `;
    if (donaDaWaba === 0) recusar('numero_indisponivel');

    const rotaDaWaba = await tx.$executeRaw`
      INSERT INTO whatsapp_wabas (waba_id, tenant_id, location_id)
      VALUES (${params.wabaId},
              NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${params.locationId}::uuid)
      ON CONFLICT (waba_id, location_id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id
      WHERE whatsapp_wabas.tenant_id
            = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    `;
    if (rotaDaWaba === 0) recusar('numero_indisponivel');

    /**
     * Auditado, e a trilha guarda **se** o token mudou, nunca o token.
     *
     * É o precedente do CPF no bloco 54: `audit_log` é append-only e legível por
     * quem administra a casa — uma credencial ali seria um segredo em repouso
     * que nenhuma limpeza alcança.
     */
    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'whatsapp.settings_changed',
      entity: 'whatsapp_settings',
      entityId: params.locationId,
      ...(antes ? { before: { estado: antes.estado, temToken: antes.temToken } } : {}),
      after: { estado, temToken, phoneNumberId: params.phoneNumberId },
    });

    const salvo = await cadastroDoWhatsApp(params.tenantId, params.locationId, tx);
    if (!salvo) recusar('nao_configurado');
    return salvo;
  });
}

/**
 * Pergunta à Meta se a posse do número já foi provada, e promove (bloco 90).
 *
 * ## O estado que nunca chegava
 *
 * `whatsapp_settings.status` nascia em `aguardando_verificacao` desde o bloco
 * 55, e a única escrita depois disso era `suspenso`. **Nada promovia a
 * `ativo`** — o comentário de `salvarCadastroDoWhatsApp` dizia "quem o promove
 * é a Meta respondendo, pela conciliação", e essa conciliação não existia.
 *
 * O efeito não era a mensagem parar de sair: `provedorDoWhatsApp` nunca olhou
 * status, então o canal funcionava. Era pior de diagnosticar — o checklist da
 * tela lê `estado === 'ativo'` e ficava para sempre em "Passo 1: conectar o
 * número da barbearia", com o número conectado e mandando mensagem. Indicador
 * que nunca preenche é a §6 pergunta 5, e ensina quem opera a não olhar.
 *
 * ## Por que perguntar, e não deduzir
 *
 * Registrar o número na Cloud API e **provar a posse dele** são passos
 * diferentes: o segundo é a pessoa digitando, no painel da Meta, o código que
 * chega por SMS — fora do produto, minutos ou horas depois de conectar. Deduzir
 * `ativo` do registro bem-sucedido marcaria como pronto um cadastro que ainda
 * não pode receber nada.
 *
 * ## Só a prova da Meta sobe para ativo
 *
 * `aguardando_verificacao` é o caminho normal e `suspenso` também pode voltar
 * quando a própria Meta volta a provar a posse. Isso é necessário porque um
 * `ACCOUNT_RECONNECTED` pode chegar depois de um offboarding; deixar a
 * conciliação aceitar apenas o primeiro estado tornaria a suspensão permanente.
 * Uma resposta não verificada nunca altera estado nem apaga o motivo.
 */
export async function conciliarNumero(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly provider: WhatsAppProvider;
  readonly agora: Date;
}): Promise<{ readonly verificado: boolean; readonly promovido: boolean }> {
  const estado = await params.provider.consultarNumero();
  if (!estado.verificado) return { verificado: false, promovido: false };

  const promovidas = await withTenant(params.tenantId, async (tx) => {
    return tx.$executeRaw`
      UPDATE whatsapp_settings
         SET status = 'ativo',
             verified_at = ${params.agora},
             -- O número como a Meta o escreve vence o que foi digitado à mão,
             -- e ausente é "não mexa", como em todo campo opcional daqui.
             display_phone = COALESCE(${estado.numeroVisivel}, display_phone),
             updated_at = now()
       WHERE location_id = ${params.locationId}::uuid
         AND status IN ('aguardando_verificacao', 'suspenso')
    `;
  });

  return { verificado: true, promovido: promovidas > 0 };
}

/**
 * O token decifrado, para quem vai falar com a Meta.
 *
 * Não é exportado para a API: só o worker e o envio o chamam. A tela nunca
 * recebe o valor — `cadastroDoWhatsApp` devolve `temToken` e mais nada.
 */
async function tokenDaUnidade(tenantId: string, locationId: string): Promise<string> {
  const cifrado = await withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ access_token_cipher: string | null }[]>`
      SELECT access_token_cipher FROM whatsapp_settings
       WHERE location_id = ${locationId}::uuid AND status = 'ativo'
    `;
    return linhas[0]?.access_token_cipher ?? null;
  });
  if (!cifrado) recusar('nao_configurado');
  try {
    return decifrarCom(CHAVE_DO_TOKEN, cifrado);
  } catch {
    // Chave de ambiente trocada, ou linha corrompida. Recusar alto é o certo:
    // seguir com token vazio produziria erro da Meta em toda mensagem.
    recusar('token_invalido');
  }
}

export { tokenDaUnidade as tokenDoWhatsApp };
