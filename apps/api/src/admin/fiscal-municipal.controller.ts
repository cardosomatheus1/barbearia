import { Body, Controller, Get, Header, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { NfseError, salvarConfiguracaoMunicipal, situacaoMunicipal,
  type ConfiguracaoMunicipal, type CredenciaisMunicipais, type SituacaoMunicipal } from '@barbearia/finance';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard, Recurso } from './permissao.guard.js';
import { unidadeDoBalcao } from './unidade.js';

const curto = z.string().trim().min(1).max(150);
const endereco = z.object({
  logradouro: curto, numero: curto, bairro: curto, cep: z.string().regex(/^\d{8}$/),
  municipio: z.number().int().min(1000000).max(9999999), nomeMunicipio: curto,
  uf: z.string().regex(/^[A-Z]{2}$/), complemento: z.string().max(150).nullable().optional(),
}).strict();
const configuracao = z.object({
  ambiente: z.enum(['homologacao', 'producao']), serie: z.string().regex(/^[a-zA-Z0-9]{1,5}$/),
  numeroInicial: z.number().int().min(1).max(2000000000), serieExclusiva: z.literal(true),
  itemListaServico: z.string().regex(/^[0-9.]{1,10}$/), codigoMunicipal: z.string().regex(/^[a-zA-Z0-9.]{1,20}$/),
  codigoCancelamento: z.string().regex(/^[a-zA-Z0-9]{1,10}$/),
  cnae: z.string().regex(/^\d{7}$/).nullable(), nbs: z.string().regex(/^\d{9}$/).nullable(),
  razaoSocial: curto, enderecoPrestador: endereco,
  layoutSaoPaulo: z.literal(1), habilitada: z.boolean(),
}).strict();
const schema = z.object({ config: configuracao, credenciais: z.object({
  usuario: z.string().max(2000).nullable().optional(), senha: z.string().max(2000).nullable().optional(),
  token: z.string().max(2000).nullable().optional(),
}).strict().optional() }).strict();

@Controller('v1/admin/fiscal/municipal')
@Recurso('fiscal')
@UseGuards(StaffGuard, PermissaoGuard)
export class FiscalMunicipalController {
  private async ator(staff: AuthenticatedStaff) {
    return { tenantId: staff.tenantId, locationId: (await unidadeDoBalcao(staff)).id,
      staffId: staff.staffUserId, staffName: staff.name };
  }
  @Exige('fiscal.settings')
  @Get()
  @Header('Cache-Control', 'no-store')
  async situacao(@Staff() staff: AuthenticatedStaff): Promise<SituacaoMunicipal> {
    const p = await this.ator(staff);
    return situacaoMunicipal(p.tenantId, p.locationId);
  }
  @Exige('fiscal.settings')
  @Put('configuracao')
  async configurar(@Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(schema)) body: { config: ConfiguracaoMunicipal; credenciais?: CredenciaisMunicipais }) {
    try { await salvarConfiguracaoMunicipal({ ...await this.ator(staff), ...body }); return { ok: true }; }
    catch (erro) {
      if (erro instanceof NfseError) throw new DomainError(erro.code, erro.status, erro.message);
      throw erro;
    }
  }
}
