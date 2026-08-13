import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { throttlerConfig } from './common/throttler.config.js';
import { BookingController } from './booking/booking.controller.js';
import {
  AppointmentsController,
  GuestAppointmentsController,
} from './booking/appointments.controller.js';
import { AuthController, SessionController } from './auth/auth.controller.js';
import { OnboardingController, StaffAuthController } from './admin/admin.controller.js';
import { BoardController } from './admin/board.controller.js';
import { CatalogoController } from './admin/catalogo.controller.js';
import { AgendaController } from './admin/agenda.controller.js';
import { FilaController } from './admin/fila.controller.js';
import { CaixaController } from './admin/caixa.controller.js';
import { MfaController } from './admin/mfa.controller.js';
import { ComissaoController } from './admin/comissao.controller.js';
import { AvisosController } from './admin/avisos.controller.js';
import { FichaController } from './admin/ficha.controller.js';
import { ProController } from './admin/pro.controller.js';
import { PainelController } from './admin/painel.controller.js';
import { PlanoController } from './admin/plano.controller.js';
import { SessoesController } from './admin/sessoes.controller.js';
import { AlertasController } from './admin/alertas.controller.js';
import { LgpdController } from './admin/lgpd.controller.js';
import { ImportacaoController } from './admin/importacao.controller.js';
import { SinalController } from './admin/sinal.controller.js';
import { FilaPublicaController } from './booking/fila-publica.controller.js';
import {
  EsperaDoClienteController,
  EsperaPublicaController,
} from './booking/espera.controller.js';
import { OfertaPublicaController } from './booking/oferta.controller.js';
import { RecadoPublicoController } from './booking/recado.controller.js';
import { RecadoController } from './admin/recado.controller.js';
import { FidelidadeController } from './admin/fidelidade.controller.js';
import { PacoteController } from './admin/pacote.controller.js';
import { FinanceiroController } from './admin/financeiro.controller.js';
import { DreController } from './admin/dre.controller.js';
import { FiscalController } from './admin/fiscal.controller.js';
import { WhatsAppController } from './admin/whatsapp.controller.js';
import { AutomacaoController } from './admin/automacao.controller.js';
import { CampanhaController } from './admin/campanha.controller.js';
import { SegmentoController } from './admin/segmento.controller.js';
import { ChurnController } from './admin/churn.controller.js';
import { MultiunidadeController } from './admin/multiunidade.controller.js';
import { AvaliacaoController } from './admin/avaliacao.controller.js';
import { EstoqueController } from './admin/estoque.controller.js';
import { AssinaturaController } from './admin/assinatura.controller.js';
import { FidelidadeDoClienteController } from './booking/fidelidade.controller.js';
import { PacoteDoClienteController } from './booking/pacote.controller.js';
import { AssinaturaDoClienteController } from './booking/assinatura.controller.js';
import { SplitController } from './admin/split.controller.js';
import { AvaliacaoDoClienteController } from './booking/avaliacao.controller.js';
import { MeController, TeamController } from './admin/team.controller.js';
import {
  PlataformaAuthController,
  PlataformaController,
} from './plataforma/plataforma.controller.js';
import { WebhookDoPspController } from './plataforma/webhook.controller.js';
import { StripeWebhookController } from './plataforma/stripe-webhook.controller.js';
import { WhatsAppWebhookController } from './plataforma/whatsapp-webhook.controller.js';
import { PlataformaGuard } from './plataforma/plataforma.guard.js';
import { PermissaoGuard } from './admin/permissao.guard.js';
import { StaffGuard } from './admin/staff.guard.js';
import { CustomerGuard } from './auth/customer.guard.js';
import { MESSAGING_PROVIDER } from './auth/messaging.token.js';
import { ConsoleMessagingProvider } from '@barbearia/identity';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { HealthController } from './common/health.controller.js';
import { LogInterceptor } from './common/log.interceptor.js';
import { SuporteInterceptor } from './admin/suporte.interceptor.js';
import { TenantService } from './tenant/tenant.service.js';

@Module({
  imports: [ThrottlerModule.forRoot(throttlerConfig())],
  controllers: [
    HealthController,
    BookingController,
    AuthController,
    SessionController,
    StaffAuthController,
    OnboardingController,
    BoardController,
    CatalogoController,
    FilaController,
    AgendaController,
    CaixaController,
    MfaController,
    ComissaoController,
    AvisosController,
    FichaController,
    ProController,
    PainelController,
    PlanoController,
    LgpdController,
    SessoesController,
    AlertasController,
    ImportacaoController,
    SinalController,
    EsperaPublicaController,
    EsperaDoClienteController,
    OfertaPublicaController,
    RecadoPublicoController,
    RecadoController,
    FidelidadeController,
    PacoteController,
    FinanceiroController,
    DreController,
    FiscalController,
    WhatsAppController,
    AutomacaoController,
    CampanhaController,
    SegmentoController,
    ChurnController,
    MultiunidadeController,
    AvaliacaoController,
    EstoqueController,
    AssinaturaController,
    FidelidadeDoClienteController,
    PacoteDoClienteController,
    AssinaturaDoClienteController,
    SplitController,
    AvaliacaoDoClienteController,
    FilaPublicaController,
    TeamController,
    MeController,
    GuestAppointmentsController,
    AppointmentsController,
    PlataformaAuthController,
    PlataformaController,
    WebhookDoPspController,
    StripeWebhookController,
    WhatsAppWebhookController,
  ],
  providers: [
    TenantService,
    StaffGuard,
    PermissaoGuard,
    CustomerGuard,
    PlataformaGuard,
    // Provedor real do WhatsApp entra no bloco 55. Até lá, o de console — que
    // nunca imprime o código.
    { provide: MESSAGING_PROVIDER, useClass: ConsoleMessagingProvider },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: LogInterceptor },
    // Depois do log, e obrigatório para todas as rotas: a trilha de suporte não
    // pode depender de alguém lembrar de decorar o controller certo.
    { provide: APP_INTERCEPTOR, useClass: SuporteInterceptor },
  ],
})
export class AppModule {}
