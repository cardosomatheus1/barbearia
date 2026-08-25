import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raiz = join(import.meta.dirname, '..');
const ler = (p) => readFileSync(join(raiz, p), 'utf8');
const exigir = (condicao, mensagem) => {
  if (!condicao) throw new Error(mensagem);
};
const linhas = (texto) => texto.split('\n').length;

const fachada = ler('packages/finance/src/comanda.ts');
const tipos = ler('packages/finance/src/comanda-tipos.ts');
const leitura = ler('packages/finance/src/comanda-leitura.ts');
const fiado = ler('packages/finance/src/comanda-fiado.ts');
const fechamento = ler('packages/finance/src/comanda-fechamento.ts');
const pacote = ler('packages/finance/src/comanda-pacote.ts');

// O hotspot original tinha 2.102 linhas e misturava leitura, tipos, fiado e
// fechamento. Estes tetos não tentam impor arquivos minúsculos; só impedem que
// as responsabilidades já extraídas voltem silenciosamente ao monólito.
exigir(linhas(fachada) <= 1500, `comanda.ts voltou a crescer demais: ${linhas(fachada)} linhas`);
exigir(linhas(tipos) <= 120, `comanda-tipos.ts cresceu além do contrato: ${linhas(tipos)} linhas`);
exigir(linhas(leitura) <= 400, `comanda-leitura.ts cresceu além do domínio de consulta: ${linhas(leitura)} linhas`);
exigir(linhas(fiado) <= 360, `comanda-fiado.ts cresceu além do domínio de crédito: ${linhas(fiado)} linhas`);
exigir(linhas(fechamento) <= 140, `comanda-fechamento.ts cresceu além dos invariantes de fechamento: ${linhas(fechamento)} linhas`);
exigir(linhas(pacote) <= 120, `comanda-pacote.ts cresceu além do snapshot/venda de pacote: ${linhas(pacote)} linhas`);

for (const [nome, fonte] of [
  ['comanda-tipos.ts', tipos],
  ['comanda-leitura.ts', leitura],
  ['comanda-fiado.ts', fiado],
  ['comanda-fechamento.ts', fechamento],
  ['comanda-pacote.ts', pacote],
]) {
  exigir(!fonte.includes("from './comanda.js'"), `${nome} criou dependência circular com a fachada`);
}

for (const nome of ['getComanda', 'comandasAbertas', 'quemEstaDevendo', 'faturamentoDoDia']) {
  exigir(!new RegExp(`export\\s+async\\s+function\\s+${nome}\\s*\\(`).test(fachada), `${nome} voltou para comanda.ts`);
  exigir(new RegExp(`export\\s+async\\s+function\\s+${nome}\\s*\\(`).test(leitura), `${nome} saiu do módulo de leitura`);
}

for (const nome of ['lancarNoExtrato', 'receberFiado']) {
  exigir(!new RegExp(`export\\s+async\\s+function\\s+${nome}\\s*\\(`).test(fachada), `${nome} voltou para comanda.ts`);
  exigir(new RegExp(`export\\s+async\\s+function\\s+${nome}\\s*\\(`).test(fiado), `${nome} saiu do módulo de fiado`);
}

exigir(tipos.includes('export class ComandaError'), 'erro público da comanda saiu do módulo de tipos');
exigir(tipos.includes('export function comandaVisivel'), 'redação de cliente saiu do módulo de tipos/visibilidade');
exigir(pacote.includes('snapshotDePacoteAtivo') && pacote.includes('itensDePacoteDaComanda'),
  'snapshot/consulta dos pacotes vendidos saiu do módulo dedicado');

// As travas financeiras mais fáceis de perder numa refatoração ficam cobradas
// na mesma fronteira que agora é dona do fiado.
exigir(fiado.includes('FOR UPDATE OF c'), 'saldo de fiado perdeu trava pessimista do cliente');
exigir(fiado.includes('pg_advisory_xact_lock'), 'recebimento de fiado perdeu trava de idempotência');
exigir(fiado.includes('idempotency_fingerprint'), 'recebimento de fiado perdeu detecção de chave conflitante');

console.log(
  `finance/comanda modular: fachada ${linhas(fachada)}; leitura ${linhas(leitura)}; fiado ${linhas(fiado)}; fechamento ${linhas(fechamento)}; pacote ${linhas(pacote)}; tipos ${linhas(tipos)} linhas`,
);
