import { withTenant } from '@barbearia/db';
import { foraDoSilencio, type Alerta } from '@barbearia/core';

/**
 * O canal do alerta operacional, ligado (bloco 33).
 *
 * ## A lacuna que isto fecha, e por que ela demorou
 *
 * Desde o bloco 22 as regras decidem, o coletor alimenta e `alertasDaBarbearia`
 * devolve a lista pronta. Faltava o canal — e depois do bloco 28 ele existia,
 * mas só a cobrança o usava. O que sobrava era **decisão de produto**: o que
 * merece interromper o dono, e com que frequência. É o que este arquivo resolve,
 * junto de `tenant_alert_settings`.
 *
 * ## As três decisões, escritas
 *
 * 1. **Crítico liga, aviso não.** Alerta que dispara à toa é alerta que se
 *    aprende a ignorar, e um canal ignorado é pior do que canal nenhum — dá a
 *    sensação de estar coberto. O dono liga o resto se quiser.
 * 2. **Uma vez por dia, por regra.** "A fila está travada" repetido a cada volta
 *    do worker é como se arquiva a mensagem sem ler. A dedupe é por
 *    `(tenant, código, dia)`: o alerta volta amanhã se a causa continuar.
 * 3. **A janela de silêncio da unidade vale aqui também.** Entre 21h e 8h nada
 *    sai. O fuso vem da unidade e nunca do processo — é o defeito D2, e aqui
 *    ele mandaria alerta de madrugada para o Acre.
 */

/**
 * O código do aviso de retenção (bloco 32), que tem interruptor próprio.
 *
 * Constante e exportada porque quem **produz** o alerta é `apps/worker`, e um
 * literal repetido dos dois lados divergiria no primeiro ajuste — com o efeito
 * silencioso de a preferência deixar de valer.
 */
export const CODIGO_DA_RETENCAO = 'retencao';

export interface MensagemOperacional {
  readonly email: string;
  readonly phoneE164: string | null;
  readonly gestor: string;
  readonly barbearia: string;
  /** O identificador estável da regra — é por ele que se agrupa e se silencia. */
  readonly titulo: string;
  /** A frase em português, que é o que o dono lê. */
  readonly detalhe: string;
  readonly severidade: 'aviso' | 'critico';
}

export interface OperacaoProvider {
  avisarDeOperacao(mensagem: MensagemOperacional): Promise<void>;
}

/** Registra o que enviaria. Único provedor usado em teste e desenvolvimento. */
export class FakeOperacaoProvider implements OperacaoProvider {
  readonly avisos: MensagemOperacional[] = [];

  async avisarDeOperacao(mensagem: MensagemOperacional): Promise<void> {
    this.avisos.push(mensagem);
  }

  clear(): void {
    this.avisos.length = 0;
  }
}

/**
 * Provedor de desenvolvimento: escreve no log com o telefone mascarado. Em
 * produção, falha explicitamente para que um alerta não seja marcado como
 * entregue quando apenas foi escrito no console.
 *
 * Mesma decisão do provedor de cobrança: o e-mail vai inteiro porque é o
 * endereço para onde o alerta tem que ir e confundi-lo é um chamado; telefone em
 * log é dado pessoal em repouso.
 */
export class ConsoleOperacaoProvider implements OperacaoProvider {
  constructor(private readonly log: (mensagem: string) => void = console.log) {}

  private assegurarDesenvolvimento(): void {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('console_delivery_forbidden_in_production');
    }
  }

  async avisarDeOperacao(mensagem: MensagemOperacional): Promise<void> {
    this.assegurarDesenvolvimento();
    this.log(
      `[operacao] ${mensagem.severidade} — ${mensagem.barbearia}: ${mensagem.titulo} ` +
        `→ ${mensagem.email}`,
    );
  }
}

export interface ResultadoDoAviso {
  readonly enviados: number;
  readonly motivo: 'ok' | 'silencio' | 'desligado' | 'ja_avisado' | 'sem_destinatario';
}

interface Destinatario {
  email: string;
  gestor: string;
  phone_e164: string | null;
  barbearia: string;
  fuso: string;
  enviar_critico: boolean;
  enviar_aviso: boolean;
  enviar_retencao: boolean;
}

/**
 * Manda o que estiver pendente para uma barbearia.
 *
 * Recebe os alertas prontos em vez de buscá-los: quem os produz é
 * `packages/jobs`, que é a camada de baixo, e importá-lo aqui inverteria a
 * seta. Quem liga as duas pontas é `apps/worker`, como já faz com a régua de
 * cobrança.
 */
export async function avisarDaOperacao(entrada: {
  readonly tenantId: string;
  readonly alertas: readonly Alerta[];
  readonly provider: OperacaoProvider;
  readonly agora: Date;
}): Promise<ResultadoDoAviso> {
  if (entrada.alertas.length === 0) return { enviados: 0, motivo: 'ok' };

  return withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<Destinatario[]>`
      SELECT u.email::text AS email, u.name AS gestor, u.phone_e164,
             t.name AS barbearia, l.timezone AS fuso,
             -- Sem linha de preferência valem os padrões da tabela, e é o que
             -- o COALESCE diz: crítico sim, aviso não.
             COALESCE(s.enviar_critico, true) AS enviar_critico,
             COALESCE(s.enviar_aviso, false) AS enviar_aviso,
             COALESCE(s.enviar_retencao, true) AS enviar_retencao
        FROM staff_users u
        JOIN tenants t ON t.id = u.tenant_id
        JOIN LATERAL (SELECT timezone FROM locations ORDER BY created_at LIMIT 1) l ON true
        LEFT JOIN tenant_alert_settings s ON s.tenant_id = u.tenant_id
       WHERE u.role = 'owner' AND u.active
       ORDER BY u.created_at
       LIMIT 1
    `;

    const dono = linhas[0];
    if (!dono) return { enviados: 0, motivo: 'sem_destinatario' as const };

    /**
     * A janela de silêncio **descarta** aqui, e não reprograma.
     *
     * A cobrança reprograma porque a fatura de amanhã continua valendo. Alerta
     * operacional não: "o volume caiu hoje" entregue amanhã às 8h é notícia
     * velha, e a varredura de amanhã produz o alerta de amanhã se a causa
     * continuar. Guardar para depois entregaria dois alertas quase iguais.
     */
    /**
     * `foraDoSilencio` devolve **o próximo instante permitido**, não um
     * booleano — e a primeira versão daqui escreveu `!foraDoSilencio(...)`, que
     * é sempre falso porque `Date` é verdadeiro. O alerta saía de madrugada e
     * nada acusava; foi o teste da janela que pegou.
     *
     * Estar liberado é a função devolver o próprio instante.
     */
    if (foraDoSilencio(entrada.agora, dono.fuso).getTime() !== entrada.agora.getTime()) {
      return { enviados: 0, motivo: 'silencio' as const };
    }

    /**
     * A retenção tem interruptor próprio, e não segue a severidade.
     *
     * Ela é obrigação legal, não sinal operacional: o dono que desligou "me
     * avise quando a fila travar" não está dizendo que aceita perder cadastro
     * sem ser avisado. Amarrá-la a `enviar_critico` faria uma decisão sobre
     * ruído virar, sem ninguém perceber, uma decisão sobre a LGPD.
     */
    const querem = entrada.alertas.filter((a) => {
      if (a.regra === CODIGO_DA_RETENCAO) return dono.enviar_retencao;
      return a.severidade === 'critico' ? dono.enviar_critico : dono.enviar_aviso;
    });
    if (querem.length === 0) return { enviados: 0, motivo: 'desligado' as const };

    const dia = entrada.agora.toISOString().slice(0, 10);
    let enviados = 0;

    for (const alerta of querem) {
      /**
       * O registro entra **antes** do envio, e a chave é que decide.
       *
       * `ON CONFLICT DO NOTHING` devolvendo zero significa que outro processo —
       * ou esta mesma varredura repetida — já mandou hoje. Gravar depois do
       * envio abriria a janela em que dois workers mandam o mesmo alerta.
       */
      const gravou = await tx.$executeRaw`
        INSERT INTO tenant_alerts_sent (tenant_id, code, dia)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${alerta.regra},
          ${dia}::date
        )
        ON CONFLICT DO NOTHING
      `;
      if (gravou === 0) continue;

      await entrada.provider.avisarDeOperacao({
        email: dono.email,
        phoneE164: dono.phone_e164,
        gestor: dono.gestor,
        barbearia: dono.barbearia,
        titulo: alerta.regra,
        detalhe: alerta.frase,
        severidade: alerta.severidade,
      });
      enviados += 1;
    }

    return { enviados, motivo: enviados > 0 ? ('ok' as const) : ('ja_avisado' as const) };
  });
}

export interface PreferenciasDeAlerta {
  readonly enviarCritico: boolean;
  readonly enviarAviso: boolean;
  readonly enviarRetencao: boolean;
}

/** O que o dono escolheu, com os padrões quando ele nunca escolheu nada. */
export async function lerPreferenciasDeAlerta(tenantId: string): Promise<PreferenciasDeAlerta> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { enviar_critico: boolean; enviar_aviso: boolean; enviar_retencao: boolean }[]
    >`
      SELECT enviar_critico, enviar_aviso, enviar_retencao
        FROM tenant_alert_settings
    `;
    const linha = linhas[0];
    // Os mesmos padrões da tabela, repetidos aqui porque a ausência de linha é
    // o caso comum: crítico e retenção sim, aviso não.
    return {
      enviarCritico: linha?.enviar_critico ?? true,
      enviarAviso: linha?.enviar_aviso ?? false,
      enviarRetencao: linha?.enviar_retencao ?? true,
    };
  });
}

export async function salvarPreferenciasDeAlerta(
  tenantId: string,
  preferencias: PreferenciasDeAlerta,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO tenant_alert_settings
        (tenant_id, enviar_critico, enviar_aviso, enviar_retencao, updated_at)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${preferencias.enviarCritico}, ${preferencias.enviarAviso},
        ${preferencias.enviarRetencao}, now()
      )
      ON CONFLICT (tenant_id) DO UPDATE
        SET enviar_critico = EXCLUDED.enviar_critico,
            enviar_aviso = EXCLUDED.enviar_aviso,
            enviar_retencao = EXCLUDED.enviar_retencao,
            updated_at = now()
    `;
  });
}
