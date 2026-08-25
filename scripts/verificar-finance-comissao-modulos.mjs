import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raiz = join(import.meta.dirname, '..');
const ler = (p) => readFileSync(join(raiz, p), 'utf8');
const linhas = (s) => s.split('\n').length;
const exigir = (ok, msg) => { if (!ok) throw new Error(msg); };

const fachada = ler('packages/finance/src/comissao.ts');
const contratos = ler('packages/finance/src/comissao-contratos.ts');
const configuracao = ler('packages/finance/src/comissao-configuracao.ts');
const lancamentos = ler('packages/finance/src/comissao-lancamentos.ts');
const periodos = ler('packages/finance/src/comissao-periodos.ts');
const assinatura = ler('packages/finance/src/comissao-assinatura.ts');

// O hotspot original tinha 1.390 linhas e misturava lançamento, fechamento,
// regras, taxas e rentabilidade do clube. Tetos frouxos evitam microarquivos e
// só impedem que responsabilidades já extraídas voltem ao monólito.
exigir(linhas(fachada) <= 80, `comissao.ts deixou de ser fachada: ${linhas(fachada)} linhas`);
exigir(linhas(contratos) <= 90, `comissao-contratos.ts cresceu demais: ${linhas(contratos)} linhas`);
exigir(linhas(configuracao) <= 430, `comissao-configuracao.ts cresceu demais: ${linhas(configuracao)} linhas`);
exigir(linhas(lancamentos) <= 360, `comissao-lancamentos.ts cresceu demais: ${linhas(lancamentos)} linhas`);
exigir(linhas(periodos) <= 470, `comissao-periodos.ts cresceu demais: ${linhas(periodos)} linhas`);
exigir(linhas(assinatura) <= 340, `comissao-assinatura.ts cresceu demais: ${linhas(assinatura)} linhas`);

for (const [nome, fonte] of [
  ['comissao-contratos.ts', contratos],
  ['comissao-configuracao.ts', configuracao],
  ['comissao-lancamentos.ts', lancamentos],
  ['comissao-periodos.ts', periodos],
  ['comissao-assinatura.ts', assinatura],
]) {
  exigir(!fonte.includes("from './comissao.js'"), `${nome} criou dependência circular com a fachada`);
}

// O grafo interno deve permanecer acíclico: fechamento pode depender do modelo
// da assinatura, mas a assinatura não pode voltar a depender do fechamento.
const modulos = new Map([
  ['comissao-contratos', contratos],
  ['comissao-configuracao', configuracao],
  ['comissao-lancamentos', lancamentos],
  ['comissao-periodos', periodos],
  ['comissao-assinatura', assinatura],
]);
const grafo = new Map();
for (const [nome, fonte] of modulos) {
  const deps = [...fonte.matchAll(/from '\.\/(comissao-[a-z-]+)\.js'/g)]
    .map((m) => m[1])
    .filter((dep) => modulos.has(dep));
  grafo.set(nome, deps);
}
const visitando = new Set();
const visitados = new Set();
const visitar = (nome) => {
  if (visitando.has(nome)) throw new Error(`ciclo entre módulos de comissão envolvendo ${nome}`);
  if (visitados.has(nome)) return;
  visitando.add(nome);
  for (const dep of grafo.get(nome) ?? []) visitar(dep);
  visitando.delete(nome);
  visitados.add(nome);
};
for (const nome of grafo.keys()) visitar(nome);

// Fronteiras de responsabilidade: se uma dessas funções voltar para a fachada,
// a divisão vira só decoração e o hotspot reaparece.
for (const [nome, fonte] of [
  ['lancarComissaoDaComanda', lancamentos],
  ['estornarComissaoDaComanda', lancamentos],
  ['fecharPeriodoDeComissao', periodos],
  ['descontarValesNoFechamento', periodos],
  ['salvarRegraDeComissao', configuracao],
  ['salvarAliquotaDoAdquirente', configuracao],
  ['rentabilidadeDoClube', assinatura],
  ['salvarModeloDaAssinatura', assinatura],
]) {
  exigir(new RegExp(`export\\s+async\\s+function\\s+${nome}\\s*\\(`).test(fonte), `${nome} saiu do módulo responsável`);
  exigir(!new RegExp(`export\\s+async\\s+function\\s+${nome}\\s*\\(`).test(fachada), `${nome} voltou para a fachada`);
}

// Invariantes de dinheiro mais fáceis de perder numa refatoração.
exigir(lancamentos.includes('AND sign = 1'), 'estorno deixou de partir apenas de lançamentos positivos');
exigir(lancamentos.includes('subscription_fee_cents'), 'estorno deixou de preservar contexto da assinatura');
exigir(lancamentos.includes('ON CONFLICT DO NOTHING'), 'lançamento perdeu idempotência no banco');
exigir(periodos.includes("status = 'aberto'"), 'fechamento deixou de consumir apenas vales abertos');
exigir(periodos.includes('professional_id = ANY(${params.professionalIds}::uuid[])'), 'vale perdeu recorte dos profissionais realmente pagos');
exigir(periodos.includes('FOR UPDATE'), 'vale perdeu trava pessimista durante o fechamento');
exigir(periodos.includes('WHERE id = ANY(${ids}::uuid[])'), 'fechamento deixou de carimbar exatamente os lançamentos calculados');
exigir(periodos.includes("action: 'commission.closed'"), 'fechamento deixou de ser auditado');

// Regras/taxas continuam recusando ids de outro tenant e valores perigosos.
exigir(configuracao.includes("tabela: 'professionals' | 'services' | 'service_categories'"), 'regra perdeu validação de FK sob RLS');
exigir(configuracao.includes('params.bps > 3000'), 'taxa do adquirente perdeu teto defensivo de 30%');
exigir(configuracao.includes("if (params.forma === 'fiado')"), 'fiado voltou a aceitar taxa de adquirente');
exigir(assinatura.includes('params.tetoBps > 10_000'), 'modelo da assinatura perdeu teto de 100%');
exigir(assinatura.includes("action: 'commission.rule_changed'"), 'mudança do modelo da assinatura deixou de ser auditada');

console.log(
  `finance/comissao modular: fachada ${linhas(fachada)}; lancamentos ${linhas(lancamentos)}; periodos ${linhas(periodos)}; configuracao ${linhas(configuracao)}; assinatura ${linhas(assinatura)}; contratos ${linhas(contratos)} linhas`,
);
