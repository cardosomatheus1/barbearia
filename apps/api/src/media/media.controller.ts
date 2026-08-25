import { Controller, Get, Param, Res, StreamableFile } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import type { Response } from 'express';
import { lerImagemPublica } from './storage.js';

const tenantSchema = z.string().uuid();
const arquivoSchema = z.string().regex(/^[0-9a-f-]{36}\.(?:webp|jpg|png)$/i);

/**
 * Arquivos públicos do próprio Barberdock.
 *
 * O nome é UUID e imutável; por isso o cache pode ser longo. O caminho nunca é
 * aceito como chave arbitrária: `storage.ts` valida tenant e arquivo antes de
 * tocar no fallback local ou no bucket S3, evitando traversal/chave forjada.
 */
@Controller('media')
export class MediaController {
  @Get(':tenantId/:arquivo')
  async imagem(
    @Param('tenantId', new ZodValidationPipe(tenantSchema)) tenantId: string,
    @Param('arquivo', new ZodValidationPipe(arquivoSchema)) arquivo: string,
    @Res({ passthrough: true }) resposta: Response,
  ) {
    const imagem = await lerImagemPublica(tenantId, arquivo);
    if (!imagem) {
      resposta.status(404);
      return { error: { code: 'media_not_found', message: 'Imagem não encontrada' } };
    }
    resposta.setHeader('content-type', imagem.tipo);
    resposta.setHeader('cache-control', 'public, max-age=31536000, immutable');
    resposta.setHeader('x-content-type-options', 'nosniff');
    resposta.setHeader('content-length', String(imagem.bytes.byteLength));
    return new StreamableFile(imagem.bytes);
  }
}
