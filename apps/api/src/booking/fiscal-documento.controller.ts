import { Body, Controller, Header, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { NfseError, pdfPeloLinkNfse } from '@barbearia/finance';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { DomainError } from '../common/errors.js';

const schema = z.object({ token: z.string().min(1).max(1000) }).strict();

/** A autorização é a assinatura com prazo e escopo da nota, conferida antes do banco. */
@Controller('v1/fiscal/documento')
export class FiscalDocumentoController {
  @Post()
  @Header('Cache-Control', 'no-store')
  @Throttle({ short: { limit: 30, ttl: 60_000 } })
  async documento(@Body(new ZodValidationPipe(schema)) body: { token: string }) {
    try { return { arquivo: (await pdfPeloLinkNfse(body.token)).toString('base64') }; }
    catch (erro) {
      if (erro instanceof NfseError) throw new DomainError(erro.code, erro.status, erro.message);
      throw erro;
    }
  }
}
