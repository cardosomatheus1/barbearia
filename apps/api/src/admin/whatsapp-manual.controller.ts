import { pode } from '@barbearia/core';
import { createHash } from 'node:crypto';
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { WhatsAppManualError, filaWhatsAppManual, abrirWhatsAppManual, concluirWhatsAppManual,
  textosWhatsAppManual, salvarTextoWhatsAppManual, criarCampanha, salvarAutomacao,
  marcarParaEnvio, prepararFilaManual, CampanhaError, AutomacaoError, configuracoesWhatsAppManual, ativarAutomacaoManual } from '@barbearia/crm';
import { withTenant } from '@barbearia/db';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { unidadeDoBalcao } from './unidade.js';
import { campanhaSchema } from './campanha.schemas.js';
import { automacaoSchema } from './automacao.schemas.js';
const idSchema = z.string().uuid();
const textoSchema = z.object({ id: idSchema.optional(), titulo: z.string().trim().min(1).max(80), corpo: z.string().trim().min(5).max(3500), habilitado: z.boolean() }).strict();
const acaoSchema = z.object({ acao: z.enum(['enviado','liberar','descartar','optout','assumir']) }).strict();
const criarCampanhaSchema = campanhaSchema.extend({ templateId: idSchema, requestId: idSchema }).strict();
const criarAutomacaoSchema = automacaoSchema.omit({ id: true }).extend({ templateId: idSchema, requestId: idSchema }).strict();
function erroHttp(e: unknown): never {
  if (e instanceof WhatsAppManualError) throw new DomainError(e.code, e.status, e.message);
  if (e instanceof CampanhaError || e instanceof AutomacaoError) throw new DomainError(e.code, 400, e.message);
  throw e;
}
@Controller('v1/admin/whatsapp/manual')
@UseGuards(StaffGuard, PermissaoGuard)
export class WhatsAppManualController {
  private async contexto(staff: AuthenticatedStaff) {
    const local = await unidadeDoBalcao(staff);
    return { tenantId: staff.tenantId, locationId: local.id, staffId: staff.staffUserId, staffName: staff.name, podeAssumir: pode(staff.permissions, 'whatsapp.manage') };
  }
  private async textoManual(p: { tenantId: string; locationId: string }, id: string) {
    const texto = await withTenant(p.tenantId, async tx => (await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM whatsapp_templates WHERE id = ${id}::uuid AND location_id = ${p.locationId}::uuid
        AND transport = 'manual' AND local_enabled`)[0]);
    if (!texto) throw new DomainError('manual_texto_ausente', 400, 'Escolha uma mensagem manual disponível nesta unidade.');
  }
  @Exige('marketing.send', 'customers.view')
  @Get()
  async fila(@Staff() staff: AuthenticatedStaff, @Query(new ZodValidationPipe(z.object({ antes: idSchema.optional(), visao: z.enum(['pendentes','historico']).optional() }))) query: { antes?: string; visao?: 'pendentes' | 'historico' }) {
    return filaWhatsAppManual({ ...await this.contexto(staff), ...query });
  }
  @Exige('marketing.send')
  @Get('textos')
  async textos(@Staff() staff: AuthenticatedStaff) { return { textos: await textosWhatsAppManual(await this.contexto(staff)) }; }
  @Exige('marketing.send')
  @Get('configuracoes')
  async configuracoes(@Staff() staff: AuthenticatedStaff) { return configuracoesWhatsAppManual(await this.contexto(staff)); }
  @Exige('marketing.send')
  @Post('automacoes/:id/estado')
  async estadoAutomacao(@Staff() staff: AuthenticatedStaff, @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(z.object({ ativa: z.boolean() }).strict())) body: { ativa: boolean }) {
    try { return await ativarAutomacaoManual({ ...await this.contexto(staff), id, ativa: body.ativa }); } catch (e) { return erroHttp(e); }
  }
  @Exige('marketing.send')
  @Post('textos')
  async salvarTexto(@Staff() staff: AuthenticatedStaff, @Body(new ZodValidationPipe(textoSchema)) body: z.infer<typeof textoSchema>) {
    try { return await salvarTextoWhatsAppManual({ ...await this.contexto(staff), titulo: body.titulo, corpo: body.corpo, habilitado: body.habilitado, ...(body.id ? { id: body.id } : {}) }); } catch (e) { return erroHttp(e); }
  }
  @Exige('marketing.send')
  @Post('campanhas')
  async campanha(@Staff() staff: AuthenticatedStaff, @Body(new ZodValidationPipe(criarCampanhaSchema)) body: z.infer<typeof criarCampanhaSchema>) {
    try {
      const p = await this.contexto(staff); await this.textoManual(p, body.templateId);
      const c = await criarCampanha({ ...p, nome: body.nome, filtro: body.filtro, valorDoFiltro: body.valorDoFiltro, diaDaSemana: body.diaDaSemana, templateId: body.templateId, janelaDias: body.janelaDias, agora: new Date(), criacaoManual: { chave: body.requestId, hash: createHash('sha256').update(JSON.stringify({ ...body, locationId: p.locationId })).digest('hex') } });
      await marcarParaEnvio({ ...p, campanhaId: c.id });
      // Prepara imediatamente, sem transporte externo. O job repete de forma idempotente.
      await prepararFilaManual(p.tenantId, new Date(), c.id);
      return c;
    } catch (e) { return erroHttp(e); }
  }
  @Exige('marketing.send')
  @Post('automacoes')
  async automacao(@Staff() staff: AuthenticatedStaff, @Body(new ZodValidationPipe(criarAutomacaoSchema)) body: z.infer<typeof criarAutomacaoSchema>) {
    try { const p = await this.contexto(staff); await this.textoManual(p, body.templateId);
      return await salvarAutomacao({ ...p, ...body, publico: body.publico ?? null, criacaoManual: { chave: body.requestId, hash: createHash('sha256').update(JSON.stringify({ ...body, locationId: p.locationId })).digest('hex') } }); } catch (e) { return erroHttp(e); }
  }
  @Exige('marketing.send', 'customers.view')
  @Post(':id/abrir')
  async abrir(@Staff() staff: AuthenticatedStaff, @Param('id', new ZodValidationPipe(idSchema)) id: string) {
    try { return await abrirWhatsAppManual({ ...await this.contexto(staff), id, agora: new Date() }); } catch (e) { return erroHttp(e); }
  }
  @Exige('marketing.send', 'customers.view')
  @Post(':id/concluir')
  async concluir(@Staff() staff: AuthenticatedStaff, @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(acaoSchema)) body: z.infer<typeof acaoSchema>) {
    try { return await concluirWhatsAppManual({ ...await this.contexto(staff), id, agora: new Date(), acao: body.acao }); } catch (e) { return erroHttp(e); }
  }
}
