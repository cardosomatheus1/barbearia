import type { PedidoDeMensagem } from './whatsapp-mensagens.js';
import { enviarPeloWhatsApp } from './whatsapp-mensagens.js';
import { provedorDoWhatsApp } from './whatsapp-meta.js';
import { BaileysError, baileysHabilitado, canalDaUnidade } from './baileys/sessao.js';
import { textoBaileysParaEnvio } from './baileys/textos.js';
import { prepararEnvioBaileys, aguardarEnvioBaileys } from './baileys/outbox.js';

/** A identidade vem do fato de negócio e permanece a mesma após timeout/retry. */
export async function enviarNoCanalDaUnidade(
  p: Omit<PedidoDeMensagem, 'provider'> & { readonly intentKey: string },
): Promise<{ readonly wamid: string } | null> {
  if (await canalDaUnidade(p) === 'meta') {
    const provider = await provedorDoWhatsApp(p.tenantId, p.locationId);
    return provider ? enviarPeloWhatsApp({ ...p, provider }) : null;
  }
  if (!baileysHabilitado()) throw new BaileysError('baileys_indisponivel', 'A conexão por QR está indisponível nesta instalação.', 503);
  const texto = await textoBaileysParaEnvio({ ...p, promocional: p.intentKey.startsWith('promo:') });
  const envio = await prepararEnvioBaileys({ ...p, conteudo: {
    telefone: p.telefone, texto: texto.texto, templateId: texto.templateId,
    customerId: p.customerId, appointmentId: p.appointmentId, tipo: p.tipo,
  } });
  return aguardarEnvioBaileys(p, envio.id);
}
