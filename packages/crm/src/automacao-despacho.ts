import { WhatsAppDeliveryUnknownError } from '@barbearia/core';
import { disparosAEnviar, reservarDisparoDaAutomacao, marcarDisparoDaAutomacaoIncerto,
  liberarDisparoDaAutomacao, confirmarDisparoDaAutomacao, type DisparoAEnviar } from './automacao.js';

/** O mesmo despacho no worker e nos ensaios: reserva, rede e confirmação. */
export async function despacharAutomacoes(p: {
  tenantId: string; agora: Date; enviar: (disparo: DisparoAEnviar) => Promise<void>;
}): Promise<number> {
  const fila = await disparosAEnviar(p.tenantId,p.agora);
  let enviados = 0;
  for (const disparo of fila) {
    if (!await reservarDisparoDaAutomacao({ tenantId: p.tenantId, disparoId: disparo.id,
      agora: p.agora, timeZone: disparo.timeZone })) continue;
    try { await p.enviar(disparo); }
    catch (erro) {
      if (erro instanceof WhatsAppDeliveryUnknownError) {
        await marcarDisparoDaAutomacaoIncerto({ tenantId: p.tenantId, disparoId: disparo.id, agora: p.agora });
        continue;
      }
      await liberarDisparoDaAutomacao({ tenantId: p.tenantId, disparoId: disparo.id });
      throw erro;
    }
    if (await confirmarDisparoDaAutomacao({ tenantId: p.tenantId, disparoId: disparo.id, agora: p.agora })) enviados++;
  }
  return enviados;
}
