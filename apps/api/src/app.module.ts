import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { throttlerConfig } from './common/throttler.config.js';
import { BookingController } from './booking/booking.controller.js';
import {
  AppointmentsController,
  CreateAppointmentController,
} from './booking/appointments.controller.js';
import { AuthController } from './auth/auth.controller.js';
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
    CreateAppointmentController,
    AppointmentsController,
  ],
  providers: [
    TenantService,
    CustomerGuard,
    // Provedor real do WhatsApp entra no bloco 52. Até lá, o de console — que
    // nunca imprime o código.
    { provide: MESSAGING_PROVIDER, useClass: ConsoleMessagingProvider },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
