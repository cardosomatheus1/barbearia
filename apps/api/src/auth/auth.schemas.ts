import { z } from 'zod';
import { diaISO } from '../common/data.js';

export const requestOtpSchema = z.object({
  phone: z.string().min(8).max(24),
  // Nome vem antes do código no fluxo da SPEC (P5 -> P6) e vira o cadastro.
  name: z.string().trim().min(3).max(80).optional(),
});

export const verifyOtpSchema = z.object({
  phone: z.string().min(8).max(24),
  code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos'),
});

export const createAppointmentSchema = z.object({
  // Sem sessão: nome e celular no corpo. É o fluxo do mercado — escolher,
  // informar, confirmar. Com sessão, estes campos são ignorados.
  name: z.string().trim().min(3).max(80).optional(),
  phone: z.string().min(8).max(24).optional(),
  locationId: z.string().uuid(),
  professionalId: z.string().uuid(),
  serviceIds: z.array(z.string().uuid()).min(1).max(10),
  date: diaISO,
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  // Teto explícito: campo livre sem limite vira armazenamento gratuito.
  notes: z.string().max(500).optional(),
  /**
   * O carimbo **assinado** de "veio pela busca" (bloco 72, SPEC §5.2).
   *
   * Não é o nome do canal: é um HMAC emitido pelo servidor, conferido no
   * controller contra o slug e o prazo. A primeira versão aceitava o rótulo
   * `marketplace` no corpo, e um `curl` bastava para fazer a barbearia dever
   * comissão por um cliente que ela mesma trouxe — achado da
   * `/security-review` deste bloco.
   *
   * O schema só dá o teto de tamanho. Quem decide se o carimbo vale é a
   * assinatura, e um valor inválido não é erro: é "não veio pela busca", que é
   * um desfecho legítimo de quem agenda pela página de sempre.
   */
  origem: z.string().max(200).optional(),
});

/**
 * Entrar na lista de espera (bloco 38, SPEC §2.9).
 *
 * Aceita nome e celular como a criação de agendamento: quem não tem horário
 * disponível é justamente quem ainda não tem sessão — obrigá-la a fazer login
 * para dizer "me avise" perderia a pessoa no passo em que ela já foi frustrada
 * uma vez.
 *
 * A janela vem em `HH:mm` e não em minutos: é o que a tela mostra, e converter
 * na borda é um lugar só. Minutos crus no corpo seriam um número que ninguém
 * consegue conferir lendo o log.
 */
export const entrarNaEsperaSchema = z.object({
  name: z.string().trim().min(3).max(80).optional(),
  phone: z.string().min(8).max(24).optional(),
  locationId: z.string().uuid(),
  serviceIds: z.array(z.string().uuid()).min(1).max(10),
  // Ausente é "qualquer profissional", que é o caso comum de quem espera vaga.
  professionalId: z.string().uuid().optional(),
  de: diaISO,
  ate: diaISO,
  inicio: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  fim: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export const rescheduleSchema = z.object({
  date: diaISO,
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  professionalId: z.string().uuid().optional(),
});

export const cancelSchema = z.object({
  reason: z.string().max(300).optional(),
});

/**
 * A decisão do titular sobre marketing (bloco 31).
 *
 * A versão do texto vem da tela e é obrigatória: ela é o que se mostra numa
 * contestação — "ele aceitou" sem dizer o que ele leu não responde nada. O
 * domínio recusa vazio de novo, e a duplicação é deliberada.
 */
/**
 * A decisão do titular sobre **uma** finalidade opcional (bloco 129).
 *
 * `service` não entra: é o tratamento necessário para executar o serviço
 * contratado, que não depende de consentimento e sim do próprio contrato.
 * Aceitá-lo aqui deixaria o cliente "revogar" algo que a revogação não desliga
 * — e o que ele quer nesse caso é o pedido de exclusão, que tem rota própria.
 *
 * Uma finalidade por chamada, e não as três de uma vez: cada decisão grava a
 * **versão do texto daquela finalidade**, e um corpo com as três juntas
 * gravaria três linhas sob um clique só, sem dizer qual texto a pessoa leu.
 */
export const consentimentoDoTitularSchema = z.object({
  finalidade: z.enum(['marketing', 'photos', 'photos_public']),
  concedido: z.boolean(),
  versaoDoTexto: z.string().trim().min(1).max(80),
});

/**
 * O pedido do titular, do lado dele (bloco 32).
 *
 * Os dois tipos são aceitos. `deletion` **registra** o pedido; quem apaga é a
 * barbearia, com permissão própria, depois de conferir a guarda legal. Aceitar
 * o registro e recusar a execução aqui é o desenho: o direito é do titular, a
 * responsabilidade pelo que a lei manda guardar é de quem controla o dado.
 */
export const pedidoDoTitularSchema = z.object({
  tipo: z.enum(['export', 'deletion']),
});
