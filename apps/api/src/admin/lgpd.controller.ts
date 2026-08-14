import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  abrirPedidoDoTitular,
  atenderExclusao,
  aVencerPorRetencao,
  consentimentosDoCliente,
  encerrarPedidoDoTitular,
  exportarDadosDoTitular,
  LgpdError,
  pedidosDoTitular,
  registrarConsentimento,
} from '@barbearia/crm';
import { audit, type AuthenticatedStaff } from '@barbearia/identity';
import { AVISO_DE_RETENCAO_DIAS } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import {
  anonimizacaoSchema,
  consentimentoSchema,
  encerramentoSchema,
  pedidoSchema,
} from './lgpd.schemas.js';

/**
 * Os direitos do titular, do lado de quem responde por eles (bloco 31).
 *
 * A barbearia é **controladora** e a plataforma é **operadora** (SPEC §1.8,
 * regra 5). Quem coletou o dado foi ela, e é a ela que o titular pede — por
 * isso estas rotas são do painel da barbearia e não do painel da plataforma,
 * que não tem competência para responder por dado que não é dele.
 *
 * ## As permissões, e por que não é tudo `customers.edit`
 *
 * - **Registrar consentimento** é `customers.edit`: é cadastro, e quem atende
 *   no balcão precisa poder marcar "ela aceitou receber promoção".
 * - **Exportar** é `customers.export`, que a SPEC §1.2 já manda auditar e que
 *   nenhum papel além do dono tem por padrão. Exportar a ficha de uma pessoa é
 *   o mesmo vetor da exportação da base inteira, em escala menor.
 * - **Encerrar pedido** é `settings.manage`: é a barbearia declarando que
 *   cumpriu uma obrigação legal, e isso é ato de quem responde pela empresa.
 */

const STATUS: Record<string, number> = {
  customer_not_found: 404,
  invalid_purpose: 400,
  version_required: 400,
  // 409 e não 400: o pedido é válido, o caminho é que é outro. A tela precisa
  // distinguir "você errou o corpo" de "isto se faz na outra porta".
  exclusao_tem_caminho_proprio: 409,
};

function toHttp(erro: unknown): never {
  if (erro instanceof LgpdError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

/**
 * O IP de quem decidiu, para o registro do consentimento.
 *
 * `req.ip` já vem do Express com `trust proxy` ligado no `main.ts`, então ele é
 * o do cliente e não o do balanceador. Nulo quando não dá para saber: IP
 * inventado num registro de consentimento é pior que IP ausente, porque parece
 * prova.
 */
const ipDe = (requisicao: Request): string | null => requisicao.ip ?? null;

@Controller('v1/admin/customers')
@UseGuards(StaffGuard, PermissaoGuard)
export class LgpdController {
  @Exige('customers.view')
  @Get(':id/consentimentos')
  async ler(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      const { atuais, historico } = await consentimentosDoCliente(staff.tenantId, id);
      return {
        atuais: Object.fromEntries(
          Object.entries(atuais).map(([finalidade, d]) => [
            finalidade,
            {
              concedido: d.concedido,
              versaoDoTexto: d.versaoDoTexto,
              decididoEm: d.decididoEm.toISOString(),
            },
          ]),
        ),
        historico: historico.map((d) => ({
          finalidade: d.finalidade,
          concedido: d.concedido,
          versaoDoTexto: d.versaoDoTexto,
          decididoEm: d.decididoEm.toISOString(),
          // O IP fica de fora da resposta: ele é prova para quem audita o banco,
          // não informação de tela, e circular menos é melhor.
          registradoPeloBalcao: d.registradoPor !== null,
        })),
      };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('customers.edit')
  @Put(':id/consentimentos')
  async registrar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(consentimentoSchema))
    corpo: { finalidade: 'service' | 'marketing' | 'photos' | 'photos_public'; concedido: boolean; versaoDoTexto: string },
    @Req() requisicao: Request,
  ) {
    try {
      const decisao = await registrarConsentimento({
        tenantId: staff.tenantId,
        customerId: id,
        finalidade: corpo.finalidade,
        concedido: corpo.concedido,
        versaoDoTexto: corpo.versaoDoTexto,
        ip: ipDe(requisicao),
        registradoPor: { id: staff.staffUserId, name: staff.name },
      });
      return {
        finalidade: decisao.finalidade,
        concedido: decisao.concedido,
        decididoEm: decisao.decididoEm.toISOString(),
      };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * A exportação, auditada **sempre** (SPEC §1.2).
   *
   * A trilha é gravada numa transação própria depois da leitura, e não dentro
   * dela: a exportação é uma leitura longa de nove tabelas, e manter a
   * transação aberta para escrever uma linha no fim aumentaria a janela sem
   * ganhar nada — o que importa é que o registro exista, não que ele seja
   * atômico com um `SELECT` que não muda estado.
   *
   * ## Três permissões, e não uma
   *
   * A `/security-review` deste bloco apontou o defeito: a exportação **contém**
   * o que outras rotas guardam separadamente, e declarar só `customers.export`
   * fazia dela o caminho mais curto para tudo.
   *
   * - `finance.view` porque o arquivo traz `balance_cents`, o limite de fiado,
   *   os totais das comandas e o razão inteiro. Em qualquer outra rota esses
   *   centavos exigem a permissão de dinheiro — e, por derivação, o **segundo
   *   fator**. Sem isto, quem roubasse o cookie do balcão sem conseguir o
   *   código do autenticador estaria barrado em `/v1/admin/debts` e leria o
   *   mesmo livro de dívidas um cliente por vez.
   * - `customers.view_notes` porque o arquivo traz `customer_preferences.
   *   observacoes` e a nota da fila. A recepção **não** tem essa permissão por
   *   padrão, de propósito ("precisa achar o cliente, não ler o que anotaram
   *   sobre ele"), e desde o bloco 30 o dono edita os conjuntos pela tela: dar
   *   `customers.export` para a recepção responder pedido de LGPD entregaria
   *   junto a anotação de todo mundo.
   *
   * - `feedback.view` porque o arquivo passou a trazer o **corpo dos recados**
   *   (bloco 40). O profissional não recebe essa permissão por padrão, e o
   *   motivo está escrito em `permissoes.ts`: reclamação costuma ser sobre uma
   *   pessoa. Sem esta linha, o dono que tirasse `feedback.view` de um papel e
   *   deixasse `customers.export` veria a decisão dele deixar de valer, um
   *   cliente por vez. Achado da revisão de segurança do bloco 40, e é o mesmo
   *   defeito que a revisão do bloco 31 encontrou nesta mesma rota.
   *
   * O saldo de fidelidade (bloco 41) não acrescenta permissão: ele é dinheiro,
   * e `finance.view` já está declarada acima pelo mesmo motivo.
   *
   * O caminho oposto — tirar dinheiro e anotação do arquivo — foi descartado:
   * o saldo de fiado de uma pessoa **é** dado pessoal dela, e exportação
   * incompleta é o defeito que a LGPD pune, não o que ela evita.
   */
  /**
   * Bloco 74: o arquivo passou a trazer as **fotos** do titular, e por isso a
   * lista de permissões cresceu.
   *
   * `customers.view_photos` é permissão separada, tem rota própria e leitura
   * auditada por exigência da SPEC §4.2 — sem ela declarada aqui, a exportação
   * entregava a mesma foto por fora. A configuração natural "o gerente responde
   * os pedidos de LGPD" concede `customers.export` a um papel que a barbearia
   * deliberadamente deixou sem `view_photos`, e ele passaria a colher a foto de
   * rosto de toda a base, um cliente por vez.
   *
   * É a **oitava** vez que a regra da rota que agrega é quebrada neste
   * repositório, e a quarta nesta mesma rota.
   */
  @Exige('customers.export', 'finance.view', 'customers.view_notes', 'feedback.view', 'customers.view_photos')
  @Get(':id/dados')
  async exportar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      const dados = await exportarDadosDoTitular(staff.tenantId, id);

      await withTenant(staff.tenantId, (tx) =>
        audit(tx, {
          actorId: staff.staffUserId,
          actorName: staff.name,
          action: 'customer.data_exported',
          entity: 'customers',
          entityId: id,
        }),
      );

      return dados;
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * Quem sai por retenção, e quando (bloco 32).
   *
   * É o **aviso prévio ao tenant** que a SPEC §1.8 regra 6 exige. A tela é o
   * canal: uma mensagem que ninguém lê cumpriria a letra e não a intenção, e a
   * lista aberta aqui é onde o dono decide se corre atrás de alguém.
   *
   * `settings.manage` e não `customers.view`: é informação sobre a base
   * encolhendo, e a decisão que ela pede — trazer o cliente de volta ou deixar
   * sair — é de quem responde pela empresa.
   */
  @Exige('settings.manage')
  @Get('lgpd/retencao')
  async retencao(@Staff() staff: AuthenticatedStaff) {
    const lista = await aVencerPorRetencao(staff.tenantId);
    return {
      prazoDeAvisoDias: AVISO_DE_RETENCAO_DIAS,
      cadastros: lista.map((c) => ({
        customerId: c.customerId,
        nome: c.nome,
        ultimaInteracao: c.ultimaInteracao.toISOString(),
        saiEm: new Date(
          (c.avisadoEm ?? c.ultimaInteracao).getTime() + AVISO_DE_RETENCAO_DIAS * 86_400_000,
        ).toISOString(),
      })),
    };
  }

  @Exige('settings.manage')
  @Get('lgpd/pedidos')
  async pedidos(@Staff() staff: AuthenticatedStaff) {
    const lista = await pedidosDoTitular(staff.tenantId, true);
    return {
      pedidos: lista.map((p) => ({
        id: p.id,
        tipo: p.tipo,
        estado: p.estado,
        customerId: p.customerId,
        pedidoEm: p.pedidoEm.toISOString(),
        venceEm: p.venceEm.toISOString(),
        encerradoEm: p.encerradoEm?.toISOString() ?? null,
        nota: p.nota,
      })),
    };
  }

  @Exige('customers.edit')
  @Post(':id/lgpd/pedidos')
  async abrir(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(pedidoSchema)) corpo: { tipo: 'export' | 'deletion' },
  ) {
    try {
      const pedido = await abrirPedidoDoTitular({
        tenantId: staff.tenantId,
        customerId: id,
        tipo: corpo.tipo,
      });
      return { id: pedido.id, venceEm: pedido.venceEm.toISOString() };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('settings.manage')
  @Put('lgpd/pedidos/:pedidoId')
  async encerrar(
    @Staff() staff: AuthenticatedStaff,
    @Param('pedidoId', new ZodValidationPipe(uuidSchema)) pedidoId: string,
    @Body(new ZodValidationPipe(encerramentoSchema))
    corpo: { atendido: boolean; nota?: string },
  ) {
    try {
      await encerrarPedidoDoTitular({
        tenantId: staff.tenantId,
        pedidoId,
        atendido: corpo.atendido,
        nota: corpo.nota ?? null,
        ator: { id: staff.staffUserId, name: staff.name },
      });
      return { ok: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * A exclusão de verdade (bloco 32).
   *
   * ## Rota própria, e permissão própria
   *
   * Ela não fica em `PUT lgpd/pedidos/:id` porque não é a mesma coisa: encerrar
   * um pedido é marcar uma linha e é `settings.manage`; **apagar a pessoa** é a
   * única operação irreversível do produto. Amarrar as duas na mesma permissão
   * faria quem responde e-mail de cliente poder destruir a base.
   *
   * `customers.anonymize` nasce só para o dono — como `customers.export`, e
   * pelo motivo espelhado: uma é o vetor de roubo da base, a outra é o de
   * destruição dela. O dono delega pela tela de permissões se quiser.
   *
   * ## Funciona sem pedido aberto, de propósito
   *
   * Quem pede exclusão na frente do barbeiro não deveria precisar que alguém
   * abra um chamado primeiro. Havendo pedido aberto, ele é encerrado na mesma
   * transação; não havendo, a trilha da anonimização é o registro.
   */
  @Exige('customers.anonymize')
  @Post(':id/anonimizar')
  async anonimizar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(anonimizacaoSchema)) corpo: { motivo: string },
  ) {
    try {
      const resultado = await atenderExclusao({
        tenantId: staff.tenantId,
        customerId: id,
        motivo: corpo.motivo,
        ator: { id: staff.staffUserId, name: staff.name },
      });

      // `anonimizou: false` é o cadastro que já estava anonimizado — não é erro,
      // e devolver 404 faria a tela dizer "não existe" sobre uma linha que está
      // ali, no estado certo.
      if (!resultado.anonimizou) {
        return { anonimizou: false, pedidosFechados: 0 };
      }
      return resultado;
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
