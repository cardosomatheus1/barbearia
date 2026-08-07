import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { throttlerConfig } from './common/throttler.config.js';
import { BookingController } from './booking/booking.controller.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { TenantService } from './tenant/tenant.service.js';

@Module({
  imports: [ThrottlerModule.forRoot(throttlerConfig())],
  controllers: [BookingController],
  providers: [
    TenantService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
