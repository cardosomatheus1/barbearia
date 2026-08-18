import { z } from 'zod';
import { TIPOS_DE_CAMPANHA, TIPOS_DE_NOTIFICACAO } from '@barbearia/core';

/**
 * A borda do WhatsApp (bloco 55).
 *
 * Os limites repetem os `CHECK` da migração 0058, e a repetição é deliberada: o
 * banco é a garantia, a borda é a mensagem. Sem ela, um nome de template com
 * espaço devolveria erro de constraint em vez de "o nome aceita só minúsculas".
 */

export const cadastroDoWhatsAppSchema = z.object({
  /** Ids da Meta: dígitos, como ela os emite. */
  phoneNumberId: z.string().trim().regex(/^\d{5,32}$/, 'Confira o identificador do número'),
  wabaId: z.string().trim().regex(/^\d{5,32}$/, 'Confira o identificador da conta'),
  numeroVisivel: z.string().trim().max(40).nullable().optional(),
  /**
   * Ausente é "não mexa", e é por isso que ele é opcional em vez de anulável.
   *
   * A tela nunca devolve o token — ela mostra "salvo" e oferece trocá-lo —,
   * então não pode reenviá-lo. Aceitar `null` aqui faria corrigir o número
   * visível apagar a credencial da barbearia inteira.
   */
  token: z.string().trim().min(20).max(500).optional(),
});

export const templateSchema = z.object({
  tipo: z.enum(TIPOS_DE_NOTIFICACAO),
  /**
   * Opcional: por padrão o nome na Meta é o próprio tipo do aviso.
   *
   * A regra dela é minúsculas, números e sublinhado — identificador de sistema,
   * e o balcão estava sendo obrigado a digitá-lo. "Lembrete 24h" voltava como
   * "Parâmetro inválido: nome", que é a borda recusando o que qualquer pessoa
   * escreveria.
   *
   * Continua aceito para quem já tem um nome aprovado do lado de lá.
   */
  nome: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,512}$/, 'Só minúsculas, números e sublinhado')
    .optional(),
  corpo: z.string().trim().min(5).max(1024),
});

/**
 * O que a janela da Meta devolve ao navegador (bloco 83).
 *
 * O `code` vale uma vez e é trocado no servidor pelo token — o `appSecret`
 * nunca chega ao navegador, então não há como o cliente fazer a troca sozinho.
 *
 * Os dois ids têm o mesmo formato que `salvarCadastroDoWhatsApp` exige, e a
 * conferência é repetida lá dentro de propósito: a borda garante forma, e o
 * domínio é quem responde por gravar.
 */
/**
 * Para onde a Meta manda a pessoa de volta, conferido uma vez só.
 *
 * Ele aparece em duas rotas — a que **emite** o endereço da Meta e a que
 * **troca** o código por token — e nas duas precisa ser o mesmo valor, porque a
 * Meta compara os dois byte a byte. Escrito duas vezes, seria a lista paralela
 * de sempre: a primeira divergência aceitaria na ida o que recusa na volta.
 *
 * A conferência existe porque sem ela a rota de emissão viraria um jeito de
 * fazer a Meta redirecionar para onde alguém quiser — com um código de
 * autorização válido na mão de quem montou o endereço.
 *
 * O domínio não é fixado porque a mesma instalação é servida por mais de um
 * endereço em desenvolvimento, e quem o informa já passou pelo login do painel.
 */
const enderecoDeVolta = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    /**
     * `https`, e a exceção é a própria máquina.
     *
     * Em produção o retorno tem que ser cifrado: ele carrega o código de
     * autorização na barra do navegador. Em desenvolvimento o produto roda em
     * `http://127.0.0.1`, e exigir `https` ali tornava este caminho
     * **impossível de exercitar antes de subir** — que é como ele chegou ao
     * ar quebrado da primeira vez.
     *
     * A Meta aceita `localhost` pela mesma razão.
     */
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    const cifrado = u.protocol === 'https:' || (local && u.protocol === 'http:');
    return cifrado && u.pathname === '/admin/whatsapp/conectado';
  }, 'o retorno precisa ser https (ou local) e apontar para a volta da conexão');

export const signupDoWhatsAppSchema = z.object({
  code: z.string().trim().min(1).max(512),
  /**
   * O mesmo endereço que abriu a janela da Meta, e é **obrigatório** que seja
   * idêntico — a Meta recusa a troca quando ele falta ou difere.
   *
   * Opcional aqui porque o fluxo antigo (a janela do SDK, e o cadastro à mão)
   * troca o código **sem** endereço de volta, e mandar um quando não houve
   * redirecionamento é o mesmo erro ao contrário.
   */
  redirectUri: enderecoDeVolta.optional(),
  /**
   * Opcionais desde o bloco 84, e é o conserto do celular.
   *
   * Eles chegavam do evento `message` da janela da Meta — que no computador
   * roda numa janela filha e no celular numa **aba separada**, onde a mensagem
   * não volta. Exigi-los aqui fazia a conexão morrer calada no aparelho em que
   * a barbearia realmente opera.
   *
   * Ausentes, o servidor os descobre pelo token. O formato continua conferido:
   * o que chega vira dica, e dica malformada é recusada como qualquer entrada.
   */
  wabaId: z.string().regex(/^[0-9]{5,32}$/).optional(),
  phoneNumberId: z.string().regex(/^[0-9]{5,32}$/).optional(),
  numeroVisivel: z.string().trim().max(32).nullable().optional(),
});

/**
 * O que a tela precisa mandar para receber o endereço da Meta (bloco 86).
 *
 * O `redirectUri` é conferido, e não repassado como veio — a conferência é a
 * mesma de `signupDoWhatsAppSchema`, e de propósito: os dois lados da viagem
 * precisam concordar sobre o que é um endereço de volta aceitável.
 */
export const signupDaTelaSchema = z.object({
  /**
   * Opcionais: a tela pede só o modo ao renderizar, e o endereço na hora de ir.
   * Quando vêm, são conferidos — a validação não afrouxa por serem opcionais.
   */
  redirectUri: enderecoDeVolta.optional(),
  state: z.string().regex(/^[a-f0-9]{32}$/).optional(),
});

/**
 * Mandar uma mensagem para um cliente (bloco 92).
 *
 * `TIPOS_DE_CAMPANHA` e não os seis avisos, pela razão da automação: quem
 * recebe uma mensagem avulsa **não tem horário marcado**, então `lembrete_24h`
 * prometeria um horário que não existe — e `senha_de_acesso` é credencial.
 */
export const mensagemAvulsaSchema = z.object({
  customerId: z.string().uuid(),
  tipo: z.enum(TIPOS_DE_CAMPANHA),
});
