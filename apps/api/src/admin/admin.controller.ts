import { Body, Controller, Delete, Get, HttpCode, Inject, Logger, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  revokeStaffSession,
  revokeStaffSessionByToken,
  signUpOwner,
  StaffError,
  staffLogin,
  type AuthenticatedStaff,
} from '@barbearia/identity';
import { imagemPublica } from '@barbearia/core';
import {
  getOnboardingState,
  getPhotoTargets,
  OnboardingError,
  publish,
  saveBusiness,
  saveChangeWindow,
  getPolicies,
  savePayments,
  saveProfessionals,
  savePhotos,
  saveServices,
  templatesForOnboarding,
} from '@barbearia/onboarding';
import { BloqueioDeLogin } from '@barbearia/identity';
import { recusasRecentes } from '@barbearia/scheduling';
import {
  atualizarVitrineDaCasa,
  definirVitrine,
  lerVitrine,
  recursosDaBarbearia,
} from '@barbearia/platform';
import { DomainError, notFound } from '../common/errors.js';
import { TenantService } from '../tenant/tenant.service.js';
import { guardarImagemPublica, tentarApagarImagemPublica, TETO_IMAGEM_PUBLICA } from '../media/storage.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { verificarTurnstile } from '../common/turnstile.js';
import { contaBloqueada, Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { selecaoDoBalcao, unidadeDoBalcao } from './unidade.js';
import {
  businessSchema,
  vitrineSchema,
  changeWindowSchema,
  loginSchema,
  paymentsSchema,
  photosSchema,
  professionalsSchema,
  servicesSchema,
  signUpSchema,
} from './admin.schemas.js';

const STAFF_STATUS: Record<string, number> = {
  invalid_credentials: 401,
  invalid_session: 401,
  slug_taken: 409,
  invalid_phone: 400,
  weak_password: 400,
};

const ONBOARDING_STATUS: Record<string, number> = {
  unknown_tenant: 404,
  invalid_catalog: 422,
  nothing_to_publish: 409,
  slug_taken: 409,
  location_not_found: 404,
  ja_publicada: 409,
};

function toHttp(error: unknown): never {
  /**
   * A escada de espera responde 429, e não 500 (bloco 33).
   *
   * Sem este ramo ela caía no tratador genérico e virava erro do servidor: a
   * pessoa via "algo deu errado" numa situação que tem explicação e prazo, e o
   * monitoramento contava como falha de infraestrutura o que é o produto
   * funcionando. `Retry-After` em segundos é o que o cliente HTTP entende.
   */
  if (error instanceof BloqueioDeLogin) {
    throw new DomainError('too_many_attempts', 429, error.message, {
      retryAfterSeconds: error.esperarSegundos,
    });
  }
  if (error instanceof StaffError) {
    throw new DomainError(error.code, STAFF_STATUS[error.code] ?? 400, error.message);
  }
  if (error instanceof OnboardingError) {
    // O detalhe diz **qual** combo está errado. Sem ele a tela só conseguiria
    // dizer "dados inválidos", e o dono não saberia o que corrigir.
    throw new DomainError(
      error.code,
      ONBOARDING_STATUS[error.code] ?? 400,
      error.message,
      error.detail,
    );
  }
  throw error;
}

/**
 * Criar conta e entrar — **sem sessão**, por definição.
 *
 * As duas rotas mais atacadas do painel. O limitador global cobre a rajada; o
 * que este código garante é que a resposta não distingue conta existente de
 * inexistente, nem no código nem no tempo (ver `staffLogin`).
 */
@Controller('v1/admin')
export class StaffAuthController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  /**
   * Cria a conta.
   *
   * **Responde igual para e-mail livre e e-mail já cadastrado**, e nunca devolve
   * sessão. Um 409 "e-mail já existe" contra um 201 seria oráculo de quem é dono
   * de barbearia na plataforma — a lista que o HMAC em `staff_directory` existe
   * para proteger, entregue por HTTP e sem precisar de dump nenhum.
   *
   * O custo é um login logo em seguida. Quem acabou de criar entra com a senha
   * que escolheu; quem já tinha conta entra com a que já tinha. Nos dois casos a
   * tela seguinte é a mesma, e nenhuma delas conta nada sobre a outra.
   */
  @Post('signup')
  @HttpCode(202)
  async signup(
    @Body(new ZodValidationPipe(signUpSchema))
    body: {
      name: string;
      email: string;
      password: string;
      phone: string;
      businessName: string;
      turnstileToken?: string;
    },
    @Req() request: Request,
  ) {
    try {
      const humano = await verificarTurnstile({
        // REPARO DA VALIDAÇÃO: mesma regra do `ip` logo abaixo — com
        // `exactOptionalPropertyTypes`, a chave presente valendo `undefined`
        // não é a chave ausente.
        ...(body.turnstileToken ? { token: body.turnstileToken } : {}),
        ...(request.ip ? { ip: request.ip } : {}),
        action: 'signup',
      });
      if (!humano.ok) {
        throw new DomainError(
          humano.code === 'provedor_indisponivel' ? 'bot_verification_unavailable' : 'bot_verification_failed',
          humano.code === 'provedor_indisponivel' ? 503 : 403,
          humano.code === 'provedor_indisponivel'
            ? 'Não foi possível validar a proteção anti-bot agora.'
            : 'Não foi possível validar esta tentativa.',
        );
      }

      const { turnstileToken: _turnstileToken, ...dadosDaConta } = body;
      const resultado = await signUpOwner({
        ...dadosDaConta,
        issueSession: false,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
        ...(request.ip ? { ip: request.ip } : {}),
      });

      if (resultado.created) {
        // O slug nasceu agora. Se alguém o consultou antes, o cache guarda a
        // ausência e a página responderia 404 por um minuto.
        this.tenants.forget(resultado.slug);
      }

      return { next: 'login' };
    } catch (error) {
      return toHttp(error);
    }
  }

  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: { email: string; password: string },
    @Req() request: Request,
  ) {
    try {
      const sessao = await staffLogin({
        ...body,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
        ...(request.ip ? { ip: request.ip } : {}),
      });

      // Depois de conferir a senha, e de propósito: recusar antes diria "esta
      // barbearia está bloqueada" a quem só chutou um e-mail, o que entrega à
      // internet a lista de quem está inadimplente na plataforma.
      try {
        const bloqueio = await this.tenants.bloqueio(sessao.tenantId);
        if (bloqueio.bloqueada) {
          throw contaBloqueada(bloqueio.motivo);
        }
        return sessao;
      } catch (erro) {
        // `staffLogin` precisou provar a senha e já gravou a sessão. Qualquer
        // falha depois disso — conta bloqueada **ou** indisponibilidade ao ler o
        // bloqueio — significa que o token não será entregue. A linha também
        // não pode ficar viva no banco como aparelho fantasma. A limpeza é
        // best-effort para não esconder o erro original se o próprio banco caiu.
        try {
          await revokeStaffSessionByToken(sessao.token);
        } catch {
          // O erro original é a informação útil para a borda HTTP.
        }
        throw erro;
      }
    } catch (error) {
      return toHttp(error);
    }
  }
}

/**
 * Onboarding e configuração — **sessão obrigatória**.
 *
 * Nenhuma rota recebe `tenantId`: ele vem do token, sempre. Aceitá-lo do corpo
 * ou da URL deixaria um gestor tentar administrar a barbearia do vizinho, e a
 * RLS só protege quem lembra de passar o tenant certo.
 */
@Controller('v1/admin')
@UseGuards(StaffGuard, PermissaoGuard)
export class OnboardingController {
  private readonly logger = new Logger(OnboardingController.name);

  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  /**
   * A unidade da sessão para quem **lê**, e nada quando não dá para resolver.
   *
   * `unidadeDoBalcao` lança, e é o certo em rota que grava. Numa rota de leitura
   * que é o estado do painel inteiro, lançar trancaria a conta para fora de tudo
   * por causa de um vínculo de unidade mal configurado — o `undefined` cai na
   * unidade mais antiga, que é o comportamento anterior ao bloco 58.
   */
  private async unidadeOuNada(staff: AuthenticatedStaff): Promise<string | undefined> {
    const selecao = await selecaoDoBalcao(staff);
    return selecao.atual?.id ?? selecao.disponiveis.find((u) => u.ativa)?.id;
  }

  @Exige()
  @Post('logout')
  async logout(@Staff() staff: AuthenticatedStaff) {
    await revokeStaffSession(staff.tenantId, staff.sessionId);
    return { revoked: true };
  }

  @Exige('appointments.view')
  @Get('state')
  async state(@Staff() staff: AuthenticatedStaff) {
    /**
     * O estado é o da **unidade da sessão**, desde o bloco 111.
     *
     * A etapa 2 do onboarding lê daqui para vir preenchida, e preencher com o
     * cadastro da matriz na tela do gerente da filial seria oferecer a ele o
     * botão que sobrescreve a loja errada. `unidadeDoBalcao` recusa quem não
     * tem unidade legível, e esta rota não pode recusar — ela é o estado do
     * painel inteiro —, então a falha cai no comportamento anterior: a mais
     * antiga.
     */
    const local = await this.unidadeOuNada(staff);
    const estado = await getOnboardingState(staff.tenantId, local);
    if (!estado) throw notFound('unknown_tenant', 'Barbearia não encontrada');

    /**
     * A loja em que a pessoa está, para o casco dizer.
     *
     * A tela de Unidades promete em letras — *"Caixa, comanda e agenda são
     * desta loja. Trocar aqui troca em todas as telas"* — e nenhuma das outras
     * mencionava a loja: cinco telas visitadas depois de trocar continuavam
     * exibindo só o nome da rede. A recepcionista que atende nas duas abria o
     * Caixa sem saber qual gaveta ia abrir, e é isso que transforma um erro de
     * escopo em erro de operação.
     *
     * `ehRede` decide se a linha aparece: numa barbearia de uma loja só, o nome
     * da unidade embaixo do nome da casa é ruído — é a mesma decisão do seletor
     * de uma opção só.
     */
    const selecao = await selecaoDoBalcao(staff);
    // As permissões saem daqui, resolvidas do papel na mesma consulta da
    // sessão: a tela mostra o que a API aplica, nunca uma cópia da lista
    // (CLAUDE.md). E é uma ida ao banco a menos que uma rota `/me` por página.
    return {
      ...estado,
      /**
       * Os recursos ligados para esta conta, pela **mesma função** que a
       * `PermissaoGuard` consulta.
       *
       * É o desenho de `permissions` logo abaixo, pela mesma razão: o menu
       * esconde o que a guarda recusaria, e um segundo jeito de responder
       * "esta barbearia tem fiscal?" divergiria do primeiro no dia em que
       * alguém mudasse um dos dois. Sai só a lista de códigos ligados — nome e
       * descrição do catálogo são da tela da plataforma, não desta.
       *
       * Não é dado sensível e não amplia o `@Exige` da rota: o que ela diz a
       * quem já está autenticado é quais telas da própria casa existem.
       */
      recursos: (await recursosDaBarbearia(staff.tenantId))
        .filter((r) => r.ligado)
        .map((r) => r.code),
      staff: {
        name: staff.name,
        role: staff.role,
        permissions: staff.permissions,
        // A tela do barbeiro precisa saber que ele **é** um barbeiro para se
        // desviar até ela. O recorte por profissional continua sendo decidido
        // no servidor, a partir da sessão — isto aqui só decide para onde ir.
        professionalId: staff.professionalId,
        /**
         * Sessão de suporte da plataforma (bloco 26).
         *
         * A tela precisa saber para **avisar**. As duas se parecem — mesmo
         * tema, mesmos componentes —, e um funcionário nosso que esquece em
         * qual conta está lê o número de outra barbearia como se fosse o do
         * cliente com quem está falando ao telefone.
         */
        suporte: staff.impersonatedBy !== null,
      },
      unidade: selecao.atual
        ? {
            id: selecao.atual.id,
            nome: selecao.atual.nome,
            /** Só numa rede a linha vale a pena; com uma loja é ruído. */
            ehRede: selecao.disponiveis.length > 1,
          }
        : null,
    };
  }

  /** Catálogo sugerido, com duração e buffer coerentes — D4 na origem. */
  @Exige('settings.manage')
  @Get('templates')
  templates() {
    return { templates: templatesForOnboarding() };
  }

  @Exige('settings.manage')
  @Put('business')
  async business(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(businessSchema)) body: Record<string, unknown>,
  ) {
    try {
      /**
       * A unidade da sessão, obrigatória desde o bloco 111.
       *
       * Sem ela o `UPDATE` do domínio não tinha `WHERE` e reescrevia a rede
       * inteira; e o gerente escopado a uma filial editaria a matriz. Aqui a
       * recusa é legítima — esta rota **grava** —, então `unidadeDoBalcao` vale
       * com a exceção que ela mesma lança.
       */
      const local = await unidadeDoBalcao(staff);
      const salvo = await saveBusiness({
        tenantId: staff.tenantId,
        locationId: local.id,
        ...body,
      } as Parameters<typeof saveBusiness>[0]);
      // Endereço, coordenada, comodidade e a opção de sair da vitrine mudam
      // aqui: sem esta chamada, o card do marketplace ficaria com o endereço
      // antigo até a varredura da madrugada.
      await atualizarVitrineDaCasa(staff.tenantId);
      return salvo;
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('settings.manage')
  @Put('services')
  async services(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(servicesSchema)) body: { services: Parameters<typeof saveServices>[1] },
  ) {
    try {
      return await saveServices(staff.tenantId, body.services);
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('settings.manage')
  @Put('professionals')
  async professionals(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(professionalsSchema))
    body: { professionals: Parameters<typeof saveProfessionals>[2] },
  ) {
    try {
      // Esta rota grava: seleção inválida não pode cair silenciosamente na
      // unidade mais antiga, como o helper tolerante das telas de leitura.
      const local = await unidadeDoBalcao(staff);
      return await saveProfessionals(staff.tenantId, local.id, body.professionals);
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('settings.manage')
  @Put('payments')
  async payments(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(paymentsSchema)) body: { methods: Parameters<typeof savePayments>[2] },
  ) {
    const local = await unidadeDoBalcao(staff);
    await savePayments(staff.tenantId, local.id, body.methods);
    return { saved: true };
  }

  /**
   * O interruptor da vitrine (bloco 70).
   *
   * Rota própria, e não um campo em `PUT /business`: aquela grava o cadastro
   * inteiro, e mexer num interruptor por ela exigiria reenviar endereço,
   * telefone e comodidades — o caminho em que um campo vazio apaga o que
   * ninguém queria apagar.
   */
  @Exige('settings.manage')
  @Get('vitrine')
  async lerNaVitrine(@Staff() staff: AuthenticatedStaff) {
    return lerVitrine(staff.tenantId);
  }

  @Exige('settings.manage')
  @Put('vitrine')
  async definirNaVitrine(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(vitrineSchema)) corpo: { ligado: boolean },
  ) {
    const local = await unidadeDoBalcao(staff);
    return definirVitrine({ tenantId: staff.tenantId, locationId: local.id, ligado: corpo.ligado });
  }

  @Exige('settings.manage')
  @Post('publish')
  async publicar(@Staff() staff: AuthenticatedStaff) {
    try {
      const publicado = await publish(staff.tenantId);
      this.tenants.forget(publicado.slug);
      /**
       * A vitrine é refeita aqui porque publicar é o evento (bloco 70).
       *
       * Cache invalidado por evento, nunca só por TTL — a regra do bloco 8. A
       * varredura diária existe como rede para o que muda sem passar por aqui
       * (preço, nota, clube); o que não pode é a barbearia publicar e não
       * aparecer na busca até amanhã.
       */
      await atualizarVitrineDaCasa(staff.tenantId);
      return publicado;
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * O que a barbearia pode ilustrar, com o que já está preenchido.
   *
   * A tela precisa da lista para montar um campo por profissional e por
   * serviço — sem ela o dono teria que descobrir os ids sozinho.
   */
  @Exige('settings.manage')
  @Get('photos')
  async photos(@Staff() staff: AuthenticatedStaff) {
    const local = await unidadeDoBalcao(staff);
    const alvos = await getPhotoTargets(staff.tenantId, local.id);
    if (!alvos) throw notFound('unknown_tenant', 'Barbearia não encontrada');
    return alvos;
  }


  /**
   * Recebe uma imagem já preparada pelo navegador e a hospeda no Barberdock.
   *
   * O arquivo não viaja em JSON/base64: o corpo é o próprio binário. O teto e
   * a assinatura são conferidos de novo aqui, porque `accept=image/*` e canvas
   * são conveniência de interface, nunca fronteira de segurança.
   */
  @Exige('settings.manage')
  @Post('photos/upload')
  async uploadPhoto(
    @Staff() staff: AuthenticatedStaff,
    @Req() requisicao: Request,
    @Query('target') target: string | undefined,
    @Query('id') id: string | undefined,
  ) {
    if (!['cover', 'logo', 'professional', 'service'].includes(target ?? '')) {
      throw new DomainError('invalid_photo_target', 400, 'Destino da foto inválido');
    }
    if ((target === 'professional' || target === 'service') && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id ?? '')) {
      throw new DomainError('invalid_photo_target', 400, 'Destino da foto inválido');
    }

    const partes: Buffer[] = [];
    let total = 0;
    for await (const parte of requisicao) {
      const bytes = Buffer.isBuffer(parte) ? parte : Buffer.from(parte as Uint8Array);
      total += bytes.byteLength;
      if (total > TETO_IMAGEM_PUBLICA) {
        throw new DomainError('photo_too_large', 413, 'A imagem preparada passa de 3 MB');
      }
      partes.push(bytes);
    }
    const corpo = Buffer.concat(partes);

    const local = await unidadeDoBalcao(staff);
    const atuais = await getPhotoTargets(staff.tenantId, local.id);
    if (!atuais) throw notFound('unknown_tenant', 'Barbearia não encontrada');
    if (target === 'professional' && !atuais.professionals.some((p) => p.id === id)) {
      throw notFound('photo_target_not_found', 'Profissional não encontrado');
    }
    if (target === 'service' && !atuais.services.some((s) => s.id === id)) {
      throw notFound('photo_target_not_found', 'Serviço não encontrado');
    }
    const anterior = target === 'cover'
      ? atuais.coverUrl
      : target === 'logo'
        ? atuais.logoUrl
        : target === 'professional'
          ? atuais.professionals.find((p) => p.id === id)?.photoUrl ?? null
          : atuais.services.find((s) => s.id === id)?.photoUrl ?? null;

    let guardada: Awaited<ReturnType<typeof guardarImagemPublica>>;
    try {
      guardada = await guardarImagemPublica(staff.tenantId, corpo);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'media_tamanho_invalido') {
        throw new DomainError('photo_too_large', 413, 'A imagem preparada passa de 3 MB');
      }
      if (code === 'media_tipo_invalido') {
        throw new DomainError('invalid_photo_type', 415, 'Envie uma imagem WebP, JPEG ou PNG');
      }
      throw error;
    }

    try {
      await savePhotos(staff.tenantId, local.id,
        target === 'cover' ? { coverUrl: guardada.url }
          : target === 'logo' ? { logoUrl: guardada.url }
            : target === 'professional' ? { professionals: [{ id: id!, photoUrl: guardada.url }] }
              : { services: [{ id: id!, photoUrl: guardada.url }] },
      );
    } catch (error) {
      if (!(await tentarApagarImagemPublica(guardada.url, staff.tenantId))) {
        this.logger.warn('Falha ao limpar mídia nova após erro ao salvar referência; arquivo ficou órfão para reconciliação.');
      }
      throw error;
    }

    // A referência nova já foi commitada. Falha ao remover o arquivo antigo
    // pode deixar órfão para reconciliação, mas não pode responder 500 como se
    // a troca tivesse falhado.
    if (!(await tentarApagarImagemPublica(anterior, staff.tenantId))) {
      this.logger.warn('Falha ao limpar mídia substituída; referência nova já está válida e o arquivo antigo ficou órfão para reconciliação.');
    }
    return { url: guardada.url, bytes: guardada.bytes, contentType: guardada.tipo };
  }

  @Exige('settings.manage')
  @Delete('photos/upload')
  async removeUploadedPhoto(
    @Staff() staff: AuthenticatedStaff,
    @Query('target') target: string | undefined,
    @Query('id') id: string | undefined,
  ) {
    if (!['cover', 'logo', 'professional', 'service'].includes(target ?? '')) {
      throw new DomainError('invalid_photo_target', 400, 'Destino da foto inválido');
    }
    if ((target === 'professional' || target === 'service') && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id ?? '')) {
      throw new DomainError('invalid_photo_target', 400, 'Destino da foto inválido');
    }
    const local = await unidadeDoBalcao(staff);
    const atuais = await getPhotoTargets(staff.tenantId, local.id);
    if (!atuais) throw notFound('unknown_tenant', 'Barbearia não encontrada');
    if (target === 'professional' && !atuais.professionals.some((p) => p.id === id)) {
      throw notFound('photo_target_not_found', 'Profissional não encontrado');
    }
    if (target === 'service' && !atuais.services.some((s) => s.id === id)) {
      throw notFound('photo_target_not_found', 'Serviço não encontrado');
    }
    const anterior = target === 'cover'
      ? atuais.coverUrl
      : target === 'logo'
        ? atuais.logoUrl
        : target === 'professional'
          ? atuais.professionals.find((p) => p.id === id)?.photoUrl ?? null
          : atuais.services.find((s) => s.id === id)?.photoUrl ?? null;

    await savePhotos(staff.tenantId, local.id,
      target === 'cover' ? { coverUrl: null }
        : target === 'logo' ? { logoUrl: null }
          : target === 'professional' ? { professionals: [{ id: id!, photoUrl: null }] }
            : { services: [{ id: id!, photoUrl: null }] },
    );
    // Banco já é a fonte de verdade; exclusão física é limpeza best-effort.
    if (!(await tentarApagarImagemPublica(anterior, staff.tenantId))) {
      this.logger.warn('Falha ao limpar mídia removida; banco já foi atualizado e o arquivo físico ficou órfão para reconciliação.');
    }
    return { removed: true };
  }

  /**
   * Compatibilidade para remover/substituir fotos já cadastradas.
   *
   * Depois do R9 esta rota só aceita caminhos `/media/...` gerados pelo nosso
   * armazenamento (ou vazio para remover). URL externa nova é recusada: a página
   * pública não volta a depender silenciosamente de host de terceiro.
   *
   * Campo **ausente** é diferente de campo **vazio**: ausente não é tocado,
   * vazio apaga. Sem essa distinção, salvar a foto de um barbeiro apagaria a
   * dos outros.
   */
  @Exige('settings.manage')
  @Put('photos')
  async savePhotos(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(photosSchema))
    body: {
      coverUrl?: string;
      logoUrl?: string;
      professionals?: { id: string; photoUrl: string }[];
      services?: { id: string; photoUrl: string }[];
    },
  ) {
    const local = await unidadeDoBalcao(staff);
    const fotoDaCasa = (valor: string): string | null => {
      const aceita = imagemPublica(valor);
      return aceita?.startsWith(`/media/${staff.tenantId}/`) ? aceita : null;
    };
    const resultado = await savePhotos(staff.tenantId, local.id, {
      ...(body.coverUrl !== undefined ? { coverUrl: fotoDaCasa(body.coverUrl) } : {}),
      ...(body.logoUrl !== undefined ? { logoUrl: fotoDaCasa(body.logoUrl) } : {}),
      ...(body.professionals
        ? {
            professionals: body.professionals.map((p) => ({
              id: p.id,
              photoUrl: fotoDaCasa(p.photoUrl),
            })),
          }
        : {}),
      ...(body.services
        ? {
            services: body.services.map((s) => ({
              id: s.id,
              photoUrl: fotoDaCasa(s.photoUrl),
            })),
          }
        : {}),
    });

    // A barbearia precisa saber que a URL foi recusada. Devolver o estado real
    // deixa a tela comparar com o que foi enviado sem inventar mensagem.
    return { ...resultado, photos: await getPhotoTargets(staff.tenantId, local.id) };
  }

  /**
   * As políticas da casa, preenchidas.
   *
   * Existe porque o bloco 30 acrescentou o teto de desconto, e um campo que a
   * tela não sabe ler começa vazio a cada visita — o dono muda para 30%, volta
   * na semana seguinte e vê 20% escrito, sem ter mudado nada.
   */
  @Exige('settings.manage')
  @Get('policies')
  async policies(@Staff() staff: AuthenticatedStaff) {
    const local = await unidadeDoBalcao(staff);
    const politicas = await getPolicies(staff.tenantId, local.id);
    if (!politicas) throw notFound('unknown_tenant', 'Barbearia não encontrada');
    return politicas;
  }

  @Exige('settings.manage')
  @Put('change-window')
  async changeWindow(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(changeWindowSchema))
    body: Parameters<typeof saveChangeWindow>[2],
  ) {
    const local = await unidadeDoBalcao(staff);
    await saveChangeWindow(staff.tenantId, local.id, body);
    return { saved: true };
  }

  /**
   * As recusas que a regra do score produziu (bloco 60).
   *
   * `appointments.view` **e** `customers.view`: a lista devolve o nome de quem
   * foi recusado. Uma rota que agrega declara todas as permissões do que
   * devolve, e não a mais próxima do nome — é a regra que este projeto já
   * quebrou três vezes.
   */
  @Exige('appointments.view', 'customers.view')
  @Get('recusas-online')
  async recusas(@Staff() staff: AuthenticatedStaff) {
    return { recusas: await recusasRecentes(staff.tenantId) };
  }
}
