import { Body, Controller, Delete, Get, Header, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TIPOS_DE_NOTIFICACAO } from '@barbearia/core';
import { BaileysError, canalDaUnidade, cadastroDoWhatsApp, selecionarCanal, solicitarConexaoBaileys,
  desconectarBaileys, situacaoBaileys, salvarTextoBaileys } from '@barbearia/crm';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { unidadeDoBalcao } from './unidade.js';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';

const canalSchema = z.object({ canal: z.enum(['meta', 'baileys']) }).strict();
const textoSchema = z.object({ titulo: z.string().trim().min(1).max(80), tipo: z.enum(TIPOS_DE_NOTIFICACAO),
  corpo: z.string().trim().min(5).max(3500), habilitado: z.boolean() }).strict();
const uuid = z.string().uuid();
async function dominio<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (e instanceof BaileysError) throw new DomainError(e.code, e.status, e.message); throw e; }
}

@Controller('v1/admin/whatsapp/conexao')
@UseGuards(StaffGuard, PermissaoGuard)
export class WhatsAppConexaoController {
  private async ator(staff: AuthenticatedStaff) {
    const local = await unidadeDoBalcao(staff);
    return { tenantId: staff.tenantId, locationId: local.id, staffId: staff.staffUserId, staffName: staff.name };
  }
  @Exige('whatsapp.manage')
  @Get()
  @Header('Cache-Control', 'no-store')
  async situacao(@Staff() staff: AuthenticatedStaff): Promise<{
    canal: 'meta' | 'baileys'; meta: Awaited<ReturnType<typeof cadastroDoWhatsApp>>;
    baileys: Awaited<ReturnType<typeof situacaoBaileys>>;
  }> {
    return dominio(async () => {
      const p = await this.ator(staff);
      const [canal, meta, baileys] = await Promise.all([canalDaUnidade(p), cadastroDoWhatsApp(p.tenantId, p.locationId), situacaoBaileys(p)]);
      return { canal, meta, baileys };
    });
  }
  @Exige('whatsapp.manage')
  @Put()
  async selecionar(@Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(canalSchema)) body: z.infer<typeof canalSchema>) {
    return dominio(async () => { await selecionarCanal({ ...await this.ator(staff), canal: body.canal }); return { ok: true }; });
  }
  @Exige('whatsapp.manage')
  @Post('baileys/parear')
  async parear(@Staff() staff: AuthenticatedStaff) {
    return dominio(async () => { await solicitarConexaoBaileys({ ...await this.ator(staff), novoQr: true }); return { ok: true }; });
  }
  @Exige('whatsapp.manage')
  @Post('baileys/reconectar')
  async reconectar(@Staff() staff: AuthenticatedStaff) {
    return dominio(async () => { await solicitarConexaoBaileys({ ...await this.ator(staff), novoQr: false }); return { ok: true }; });
  }
  @Exige('whatsapp.manage')
  @Delete('baileys')
  async desconectar(@Staff() staff: AuthenticatedStaff) {
    return dominio(async () => { await desconectarBaileys(await this.ator(staff)); return { ok: true }; });
  }
  @Exige('whatsapp.manage')
  @Post('baileys/textos')
  async criarTexto(@Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(textoSchema)) texto: z.infer<typeof textoSchema>) {
    return dominio(async () => salvarTextoBaileys({ ...await this.ator(staff), texto }));
  }
  @Exige('whatsapp.manage')
  @Put('baileys/textos/:id')
  async editarTexto(@Staff() staff: AuthenticatedStaff, @Param('id', new ZodValidationPipe(uuid)) id: string,
    @Body(new ZodValidationPipe(textoSchema)) texto: z.infer<typeof textoSchema>) {
    return dominio(async () => salvarTextoBaileys({ ...await this.ator(staff), texto: { ...texto, id } }));
  }
}
