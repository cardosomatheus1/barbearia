import { Body, Controller, Delete, Get, Header, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { withTenant } from '@barbearia/db';
import { audit, type AuthenticatedStaff } from '@barbearia/identity';
import { NfseError, situacaoNfse, salvarConfiguracaoNfse, salvarCertificadoNfse, removerCertificadoNfse,
  baixarXmlNfse, baixarPdfNfse, modoFiscal, type ConfiguracaoNfse } from '@barbearia/finance';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard, Recurso } from './permissao.guard.js';
import { unidadeDoBalcao } from './unidade.js';
import { uuidSchema } from './caixa.schemas.js';

const configSchema = z.object({
  ambiente: z.enum(['homologacao', 'producao']), serie: z.number().int().min(1).max(49999),
  codigoNacional: z.string().regex(/^\d{6}$/), codigoMunicipal: z.string().regex(/^\d{3}$/).nullable(),
  nbs: z.string().regex(/^\d{9}$/).nullable(), aliquotaTotalSimplesBps: z.number().int().min(0).max(9999).nullable(),
  habilitada: z.boolean(),
}).strict();
const certificadoSchema = z.object({
  arquivo: z.string().min(4).max(699052).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  senha: z.string().max(1024),
}).strict();

function toHttp(erro: unknown): never {
  if (erro instanceof NfseError) throw new DomainError(erro.code, erro.status, erro.message);
  throw erro;
}

@Controller('v1/admin/fiscal/nacional')
@Recurso('fiscal')
@UseGuards(StaffGuard, PermissaoGuard)
export class FiscalNacionalController {
  private async ator(staff: AuthenticatedStaff) {
    const unidade = await unidadeDoBalcao(staff);
    return { tenantId: staff.tenantId, locationId: unidade.id, staffId: staff.staffUserId, staffName: staff.name };
  }
  @Exige('fiscal.settings')
  @Get()
  @Header('Cache-Control', 'no-store')
  async situacao(@Staff() staff: AuthenticatedStaff) {
    const p = await this.ator(staff);
    return { modo: modoFiscal(), ...await situacaoNfse(p.tenantId, p.locationId) };
  }
  @Exige('fiscal.settings')
  @Put('configuracao')
  async configurar(@Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(configSchema)) config: ConfiguracaoNfse) {
    try { await salvarConfiguracaoNfse({ ...await this.ator(staff), config }); return { ok: true }; }
    catch (erro) { return toHttp(erro); }
  }
  @Exige('fiscal.settings')
  @Post('certificado')
  async certificado(@Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(certificadoSchema)) body: { arquivo: string; senha: string }) {
    const pfx = Buffer.from(body.arquivo, 'base64');
    try { await salvarCertificadoNfse({ ...await this.ator(staff), pfx, senha: body.senha }); return { ok: true }; }
    catch (erro) { return toHttp(erro); }
    finally { pfx.fill(0); }
  }
  @Exige('fiscal.settings')
  @Delete('certificado')
  async remover(@Staff() staff: AuthenticatedStaff) {
    try { await removerCertificadoNfse(await this.ator(staff)); return { ok: true }; }
    catch (erro) { return toHttp(erro); }
  }
  @Exige('fiscal.view', 'customers.view')
  @Get('notas/:id/xml')
  @Header('Cache-Control', 'no-store')
  async xml(@Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) invoiceId: string) {
    try {
      const p = await this.ator(staff);
      const xml = await baixarXmlNfse({ ...p, invoiceId });
      await withTenant(p.tenantId, tx => audit(tx, { actorId: p.staffId, actorName: p.staffName,
        action: 'fiscal.xml_downloaded', entity: 'fiscal_invoice', entityId: invoiceId }));
      return { xml };
    } catch (erro) { return toHttp(erro); }
  }
  @Exige('fiscal.view', 'customers.view')
  @Get('notas/:id/pdf')
  @Header('Cache-Control', 'no-store')
  async pdf(@Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) invoiceId: string) {
    try {
      const p = await this.ator(staff);
      const pdf = await baixarPdfNfse({ ...p, invoiceId });
      await withTenant(p.tenantId, tx => audit(tx, { actorId: p.staffId, actorName: p.staffName,
        action: 'fiscal.pdf_downloaded', entity: 'fiscal_invoice', entityId: invoiceId }));
      return { arquivo: pdf.toString('base64') };
    } catch (erro) { return toHttp(erro); }
  }
}
