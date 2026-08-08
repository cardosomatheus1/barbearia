import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
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
import { FilaPublicaController } from './booking/fila-publica.controller.js';
import { MeController, TeamController } from './admin/team.controller.js';
import { PermissaoGuard } from './admin/permissao.guard.js';
import { StaffGuard } from './admin/staff.guard.js';
import { CustomerGuard } from './auth/customer.guard.js';
import { MESSAGING_PROVIDER } from './auth/messaging.token.js';
import { ConsoleMessagingProvider } from '@barbearia/identity';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { TenantService } from './tenant/tenant.service.js';

@Module({
  imports: [ThrottlerModule.forRoot(throttlerConfig())],
  controllers: [
    BookingController,
    AuthController,
    SessionController,
    StaffAuthController,
    OnboardingController,
    BoardController,
    CatalogoController,
    FilaController,
    AgendaController,
    FilaPublicaController,
    TeamController,
    MeController,
    GuestAppointmentsController,
    AppointmentsController,
  ],
  providers: [
    TenantService,
    StaffGuard,
    PermissaoGuard,
    CustomerGuard,
    // Provedor real do WhatsApp entra no bloco 55. Até lá, o de console — que
    // nunca imprime o código.
    { provide: MESSAGING_PROVIDER, useClass: ConsoleMessagingProvider },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
