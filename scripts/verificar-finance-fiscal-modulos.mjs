import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raiz = join(import.meta.dirname, '..');
const ler = (p) => readFileSync(join(raiz, p), 'utf8');
const linhas = (s) => s.split('\n').length;
const exigir = (ok, msg) => { if (!ok) throw new Error(msg); };

const fachada = ler('packages/finance/src/fiscal.ts');
const emissor = ler('packages/finance/src/fiscal-emissor.ts');
const erros = ler('packages/finance/src/fiscal-erros.ts');
const configuracao = ler('packages/finance/src/fiscal-configuracao.ts');
const notas = ler('packages/finance/src/fiscal-notas.ts');
const emissao = ler('packages/finance/src/fiscal-emissao.ts');
const entrega = ler('packages/finance/src/fiscal-entrega.ts');

// O hotspot original tinha 1.266 linhas e misturava ambiente/provedor,
// configuração, criação, emissão/conciliação/cancelamento e entrega ao cliente.
exigir(linhas(fachada) <= 60, `fiscal.ts deixou de ser fachada: ${linhas(fachada)} linhas`);
exigir(linhas(emissor) <= 70, `fiscal-emissor.ts cresceu demais: ${linhas(emissor)} linhas`);
exigir(linhas(erros) <= 90, `fiscal-erros.ts cresceu demais: ${linhas(erros)} linhas`);
exigir(linhas(configuracao) <= 190, `fiscal-configuracao.ts cresceu demais: ${linhas(configuracao)} linhas`);
exigir(linhas(notas) <= 430, `fiscal-notas.ts cresceu demais: ${linhas(notas)} linhas`);
exigir(linhas(emissao) <= 450, `fiscal-emissao.ts cresceu demais: ${linhas(emissao)} linhas`);
exigir(linhas(entrega) <= 330, `fiscal-entrega.ts cresceu demais: ${linhas(entrega)} linhas`);

for (const [nome, fonte] of [
  ['fiscal-emissor.ts', emissor],
  ['fiscal-erros.ts', erros],
  ['fiscal-configuracao.ts', configuracao],
  ['fiscal-notas.ts', notas],
  ['fiscal-emissao.ts', emissao],
  ['fiscal-entrega.ts', entrega],
]) {
  exigir(!fonte.includes("from './fiscal.js'"), `${nome} criou dependência circular com a fachada`);
}

// O grafo interno deve permanecer acíclico.
const modulos = new Map([
  ['fiscal-emissor', emissor],
  ['fiscal-erros', erros],
  ['fiscal-configuracao', configuracao],
  ['fiscal-notas', notas],
  ['fiscal-emissao', emissao],
  ['fiscal-entrega', entrega],
]);
const grafo = new Map();
for (const [nome, fonte] of modulos) {
  const deps = [...fonte.matchAll(/from '\.\/(fiscal-[a-z-]+)\.js'/g)]
    .map((m) => m[1])
    .filter((dep) => modulos.has(dep));
  grafo.set(nome, deps);
}
const visitando = new Set();
const visitados = new Set();
const visitar = (nome) => {
  if (visitando.has(nome)) throw new Error(`ciclo entre módulos fiscais envolvendo ${nome}`);
  if (visitados.has(nome)) return;
  visitando.add(nome);
  for (const dep of grafo.get(nome) ?? []) visitar(dep);
  visitando.delete(nome);
  visitados.add(nome);
};
for (const nome of grafo.keys()) visitar(nome);

// Fronteiras: o arquivo público só reexporta; a lógica fica no módulo responsável.
for (const [nome, fonte] of [
  ['modoFiscal', emissor],
  ['emissorFiscal', emissor],
  ['configuracaoFiscal', configuracao],
  ['salvarConfiguracaoFiscal', configuracao],
  ['notasDoPeriodo', notas],
  ['pedirNota', notas],
  ['enviarNota', emissao],
  ['conciliarNotas', emissao],
  ['cancelarNota', emissao],
  ['salvarDocumentoDoCliente', entrega],
  ['notasAEntregar', entrega],
  ['entregarNotasAutorizadas', entrega],
]) {
  exigir(new RegExp(`export\\s+(?:async\\s+)?function\\s+${nome}\\s*\\(`).test(fonte), `${nome} saiu do módulo responsável`);
  exigir(!new RegExp(`export\\s+(?:async\\s+)?function\\s+${nome}\\s*\\(`).test(fachada), `${nome} voltou para a fachada`);
}

// Honestidade da integração: só existem nenhum/fake, padrão é desligado e
// qualquer nome de emissor não implementado falha alto.
exigir(emissor.includes("export type ModoFiscal = 'nenhum' | 'fake'"), 'catálogo fiscal passou a prometer emissor não implementado');
exigir(emissor.includes("if (bruto === undefined || bruto === '') return 'nenhum'"), 'fiscal deixou de iniciar desligado por padrão');
exigir(emissor.includes("if (bruto === 'nenhum' || bruto === 'fake') return modoSeguroParaOAmbiente(bruto)"), 'modo fiscal deixou de aceitar apenas os modos implementados');
exigir(emissor.includes('FISCAL_MODO inválido'), 'modo fiscal desconhecido deixou de falhar alto');
exigir(emissor.includes("modo === 'fake' && process.env['NODE_ENV'] === 'production'"), 'fake fiscal voltou a ser permitido em produção');
exigir(emissor.includes("return modoSeguroParaOAmbiente(modo) === 'fake' ? new FakeFiscalProvider() : null"), 'emissor fake/de desligado mudou de semântica ou criou atalho da trava de produção');
for (const fonte of [configuracao, notas, emissao, entrega, erros]) {
  exigir(!fonte.includes('FakeFiscalProvider'), 'provider fake vazou para fora da fronteira do emissor');
  exigir(!fonte.includes("process.env['FISCAL_MODO']"), 'leitura do ambiente fiscal vazou para fora do módulo emissor');
}

// Configuração: validação central, FK recortada sob RLS e auditoria obrigatória.
exigir(configuracao.includes('validarConfiguracaoFiscal(config)'), 'configuração deixou de usar validação central');
exigir(configuracao.includes('WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)'), 'configuração perdeu prova da unidade sob RLS');
exigir(configuracao.includes("action: 'fiscal.settings_changed'"), 'mudança de configuração fiscal deixou de ser auditada');

// Criação: emissão automática nunca bloqueia a venda se o emissor não existe;
// manual falha explicitamente. A tarefa nasce na mesma transação e idempotente.
exigir(notas.includes("if (modoFiscal() === 'nenhum')") && notas.includes('if (params.automatica) return null;') && notas.includes("recusar('fiscal_indisponivel')"), 'ausência de emissor deixou de distinguir automática de manual');
exigir(notas.includes('ESTADOS_QUE_OCUPAM_A_VENDA'), 'nota perdeu catálogo central de estados que ocupam a venda');
exigir(notas.includes("kind: 'fiscal.emitir'") && notas.includes('idempotencyKey: `fiscal:${criada.id}`'), 'criação perdeu fila/idempotência de emissão');
exigir(notas.includes('commission_entries') && notas.includes('AND sign = 1'), 'nota deixou de congelar apenas comissão positiva da venda');

// Emissão/cancelamento: concorrência e estados ambíguos continuam defensivos.
exigir(emissao.includes('status::text = ANY(${[...ESTADOS_NAO_TERMINAIS]}::text[])') && emissao.includes('FOR UPDATE'), 'emissão perdeu seleção/trava dos estados não terminais');
exigir(emissao.includes("nota.status === 'processando' && nota.provider_invoice_id") && emissao.includes("if (nota.status === 'pendente')"), 'processando com/sem id externo perdeu tratamento distinto');
exigir(emissao.includes('ESTADOS_EM_VOO'), 'conciliação deixou de usar catálogo central de estados em voo');
exigir(emissao.includes("UPDATE fiscal_invoices SET status = 'cancelando'") && emissao.includes("action: 'fiscal.invoice_cancelled'"), 'cancelamento perdeu estado em voo ou auditoria');
exigir(emissao.includes('**Não** voltamos para `autorizada` aqui') && !emissao.includes("UPDATE fiscal_invoices SET status = 'autorizada'"), 'erro ambíguo voltou a reabrir nota cancelando');

// Entrega: documento não vaza para auditoria e notificação é no máximo uma vez.
exigir(entrega.includes('documentoDoTomadorValido(documento)'), 'documento fiscal do cliente deixou de ser validado');
exigir(entrega.includes('before: { tinha: antes[0].tax_id !== null }') && entrega.includes('after: { tinha: documento !== null }'), 'auditoria voltou a persistir documento do cliente');
exigir(entrega.includes("f.status = 'autorizada'") && entrega.includes('f.customer_notified_at IS NULL'), 'fila de entrega perdeu filtro de nota autorizada não entregue');
exigir(entrega.includes('AND customer_notified_at IS NULL') && entrega.includes('return carimbadas === 1'), 'entrega perdeu idempotência por carimbo condicional');

console.log(
  `finance/fiscal modular: fachada ${linhas(fachada)}; emissor ${linhas(emissor)}; config ${linhas(configuracao)}; notas ${linhas(notas)}; emissao ${linhas(emissao)}; entrega ${linhas(entrega)}; erros ${linhas(erros)} linhas`,
);
