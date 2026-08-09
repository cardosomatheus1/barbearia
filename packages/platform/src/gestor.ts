import { withTenant } from '@barbearia/db';
import { enfileirar } from '@barbearia/jobs';
import { diasAteOBloqueio, foraDoSilencio } from '@barbearia/core';
import type { AssuntoDoAviso } from './cobranca.js';

/**
 * O canal dirigido ao gestor (bloco 28).
 *
 * O produto tinha três canais e nenhum deles falava com o dono: o OTP e o
 * lembrete vão para o **cliente da barbearia**, a senha de primeiro acesso vai
 * para quem foi convidado. Faltava o de cima — a plataforma falando com quem
 * assina o contrato.
 *
 * A falta aparecia como lacuna declarada desde o bloco 24: "avisar a barbearia
 * de que foi bloqueada". Ela não era uma notificação faltando, era a régua de
 * cobrança faltando — e é por a régua existir agora que este canal precisa
 * existir também. Bloquear sem avisar seria o corte no dia seguinte ao boleto
 * atrasado, que é o comportamento que este produto vende contra.
 *
 * **Separado de `NotificationProvider`**, e não é preciosismo: aquele provedor
 * manda pelo número da barbearia, para os clientes dela. Este manda pela
 * plataforma, para a barbearia. Remetente diferente, template diferente,
 * fornecedor possivelmente diferente — juntá-los faria a cobrança sair do
 * WhatsApp da barbearia cobrando o dono dela mesma.
 */

export interface MensagemAoGestor {
  readonly assunto: AssuntoDoAviso;
  readonly email: string;
  readonly phoneE164: string | null;
  readonly gestor: string;
  readonly barbearia: string;
  readonly valorCents: number;
  readonly vencimento: Date;
  /** Quantos dias faltam para a barbearia sair do ar. Zero é "hoje". */
  readonly diasAteOBloqueio: number;
}

export interface GestorProvider {
  avisarDeCobranca(mensagem: MensagemAoGestor): Promise<void>;
}

/** Registra o que enviaria. Único provedor usado em teste e desenvolvimento. */
export class FakeGestorProvider implements GestorProvider {
  readonly avisos: MensagemAoGestor[] = [];
  falharProxima = false;

  async avisarDeCobranca(mensagem: MensagemAoGestor): Promise<void> {
    if (this.falharProxima) {
      this.falharProxima = false;
      throw new Error('provedor indisponível');
    }
    this.avisos.push(mensagem);
  }

  ultimoDe(barbearia: string): MensagemAoGestor | undefined {
    return [...this.avisos].reverse().find((a) => a.barbearia === barbearia);
  }

  clear(): void {
    this.avisos.length = 0;
  }
}

const RESUMO: Readonly<Record<AssuntoDoAviso, string>> = {
  emitida: 'fatura disponível',
  vence_em_breve: 'vence em breve',
  venceu: 'venceu',
  tentativa_recusada: 'pagamento não passou',
  bloqueada: 'conta suspensa por falta de pagamento',
};

/**
 * Escreve no log em vez de enviar. É o que o worker usa até haver provedor.
 *
 * O e-mail vai inteiro e o telefone vai mascarado, como no provedor de
 * notificação: e-mail de gestor é o endereço para onde a cobrança tem que ir e
 * confundi-lo é um chamado; telefone em log é dado pessoal em repouso.
 */
export class ConsoleGestorProvider implements GestorProvider {
  constructor(private readonly log: (message: string) => void = console.log) {}

  async avisarDeCobranca(mensagem: MensagemAoGestor): Promise<void> {
    const valor = (mensagem.valorCents / 100).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
    this.log(
      `[cobranca] ${RESUMO[mensagem.assunto]} — ${mensagem.barbearia}, ${valor}, ` +
        `${mensagem.diasAteOBloqueio} dia(s) até a suspensão → ${mensagem.email}`,
    );
  }
}

interface Destinatario {
  readonly email: string;
  readonly phoneE164: string | null;
  readonly gestor: string;
  readonly barbearia: string;
  readonly fuso: string;
  readonly valorCents: number;
  readonly vencimento: Date;
  readonly aberta: boolean;
}

/**
 * Executa um aviso de cobrança enfileirado.
 *
 * Roda `withTenant` de propósito, e não sem tenant como o resto da régua: aqui
 * o que se lê é o dono, o nome da barbearia e o fuso da unidade — dado de uma
 * barbearia só, sob a política que já existe. A fatura entra na mesma consulta
 * porque a leitura de `invoices` é aberta ao próprio tenant desde a migração
 * 0030.
 *
 * ## Duas conferências antes de mandar
 *
 * 1. **A fatura ainda está aberta?** A tarefa foi criada em outra volta da
 *    régua; entre lá e agora o dono pode ter pago. Mandar "sua conta venceu"
 *    para quem acabou de pagar é o tipo de mensagem que destrói a confiança nas
 *    seguintes. A única que ignora isso é a de bloqueio, porque ela explica um
 *    estado que já aconteceu.
 *
 * 2. **É hora de mandar?** Entre 21h e 8h **da unidade** nada sai, como todo
 *    aviso do produto. A tarefa não é descartada: ela se reprograma para as 8h,
 *    porque a cobrança de amanhã continua valendo. O fuso vem da unidade e
 *    nunca do processo — é o defeito D2, e aqui ele mandaria cobrança de
 *    madrugada para o Acre.
 */
export async function executarAvisoDeCobranca(entrada: {
  readonly tenantId: string;
  readonly faturaId: string;
  readonly assunto: AssuntoDoAviso;
  readonly provider: GestorProvider;
  readonly agora: Date;
}): Promise<void> {
  const destino = await withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        email: string;
        phone_e164: string | null;
        gestor: string;
        barbearia: string;
        fuso: string;
        amount_cents: number;
        due_at: Date;
        status: string;
      }[]
    >`
      SELECT u.email::text AS email, u.phone_e164, u.name AS gestor,
             t.name AS barbearia, l.timezone AS fuso,
             i.amount_cents, i.due_at, i.status::text AS status
        FROM invoices i
        JOIN tenants t ON t.id = i.tenant_id
        JOIN staff_users u ON u.tenant_id = i.tenant_id AND u.role = 'owner' AND u.active
        JOIN locations l ON l.tenant_id = i.tenant_id
       WHERE i.id = ${entrada.faturaId}::uuid
       ORDER BY u.created_at, l.created_at
       LIMIT 1
    `;
    const linha = linhas[0];
    if (!linha) return null;

    const destinatario: Destinatario = {
      email: linha.email,
      phoneE164: linha.phone_e164,
      gestor: linha.gestor,
      barbearia: linha.barbearia,
      fuso: linha.fuso,
      valorCents: linha.amount_cents,
      vencimento: linha.due_at,
      aberta: linha.status === 'open',
    };

    if (!destinatario.aberta && entrada.assunto !== 'bloqueada') return null;

    const quando = foraDoSilencio(entrada.agora, destinatario.fuso);
    if (quando.getTime() > entrada.agora.getTime()) {
      await enfileirar(tx, {
        kind: 'cobranca.aviso',
        payload: { faturaId: entrada.faturaId, assunto: entrada.assunto },
        rodarApos: quando,
        // O instante entra na chave porque a tarefa original já ocupou a chave
        // sem ele. Sem isto o `ON CONFLICT DO NOTHING` engoliria o reagendamento
        // e o aviso sumiria em silêncio — que é a pior das duas falhas.
        idempotencyKey: `cobranca:${entrada.faturaId}:${entrada.assunto}:${quando.toISOString()}`,
      });
      return null;
    }

    return destinatario;
  });

  if (!destino) return;

  // Fora da transação, como todo envio: rede não segura conexão de banco.
  await entrada.provider.avisarDeCobranca({
    assunto: entrada.assunto,
    email: destino.email,
    phoneE164: destino.phoneE164,
    gestor: destino.gestor,
    barbearia: destino.barbearia,
    valorCents: destino.valorCents,
    vencimento: destino.vencimento,
    diasAteOBloqueio: diasAteOBloqueio(destino.vencimento, entrada.agora),
  });
}
