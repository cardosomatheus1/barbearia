import { Body, Controller, Get, Headers, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  WhatsAppError,
  WhatsAppMetaError,
  SignupError,
  cadastroDoWhatsApp,
  conciliarWhatsAppDaUnidade,
  enviarMensagemAvulsa,
  enviarPeloWhatsApp,
  EnvioAvulsoError,
  conectarPeloSignup,
  provedorDoWhatsApp,
  signupNaTela,
  salvarCadastroDoWhatsApp,
  submeterTemplate,
  templatesDaUnidade,
} from '@barbearia/crm';
import {
  type BotaoDaMensagem,
  type BotaoQueLeva,
  type TipoDeNotificacao,
} from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import {
  cadastroDoWhatsAppSchema,
  signupDaTelaSchema,
  mensagemAvulsaSchema,
  signupDoWhatsAppSchema,
  templateSchema,
} from './whatsapp.schemas.js';
import { unidadeDoBalcao } from './unidade.js';

/**
 * O canal de WhatsApp da casa (bloco 55, SPEC §4.12).
 *
 * ## Uma permissão, e ela não é de dinheiro
 *
 * `whatsapp.manage` cadastra o número e os textos. É configuração de como a casa
 * fala com o cliente — a mesma natureza de horário de funcionamento — e não move
 * centavo, então não deriva segundo fator.
 *
 * O que ela **não** dá é leitura de mensagem: quem chegou e quem leu é dado de
 * cliente, e sai por outra permissão quando essa tela existir.
 *
 * ## O provedor é um só, criado na montagem
 *
 * Como o emissor fiscal e o de mensagem do worker. Instanciar um dentro de cada
 * rota faria daquela rota a única que não troca junto quando a Cloud API de
 * verdade entrar — é a lição do bloco 39.
 */

const STATUS: Record<string, number> = {
  nao_configurado: 409,
  token_invalido: 400,
  template_nao_encontrado: 404,
  template_nao_aprovado: 409,
  numero_invalido: 400,
  nome_invalido: 400,
};

const STATUS_DO_SIGNUP: Record<string, number> = {
  sem_app: 409,
  codigo_invalido: 400,
  meta_recusou: 502,
};

function toHttp(erro: unknown): never {
  if (erro instanceof WhatsAppError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  /**
   * A frase da Meta chega ao balcão, e é decisão.
   *
   * Em quase todo o produto o erro para o cliente é genérico e o detalhe vai
   * para o log. Aqui não: quem está do outro lado é o dono da barbearia
   * conectando a **própria** conta, e "número já usado por outro app" ou
   * "empresa não tem permissão" é exatamente o que ele precisa ler para
   * resolver. Nenhuma dessas frases fala de outra barbearia — a conta é dele.
   */
  if (erro instanceof SignupError) {
    throw new DomainError(erro.code, STATUS_DO_SIGNUP[erro.code] ?? 400, erro.message);
  }
  /**
   * A recusa do provedor de verdade, pelo mesmo caminho — e ela faltava.
   *
   * `WhatsAppMetaError` é o que a Cloud API devolve quando o template é
   * recusado, o token não vale mais ou a conta não tem permissão. Sem esta
   * linha ele caía no `throw erro` abaixo, virava 500 do Nest, e a tela dizia
   * "Não deu para salvar. Tente de novo." — sobre um problema que **tentar de
   * novo não resolve**, com a frase da Meta jogada fora no meio do caminho.
   *
   * A decisão de mostrar a frase dela já está escrita acima, para o signup, e
   * vale igual aqui: quem está do outro lado é o dono da barbearia mexendo na
   * própria conta.
   *
   * 502 e não 400: quem recusou foi o serviço de fora, e o pedido do balcão
   * estava bem formado.
   */
  if (erro instanceof EnvioAvulsoError) {
    /**
     * `tipo_invalido` e `sem_texto_aprovado` são pedido malformado do ponto de
     * vista do produto; cliente inexistente é 404. Nenhum deles é falha nossa,
     * e todos têm frase escrita — a tela mostra a frase.
     */
    throw new DomainError(erro.code, erro.code === 'cliente_nao_encontrado' ? 404 : 409, erro.message);
  }
  if (erro instanceof WhatsAppMetaError) {
    /**
     * Código **próprio**, e a distinção não é cosmética.
     *
     * `meta_recusou` é a conexão do número. Reusá-lo aqui fez a tela dizer "a
     * Meta recusou a conexão" sobre uma recusa de **texto**, com o número já
     * conectado e o cartão dele desenhado logo abaixo — dois estados
     * embaralhados numa frase, que é a §6 pergunta 6.
     *
     * Os três estados sempre foram separados no banco e no motor: número
     * conectado, texto aprovado, automação ligada. Quem os misturava era a
     * mensagem.
     *
     * As rotas que usam o provedor são as de texto; a conexão passa por
     * `SignupError`, tratado acima.
     */
    throw new DomainError('meta_recusou_texto', 502, erro.message);
  }
  throw erro;
}

/**
 * O de mentira mudou de casa no bloco 133.
 *
 * Ele morava aqui e servia a uma coisa só: submeter template sem canal ligado.
 * Com a ida à Meta na fila, quem precisa dele é o worker — e mantê-lo aqui
 * também faria existir a **segunda** noção de "tem canal?", que é o defeito que
 * o comentário desta constante já descrevia. Hoje ele vive ao lado de
 * `provedorDoWhatsApp`, em `packages/crm`.
 */

@Controller('v1/admin/whatsapp')
@UseGuards(StaffGuard, PermissaoGuard)
export class WhatsAppController {
  private async unidade(staff: AuthenticatedStaff) {
    return unidadeDoBalcao(staff);
  }

  @Exige('whatsapp.manage')
  @Get('cadastro')
  async cadastro(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    return { cadastro: await cadastroDoWhatsApp(staff.tenantId, local.id) };
  }

  @Exige('whatsapp.manage')
  @Put('cadastro')
  async salvar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(cadastroDoWhatsAppSchema)) body: {
      phoneNumberId: string;
      wabaId: string;
      numeroVisivel?: string | null;
      token?: string;
    },
  ) {
    const local = await this.unidade(staff);
    try {
      return await salvarCadastroDoWhatsApp({
        tenantId: staff.tenantId,
        locationId: local.id,
        phoneNumberId: body.phoneNumberId,
        wabaId: body.wabaId,
        numeroVisivel: body.numeroVisivel ?? null,
        // Ausente é "não mexa": repassar `undefined` é o que preserva o token.
        ...(body.token ? { token: body.token } : {}),
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * O que a tela precisa para desenhar o botão "Conectar WhatsApp" (bloco 83).
   *
   * `appId` e `configId`, nunca o `appSecret`: os dois primeiros vão para o
   * `FB.login` dentro do navegador e são públicos por desenho; o terceiro
   * assina em nome do app inteiro. `null` quando o app não foi configurado — e
   * aí a tela **não desenha o botão**, porque um botão que abre uma janela
   * vazia é pior que botão nenhum.
   */
  @Exige('whatsapp.manage')
  @Get('signup')
  async signup(
    @Query(new ZodValidationPipe(signupDaTelaSchema)) query: {
      redirectUri?: string;
      state?: string;
    },
  ) {
    /**
     * O endereço da Meta sai pronto daqui, e o `redirectUri` vem da tela.
     *
     * Ela é quem sabe em que domínio está — a API serve a mesma instalação por
     * mais de um endereço em desenvolvimento. O que ela manda é conferido: só
     * `https` e só o caminho de volta que existe, senão esta rota viraria um
     * jeito de fazer a Meta redirecionar para onde alguém quiser com um código
     * válido na mão.
     */
    return { signup: signupNaTela({ redirectUri: query.redirectUri, state: query.state }) };
  }

  /**
   * A volta do Embedded Signup: o código vira token, e o cadastro é salvo.
   *
   * A troca acontece **aqui** e não no navegador porque ela exige o
   * `META_APP_SECRET`. Um fluxo que fizesse a troca do lado do cliente teria
   * que mandar o segredo do app junto, e aí qualquer pessoa com a aba aberta
   * passaria a poder trocar códigos em nome do produto.
   *
   * `whatsapp.manage` e nada mais: a rota não devolve cadastro de cliente, não
   * move centavo, e o que ela grava é o mesmo que o formulário já grava.
   */
  @Exige('whatsapp.manage')
  @Post('conectar')
  async conectar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(signupDoWhatsAppSchema)) body: {
      code: string;
      redirectUri?: string;
      wabaId?: string;
      phoneNumberId?: string;
      numeroVisivel?: string | null;
    },
  ) {
    const local = await this.unidade(staff);
    try {
      return {
        cadastro: await conectarPeloSignup({
          tenantId: staff.tenantId,
          locationId: local.id,
          code: body.code,
          // Presente é o caso do redirecionamento, e a Meta o exige idêntico ao
          // que abriu a janela. Ausente é a janela do SDK, onde mandá-lo é o
          // mesmo erro ao contrário.
          redirectUri: body.redirectUri,
          // Ausentes é o caso do celular: o domínio os descobre pelo token.
          wabaId: body.wabaId,
          phoneNumberId: body.phoneNumberId,
          numeroVisivel: body.numeroVisivel ?? null,
          staffId: staff.staffUserId,
          staffName: staff.name,
        }),
      };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * Manda uma mensagem para **um** cliente, do balcão (bloco 92).
   *
   * `marketing.send` e não `whatsapp.manage`: quem cadastra o número da casa e
   * quem fala com o cliente são trabalhos diferentes, e a recepção precisa do
   * segundo sem o primeiro.
   *
   * Sem canal ligado isto **recusa**, ao contrário do disparo automático — que
   * cai no canal de reserva de propósito, porque não há ninguém esperando. Aqui
   * há alguém no balcão que acabou de apertar o botão e vai dizer ao cliente
   * que mandou.
   */
  @Exige('marketing.send')
  @Post('mensagem')
  async mensagem(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(mensagemAvulsaSchema)) body: {
      customerId: string;
      tipo?: TipoDeNotificacao;
      templateId?: string;
    },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new DomainError(
        'idempotency_key_obrigatoria',
        400,
        'Mande um Idempotency-Key de até 128 caracteres para este envio.',
      );
    }
    const local = await this.unidade(staff);
    const zap = await provedorDoWhatsApp(staff.tenantId, local.id);
    if (!zap) {
      throw new DomainError(
        'sem_canal',
        409,
        'O WhatsApp da casa ainda não está ligado, então nada chega ao cliente.',
      );
    }

    try {
      return await enviarMensagemAvulsa({
        tenantId: staff.tenantId,
        locationId: local.id,
        customerId: body.customerId,
        ...(body.tipo === undefined ? {} : { tipo: body.tipo }),
        ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
        agora: new Date(),
        timeZone: local.timezone,
        staffId: staff.staffUserId,
        staffName: staff.name,
        // Escopada pelo operador, como toda chave deste produto: ela vem do
        // cliente e é livre, e duas recepcionistas no mesmo balcão mandando
        // "1" fariam a segunda ser recusada pelo envio da primeira.
        idempotencyKey: `${staff.staffUserId}:${idempotencyKey}`,
        enviar: async (destino) => {
          const saiu = await enviarPeloWhatsApp({
            tenantId: staff.tenantId,
            locationId: local.id,
            // O tipo do **texto escolhido**, resolvido pelo domínio: aqui o
            // corpo pode nem trazer `tipo`, e reler `body.tipo` faria a
            // mensagem sair pelo primeiro aprovado de outro tipo.
            tipo: destino.tipo,
            templateId: destino.templateId,
            telefone: destino.telefone,
            // A ordem é a de `VARIAVEIS_DO_AVISO` para os tipos de campanha:
            // nome do cliente, nome da barbearia. Quem corta pelo tamanho do
            // texto aprovado é `enviarPeloWhatsApp`.
            variaveis: [destino.clienteNome, destino.barbearia],
            customerId: body.customerId,
            appointmentId: null,
            provider: zap,
          });
          return saiu?.wamid ?? null;
        },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * Pergunta à Meta agora, em vez de esperar a volta do relógio.
   *
   * A conciliação do bloco 90 roda de hora em hora, e isso é certo para o
   * conjunto. Errado é ser o **único** caminho: quem aprova o texto no painel
   * da Meta volta para cá em segundos, lê "Na Meta" e conclui que a tela está
   * travada — o mecanismo existia e não tinha como ser acionado por quem estava
   * olhando.
   *
   * Mesma função da varredura, então não há segunda noção de "o que a Meta
   * respondeu". Sem canal ligado ela devolve zero e não falha: pedir notícia de
   * quem não foi perguntado é resposta vazia, não erro.
   */
  @Exige('whatsapp.manage')
  @Post('conciliar')
  async conciliar(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    try {
      return await conciliarWhatsAppDaUnidade(staff.tenantId, local.id, new Date());
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('whatsapp.manage')
  @Get('templates')
  async templates(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    return { templates: await templatesDaUnidade(staff.tenantId, local.id) };
  }

  @Exige('whatsapp.manage')
  @Post('templates')
  async submeter(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(templateSchema)) body: {
      tipo: TipoDeNotificacao;
      nome?: string;
      titulo?: string;
      botoes?: BotaoDaMensagem[];
      acoes?: BotaoQueLeva[];
      corpo: string;
    },
  ) {
    const local = await this.unidade(staff);
    try {
      return await submeterTemplate({
        tenantId: staff.tenantId,
        locationId: local.id,
        tipo: body.tipo,
        // Ausente é o caminho normal: o nome sai do título, e sem título do tipo.
        ...(body.nome ? { nome: body.nome } : {}),
        ...(body.titulo ? { titulo: body.titulo } : {}),
        ...(body.botoes ? { botoes: body.botoes } : {}),
        ...(body.acoes ? { acoes: body.acoes } : {}),
        corpo: body.corpo,
        /**
         * Sem provedor: a ida à Meta é da fila desde o bloco 133.
         *
         * A rota reserva a linha, enfileira a entrega **na mesma transação** e
         * devolve o texto em `pendente`. Medido aqui, a viagem à Meta custava
         * 7.039 ms de uma requisição do balcão, contra o teto de 10 s do `web`
         * — e estourar significava dizer "não deu" sobre um texto que a Meta já
         * tinha recebido.
         */
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
