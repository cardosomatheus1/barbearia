import type { TransactionClient } from '@barbearia/db';

/**
 * Quem e dona de uma WABA, e a recusa quando ela ja e de outra casa.
 *
 * Mora sozinho porque e uma responsabilidade dizivel numa frase — reivindicar
 * o identificador da conta de WhatsApp Business para esta barbearia — e porque
 * o cadastro ja carrega credencial, numero, verificacao e roteamento.
 */
export async function reivindicarWaba(
  tx: TransactionClient,
  wabaId: string,
): Promise<'minha' | 'de_outra'> {
  /**
   * Confere a dona **antes**, e depois insere sem `DO UPDATE`.
   *
   * Sob RLS, `ON CONFLICT DO UPDATE` contra uma linha que a politica de escrita
   * recusa **levanta erro** em vez de alcancar zero linhas: a recusa nunca era
   * alcancada e a colisao com outra barbearia saia como 500. Entrada que colide
   * e defeito de borda, e a resposta certa e 4xx com motivo.
   *
   * A leitura desta tabela e aberta de proposito — ela so guarda ids opacos de
   * roteamento —, entao a conferencia enxerga a dona de verdade.
   */
  const jaTemDona = await tx.$queryRaw<{ minha: boolean }[]>`
    SELECT tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid AS minha
      FROM whatsapp_waba_owners WHERE waba_id = ${wabaId}
  `;
  if (jaTemDona[0]) return jaTemDona[0].minha ? 'minha' : 'de_outra';

  const criada = await tx.$executeRaw`
    INSERT INTO whatsapp_waba_owners (waba_id, tenant_id)
    VALUES (${wabaId}, NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    ON CONFLICT (waba_id) DO NOTHING
  `;
  // Zero aqui e a corrida entre dois processos: outra barbearia reivindicou a
  // WABA entre a conferencia e o INSERT. O indice unico e a ultima linha de
  // defesa, e a recusa e a mesma.
  return criada === 0 ? 'de_outra' : 'minha';
}
