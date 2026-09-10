/** Mudar o texto exige mudar a versão; o nome da casa é congelado na confirmação. */
export const VERSAO_CONSENTIMENTO_WHATSAPP_CADASTRO = 'whatsapp-cadastro-2026-09-v1';
export function textoConsentimentoWhatsAppCadastro(barbearia: string): string {
  return `Aceito receber pelo WhatsApp confirmações, lembretes e novidades da ${barbearia.trim()}.`;
}
export const EXPLICACAO_CONSENTIMENTO_WHATSAPP_CADASTRO = 'Opcional. Você pode agendar sem aceitar. Novidades e promoções só são ativadas depois de confirmar seu número; os avisos necessários ao agendamento continuam separados. Você pode retirar o aceite quando quiser.';
