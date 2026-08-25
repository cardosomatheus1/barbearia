import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ler = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const falhas = [];
const exigir = (cond, msg) => { if (!cond) falhas.push(msg); };

const comanda = ler('packages/finance/src/comanda.ts');
const tipos = ler('packages/finance/src/comanda-tipos.ts');
const fechamento = ler('packages/finance/src/comanda-fechamento.ts');
const caixa = ler('packages/finance/src/caixa.ts');
const estorno = ler('packages/finance/src/estorno.ts');
const pacote = ler('packages/finance/src/pacote.ts');
const corePagamento = ler('packages/core/src/pagamento.ts');
const coreVale = ler('packages/core/src/vale.ts');
const schema = ler('apps/api/src/admin/caixa.schemas.ts');
const controller = ler('apps/api/src/admin/caixa.controller.ts');
const apiWeb = ler('apps/web/src/lib/admin-api/financeiro-operacional.ts');
const acao = ler('apps/web/src/app/admin/acoes/agenda-financeiro.ts');
const tela = ler('apps/web/src/app/admin/comanda/[id]/page.tsx');
const migracao = ler('packages/db/migrations/0111_finance_estorno_concorrencia.sql');
const migracaoPacote = ler('packages/db/migrations/0112_pacote_congelado_na_comanda.sql');

exigir((comanda.match(/exigirAberta\(tx, params\.orderId, params\.locationId, true\)/g) ?? []).length >= 4,
  'mutações de comanda não compartilham a trava da própria venda');
exigir(comanda.includes('close_idempotency_fingerprint') && fechamento.includes('fingerprintDoFechamento')
  && comanda.includes("'idempotencia_conflitante'"),
  'fechamento perdeu fingerprint/conflito de idempotência');
exigir(migracao.includes('close_idempotency_fingerprint text'),
  'migração 0111 não persiste fingerprint do fechamento');
exigir(caixa.includes('pg_advisory_xact_lock') && caixa.includes(':cash-open'),
  'abertura concorrente de caixa não está serializada');

exigir(estorno.includes('refund_pending_at')
  && estorno.includes("refund_pending_at < now() - interval '15 minutes'")
  && estorno.includes("recusar('estorno_em_curso')"),
  'estorno externo perdeu lease persistente/recusa concorrente');
exigir(!estorno.includes('limparEstornoPendente'),
  'falha ambígua do adquirente ainda libera o lease e permite retry imediato');
exigir(corePagamento.includes('Deve ser idempotente para o par `pagamentoId + valorCents`'),
  'contrato PaymentProvider não exige idempotência do estorno');
exigir(estorno.includes('validarPacotesVendidosParaEstorno')
  && estorno.includes("recusar('pacote_vendido_ja_usado')")
  && estorno.includes("recusar('pacote_vendido_ja_transferido')")
  && estorno.includes('package_transfers')
  && estorno.includes('invalidarPacotesVendidos'),
  'venda de pacote não bloqueia uso/transferência nem invalida benefício no estorno integral');
exigir(/SELECT id FROM customer_packages[\s\S]{0,220}FOR UPDATE[\s\S]{0,500}SELECT cp\.id, cp\.refunded_at/.test(estorno),
  'estorno não trava pacote antes de reler usos em snapshot novo');
exigir(/SELECT id FROM customer_packages[\s\S]{0,260}FOR UPDATE[\s\S]{0,900}NOT EXISTS \([\s\S]{0,180}oc\.refund_pending_at IS NOT NULL/.test(pacote),
  'consumo de pacote não relê lease depois da trava');
exigir(pacote.includes('const travado = await tx.$queryRaw<{ id: string }[]>')
  && pacote.includes("if (!travado[0]) recusar('pacote_nao_encontrado')")
  && pacote.includes("recusar('estorno_da_venda_em_curso')"),
  'reembolso de pacote não trava antes de reler o estorno da venda');
exigir(estorno.includes("if (!travado[0]) falharNaTransferencia('pacote_nao_encontrado')")
  && estorno.includes("falharNaTransferencia('estorno_da_venda_em_curso')"),
  'transferência de pacote não relê o lease após travar a linha');

exigir(estorno.includes('validarFiadoParaEstorno') && estorno.includes("recusar('fiado_ja_recebido')"),
  'estorno ainda pode criar crédito artificial depois de receber fiado');
exigir(estorno.includes('validarGavetaParaEstorno')
  && estorno.includes("recusar('caixa_sem_saldo_para_estorno')"),
  'estorno em dinheiro não exige gaveta/saldo suficiente');
exigir(coreVale.includes("| 'estorno_em_curso'") && coreVale.includes("| 'pacote_vendido_ja_usado'")
  && coreVale.includes("| 'pacote_vendido_ja_transferido'"),
  'contrato de falhas de estorno não acompanha as proteções financeiras');

exigir(tipos.includes("'refunded'"), 'tipo Comanda.status não conhece venda estornada');
exigir(schema.includes('pagamentos: z') && !/pagamentos:[\s\S]{0,300}\.min\(1\)/.test(schema),
  'API ainda proíbe concluir comanda de total zero');
exigir(tela.includes('Concluir sem cobrança') && acao.includes('Lista vazia é válida somente para comanda de total zero'),
  'fluxo de cortesia zero não está alinhado entre UI e Server Action');
exigir(schema.includes('servicoDaAssinatura: uuidSchema.optional()') && controller.includes('servicoDaAssinatura')
  && apiWeb.includes('servicoDaAssinatura') && acao.includes('servicoDaAssinatura')
  && tela.includes('Assinatura do cliente'),
  'pagamento por assinatura não atravessa borda → web → domínio');
exigir(comanda.includes('for (let unidade = 0; unidade < item.quantity; unidade += 1)')
  && comanda.includes('agora: agoraNoFechamento'),
  'venda de pacote quantity>1 não entrega a mesma quantidade cobrada');
exigir(comanda.includes('package_snapshot_service_id')
  && comanda.includes('package_snapshot_quantity')
  && comanda.includes('package_snapshot_validity_days')
  && comanda.includes('package_snapshot_transferable')
  && pacote.includes('Os termos não são relidos do catálogo aqui')
  && !/export async function venderPacote[\s\S]{0,900}FROM packages/.test(pacote),
  'fechamento voltou a reler termos mutáveis do catálogo de pacote');
exigir(migracaoPacote.includes('package_snapshot_service_id')
  && migracaoPacote.includes('order_items_pacote_snapshot_coerente')
  && migracaoPacote.includes('ON DELETE RESTRICT'),
  'migração 0112 não congela/protege os termos do pacote na comanda');
exigir(fechamento.includes("'pacote_com_desconto',") && fechamento.includes('Venda de pacote não recebe desconto geral'),
  'desconto geral pode reduzir venda de pacote sem reduzir crédito de reembolso');

if (falhas.length) {
  console.error(`Auditoria Financeiro: ${falhas.length} falha(s)`);
  for (const f of falhas) console.error(`- ${f}`);
  process.exit(1);
}
console.log('Auditoria Financeiro: concorrência, idempotência, caixa, fiado, pacote e estorno preservados');
