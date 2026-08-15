import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  WhatsAppError,
  SignupError,
  cadastroDoWhatsApp,
  conectarPeloSignup,
  provedorDoWhatsApp,
  signupNaTela,
  salvarCadastroDoWhatsApp,
  submeterTemplate,
  templatesDaUnidade,
} from '@barbearia/crm';
import { FakeWhatsAppProvider, type TipoDeNotificacao } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import {
  cadastroDoWhatsAppSchema,
  signupDaTelaSchema,
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
  throw erro;
}

/**
 * O de mentira, **só** quando não há canal ligado (bloco 82).
 *
 * Ele responde `pendente` ao submeter template — o estado real de um
 * recém-enviado, que a Meta leva de minutos a dias para mover. É o que faz a
 * cadeia de conciliação ser percorrida pelo caminho real em vez de pulada por
 * um fake otimista.
 *
 * O que mudou: com `WHATSAPP_MODO=meta` e o cadastro preenchido, quem submete é
 * o provedor de verdade. Deixá-lo fixo aqui era o defeito que o comentário
 * deste arquivo já previa em outras palavras — **dois lugares para ligar o
 * canal**, com o worker mandando pela Meta e o painel submetendo template para
 * o vazio. E a consequência era a pior possível: o template ficava `pendente`
 * para sempre, `enviarPeloWhatsApp` recusa quem não está `aprovado`, e a
 * mensagem caía no canal de reserva **para sempre**, com a tela dizendo
 * "Ativo".
 */
const FAKE = new FakeWhatsAppProvider();

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
      nome: string;
      corpo: string;
    },
  ) {
    const local = await this.unidade(staff);
    try {
      return await submeterTemplate({
        tenantId: staff.tenantId,
        locationId: local.id,
        tipo: body.tipo,
        nome: body.nome,
        corpo: body.corpo,
        // O de verdade quando há canal ligado; o de mentira só como último
        // recurso, para a tela continuar exercitável sem conta na Meta.
        provider: (await provedorDoWhatsApp(staff.tenantId, local.id)) ?? FAKE,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
