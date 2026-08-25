/**
 * Fachada pública do canal WhatsApp.
 *
 * As responsabilidades vivem em módulos coesos; esta fachada preserva o
 * contrato histórico de `./whatsapp.js` para API, worker e testes.
 */
export {
  WhatsAppError,
  type WhatsAppFailure,
} from './whatsapp-erros.js';

export {
  type CadastroDoWhatsApp,
  cadastroDoWhatsApp,
  salvarCadastroDoWhatsApp,
  conciliarNumero,
  tokenDoWhatsApp,
} from './whatsapp-cadastro.js';

export {
  numeroVisivelDaUnidadeConfere,
  suspenderUnidadeWhatsApp,
  prepararReconciliacaoDaUnidade,
} from './whatsapp-lifecycle.js';

export {
  type TemplateNaTela,
  templatesDaUnidade,
  identificadorDoTexto,
  submeterTemplate,
  templateDaUnidade,
  gravarRespostaDoTemplate,
  templatesEmCurso,
} from './whatsapp-templates.js';

export {
  type PedidoDeMensagem,
  enviarPeloWhatsApp,
  type EstadoDaMensagem,
  desconectarNumero,
  registrarEstadoDaMensagem,
  registrarResposta,
  type RespostaAExecutar,
  respostaAExecutar,
  fecharResposta,
  executarResposta,
} from './whatsapp-mensagens.js';

export {
  type FalhaDaAssinatura,
  AssinaturaDoWhatsAppInvalida,
  assinarWebhookDaMeta,
  conferirAssinaturaDaMeta,
} from './whatsapp-assinatura.js';

export { tenantDoNumero, tenantsDaWaba } from './whatsapp-roteamento.js';
