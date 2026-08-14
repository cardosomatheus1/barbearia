import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { semTenant, withTenant } from '@barbearia/db';
import {
  desfechoDaEntrega,
  ehDestinoInterno,
  ehEventoDeWebhook,
  ehNomeInterno,
  proximaTentativaEmSegundos,
  type EventoDeWebhook,
} from '@barbearia/core';
import { audit } from './audit.js';

/**
 * Webhooks para terceiros: cadastro, assinatura e entrega (bloco 79).
 *
 * ## Aqui o segredo é recuperável, e é o oposto da chave de API
 *
 * Quem assina somos **nós**, então o segredo precisa voltar em claro na hora de
 * assinar — cifrado com AES-256-GCM em chave de ambiente **própria**
 * (`WEBHOOK_SECRET_KEY`), como o token de WhatsApp. Na chave de API é o
 * contrário: quem apresenta o segredo é o outro lado, e por isso lá fica só o
 * HMAC.
 *
 * ## A conta da assinatura é a que já se faz do outro lado
 *
 * `t=<unix>,v1=<hmac de "instante.corpo">`, a mesma forma que este produto
 * **recebe** do adquirente desde o bloco 31. Um integrador que já sabe conferir
 * webhook da Stripe sabe conferir o nosso, e a documentação cabe num parágrafo.
 */

export type WebhookFailure =
  | 'chave_ausente'
  | 'url_invalida'
  | 'destino_interno'
  | 'evento_desconhecido'
  | 'sem_evento'
  | 'nome_curto'
  | 'endpoint_nao_encontrado';

export class WebhookError extends Error {
  constructor(
    readonly code: WebhookFailure,
    message: string,
    readonly detalhe?: string,
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

/** Quanto tempo se espera o outro lado. Além disso, é indisponibilidade. */
export const TEMPO_LIMITE_MS = 8_000;

function chave(): Buffer {
  const bruto = process.env['WEBHOOK_SECRET_KEY'];
  if (!bruto) {
    throw new WebhookError('chave_ausente', 'WEBHOOK_SECRET_KEY é obrigatória');
  }
  const bytes = Buffer.from(bruto, 'base64');
  if (bytes.length !== 32) {
    throw new WebhookError('chave_ausente', 'WEBHOOK_SECRET_KEY precisa de 32 bytes em base64');
  }
  return bytes;
}

function cifrar(claro: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chave(), iv);
  const dado = Buffer.concat([c.update(claro, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), dado.toString('base64')].join('.');
}

function decifrar(cifrado: string): string {
  const [iv, tag, dado] = cifrado.split('.');
  if (!iv || !tag || !dado) throw new WebhookError('chave_ausente', 'Segredo ilegível');
  const d = createDecipheriv('aes-256-gcm', chave(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dado, 'base64')), d.final()]).toString('utf8');
}

/**
 * A assinatura que vai no cabeçalho.
 *
 * O **instante entra na conta**, e não só o corpo: sem ele, um evento capturado
 * hoje é reenviável para sempre por quem o interceptou. É a mesma decisão do
 * webhook do adquirente, e o oposto da Meta — que assina só o corpo, e por isso
 * exige idempotência por id no banco.
 */
export function assinarEntrega(entrada: {
  readonly corpo: string;
  readonly segredo: string;
  readonly instante: number;
}): string {
  const v1 = createHmac('sha256', entrada.segredo)
    .update(`${entrada.instante}.${entrada.corpo}`)
    .digest('hex');
  return `t=${entrada.instante},v1=${v1}`;
}

export interface EndpointNaTela {
  readonly id: string;
  readonly nome: string;
  readonly url: string;
  readonly eventos: readonly EventoDeWebhook[];
  readonly ativo: boolean;
  readonly criadoEm: Date;
}

export async function endpointsDaCasa(tenantId: string): Promise<readonly EndpointNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; name: string; url: string; events: string[]; active: boolean; created_at: Date }[]
    >`
      SELECT id, name, url, events, active, created_at
        FROM webhook_endpoints ORDER BY active DESC, created_at DESC
    `;
    return linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      url: l.url,
      eventos: l.events.filter(ehEventoDeWebhook),
      ativo: l.active,
      criadoEm: l.created_at,
    }));
  });
}

/**
 * Cadastra um endereço, e devolve o segredo **uma vez**.
 *
 * Como a chave de API: ele existe uma vez fora do banco. A diferença é que aqui
 * o banco guarda o segredo cifrado, porque quem assina somos nós — e a tela
 * nunca o mostra de novo, porque devolvê-lo faria toda abertura da tela mandar
 * credencial viva pela rede.
 */
export async function cadastrarEndpoint(entrada: {
  readonly tenantId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly nome: string;
  readonly url: string;
  readonly eventos: readonly string[];
}): Promise<{ readonly id: string; readonly segredo: string }> {
  const nome = entrada.nome.trim();
  if (nome.length < 2) throw new WebhookError('nome_curto', 'O endereço precisa de um nome');

  /**
   * `https://` e nada mais, e a conferência é aqui **e** por `CHECK`.
   *
   * A assinatura prova a origem; ela não esconde o conteúdo. Um endereço `http`
   * levaria o corpo pela rede em claro — e o corpo carrega ids que abrem a API
   * pública para quem também tiver a chave.
   */
  let url: URL;
  try {
    url = new URL(entrada.url.trim());
  } catch {
    throw new WebhookError('url_invalida', 'Endereço inválido');
  }
  if (url.protocol !== 'https:') {
    throw new WebhookError('url_invalida', 'O endereço precisa começar com https://');
  }
  /**
   * O endereço não pode apontar para dentro.
   *
   * É o risco central do bloco: quem escolhe o destino é quem tem
   * `team.manage` em **qualquer** barbearia, e quem faz a chamada somos nós, de
   * dentro da nossa rede. `https://169.254.169.254/` passa por toda validação
   * de formato e busca credencial de nuvem.
   *
   * A recusa acontece aqui **e** na entrega. Aqui ela tem uma frase que
   * explica; lá ela é a guarda de verdade, porque o nome pode passar a apontar
   * para outro lugar depois do cadastro.
   */
  if (ehNomeInterno(url.hostname)) {
    throw new WebhookError('destino_interno', 'O endereço aponta para uma rede interna');
  }

  const eventos = [...new Set(entrada.eventos)];
  if (eventos.length === 0) throw new WebhookError('sem_evento', 'Escolha ao menos um evento');
  for (const evento of eventos) {
    if (!ehEventoDeWebhook(evento)) {
      throw new WebhookError('evento_desconhecido', 'Evento desconhecido', evento);
    }
  }

  const segredo = randomBytes(32).toString('base64url');
  const cifrado = cifrar(segredo);

  const id = await withTenant(entrada.tenantId, async (tx) => {
    const criados = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO webhook_endpoints (tenant_id, name, url, secret_cipher, events, created_by)
      VALUES (${entrada.tenantId}::uuid, ${nome}, ${url.toString()}, ${cifrado},
              ${eventos}::webhook_event[], ${entrada.staffId}::uuid)
      RETURNING id
    `;
    const criado = criados[0];
    if (!criado) throw new WebhookError('endpoint_nao_encontrado', 'Não foi possível cadastrar');

    /** A trilha registra o endereço e os eventos — nunca o segredo. */
    await audit(tx, {
      actorId: entrada.staffId,
      actorName: entrada.staffName,
      action: 'webhook.registered',
      entity: 'webhook_endpoint',
      entityId: criado.id,
      after: { url: url.toString(), eventos },
    });
    return criado.id;
  });

  return { id, segredo };
}

/** Desliga um endereço. Estado, nunca `DELETE`: as entregas apontam para ele. */
export async function desligarEndpoint(entrada: {
  readonly tenantId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly endpointId: string;
}): Promise<void> {
  await withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; url: string }[]>`
      UPDATE webhook_endpoints SET active = false, updated_at = now()
       WHERE id = ${entrada.endpointId}::uuid AND active
      RETURNING id, url
    `;
    const linha = linhas[0];
    if (!linha) throw new WebhookError('endpoint_nao_encontrado', 'Endereço não encontrado');

    await audit(tx, {
      actorId: entrada.staffId,
      actorName: entrada.staffName,
      action: 'webhook.disabled',
      entity: 'webhook_endpoint',
      entityId: linha.id,
      after: { url: linha.url },
    });
  });
}

export interface EntregaNaTela {
  readonly id: string;
  readonly evento: string;
  readonly estado: string;
  readonly tentativas: number;
  readonly respostaHttp: number | null;
  readonly erro: string | null;
  readonly criadaEm: Date;
  readonly entregueEm: Date | null;
}

/** As últimas entregas, para a barbearia ver se está chegando. */
export async function entregasDaCasa(tenantId: string): Promise<readonly EntregaNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        event: string;
        status: string;
        attempts: number;
        response_status: number | null;
        last_error: string | null;
        created_at: Date;
        delivered_at: Date | null;
      }[]
    >`
      SELECT id, event::text AS event, status::text AS status, attempts,
             response_status, last_error, created_at, delivered_at
        FROM webhook_deliveries
       ORDER BY created_at DESC
       LIMIT 50
    `;
    return linhas.map((l) => ({
      id: l.id,
      evento: l.event,
      estado: l.status,
      tentativas: Number(l.attempts),
      respostaHttp: l.response_status === null ? null : Number(l.response_status),
      erro: l.last_error,
      criadaEm: l.created_at,
      entregueEm: l.delivered_at,
    }));
  });
}

/**
 * Entrega uma pendência: decifra, assina, fala com a internet e grava o desfecho.
 *
 * Roda `semTenant` porque é o worker quem chama, e ele varre o pendente de todas
 * as barbearias — mesma postura de `jobs`. A leitura traz o `tenant_id` da
 * própria linha, e nada aqui atravessa barbearia: a entrega é de um endpoint só.
 */
export async function entregarWebhook(
  entregaId: string,
  agora: Date,
): Promise<'entregue' | 'retentar' | 'desistiu' | 'sumiu'> {
  /**
   * A leitura sai de `entrega_de_webhook`, e não de um `JOIN` escrito aqui.
   *
   * Esta transação roda sem tenant — o worker varre o pendente de todas as
   * barbearias — e a política de `webhook_endpoints` é estrita por tenant: o
   * `JOIN` direto devolvia **zero linhas**, e a entrega respondia "sumiu" sobre
   * uma pendência que estava lá. Abrir aquela política entregaria o
   * `secret_cipher` de toda a base a qualquer caminho sem tenant.
   */
  const pendente = await semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      { payload: unknown; attempts: number; url: string; segredo: string; ativo: boolean }[]
    >`
      SELECT payload, attempts, url, segredo, ativo FROM entrega_de_webhook(${entregaId}::uuid)
    `;
    return linhas[0] ?? null;
  });
  if (!pendente) return 'sumiu';

  /**
   * Endereço desligado depois de a entrega nascer não é falha: é a barbearia
   * tendo mudado de ideia. Desiste sem erro, e a tela mostra o motivo.
   */
  if (!pendente.ativo) {
    await gravar(entregaId, {
      status: 'desistiu',
      attempts: pendente.attempts + 1,
      erro: 'endereço desligado antes da entrega',
    });
    return 'desistiu';
  }

  const corpo = JSON.stringify(pendente.payload);
  const instante = Math.floor(agora.getTime() / 1000);
  const assinatura = assinarEntrega({
    corpo,
    segredo: decifrar(pendente.segredo),
    instante,
  });

  let status: number | null = null;
  let erro: string | null = null;
  try {
    /**
     * Resolve **antes** de conectar, e recusa se o nome cair para dentro.
     *
     * O cadastro já recusa o nome óbvio; esta é a guarda de verdade, porque o
     * domínio é da barbearia e ela pode reapontá-lo depois. Fica a janela entre
     * esta resolução e a do `fetch` — fechá-la de verdade exige saída por proxy
     * de egresso, e isso está declarado como lacuna no ROADMAP.
     */
    const destino = new URL(pendente.url);
    const enderecos = await lookup(destino.hostname, { all: true });
    if (enderecos.length === 0 || enderecos.some((e) => ehDestinoInterno(e.address))) {
      throw new Error('endereço aponta para uma rede interna');
    }

    const resposta = await fetch(pendente.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'barber-dock-signature': assinatura,
      },
      body: corpo,
      /**
       * `manual`: um redirecionamento **não** é seguido.
       *
       * Sem isto, `https://meu-site.com/` respondendo `302` para
       * `http://169.254.169.254/` faria toda a conferência de destino valer
       * nada — o `fetch` seguiria, e o segundo salto não passa por guarda
       * nenhuma. O `3xx` vira resposta não-2xx, e a escada trata como falha.
       */
      redirect: 'manual',
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
    status = resposta.status;
  } catch (falha) {
    /**
     * A mensagem do erro é gravada **truncada**.
     *
     * O corpo de uma falha de rede pode trazer uma página de erro inteira do
     * outro lado, com cabeçalho e endereço interno. A barbearia precisa saber
     * *que* falhou e o suficiente para pedir ajuda; guardar a resposta inteira
     * é guardar o que a gente não sabe o que é.
     */
    erro = String(falha instanceof Error ? falha.message : falha).slice(0, 200);
  }

  const tentativas = pendente.attempts + 1;
  const desfecho = desfechoDaEntrega(status, tentativas);

  if (desfecho === 'entregue') {
    await gravar(entregaId, { status: 'entregue', attempts: tentativas, respostaHttp: status });
    return 'entregue';
  }
  /**
   * O motivo só é gravado quando **acrescenta** algo ao código de resposta.
   *
   * A coluna do lado já mostra `HTTP 404`; escrever "resposta 404" ao lado é a
   * mesma frase duas vezes, e quem lê a tela passa a pular a coluna que existe
   * para explicar o que o número não diz.
   */
  const motivo = erro ?? (status === null ? 'sem resposta' : null);

  if (desfecho === 'desistir') {
    await gravar(entregaId, {
      status: 'desistiu',
      attempts: tentativas,
      respostaHttp: status,
      erro: motivo,
    });
    return 'desistiu';
  }

  const espera = proximaTentativaEmSegundos(tentativas) ?? 0;
  await gravar(entregaId, {
    status: 'pendente',
    attempts: tentativas,
    respostaHttp: status,
    erro: motivo,
    proxima: new Date(agora.getTime() + espera * 1000),
  });
  return 'retentar';
}

async function gravar(
  entregaId: string,
  o: {
    readonly status: 'entregue' | 'desistiu' | 'pendente';
    readonly attempts: number;
    readonly respostaHttp?: number | null;
    readonly erro?: string | null;
    readonly proxima?: Date;
  },
): Promise<void> {
  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE webhook_deliveries
         SET status = ${o.status}::webhook_delivery_status,
             attempts = ${o.attempts},
             response_status = ${o.respostaHttp ?? null},
             last_error = ${o.erro ?? null},
             delivered_at = CASE WHEN ${o.status} = 'entregue' THEN now() ELSE NULL END,
             next_attempt_at = ${o.proxima ?? new Date()}
       WHERE id = ${entregaId}::uuid
    `;
  });
}

/**
 * A varredura que alcança o que a tarefa perdeu.
 *
 * A tarefa da fila acompanha **uma** entrega e morre com ela; se o processo cair
 * entre a falha e a reprogramação, aquela entrega fica pendente e ninguém a
 * chama de novo. É a mesma rede de segurança da nota fiscal do bloco 57.
 */
export async function varrerEntregasPendentes(agora: Date, teto = 200): Promise<readonly string[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM webhook_deliveries
       WHERE status = 'pendente' AND next_attempt_at <= ${agora}
       ORDER BY next_attempt_at
       LIMIT ${teto}
    `;
    return linhas.map((l) => l.id);
  });
}
