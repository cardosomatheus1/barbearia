#!/usr/bin/env node
/**
 * Guarda da matriz de prontidão do ROADMAP (R7).
 *
 * O antigo "129 de 129" respondia quantos blocos foram fechados, não se uma
 * capacidade tem integração real, E2E e condição de produção. Esta guarda
 * transforma a matriz em fonte verificável: valida estados, prova citada e
 * contradições óbvias nas superfícies que descrevem o estado atual.
 *
 * Sem banco, sem rede e sem dependência npm. Precisa rodar antes do build.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = process.env['PRONTIDAO_RAIZ'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const roadmapPath = join(raiz, 'ROADMAP.md');
const roadmap = readFileSync(roadmapPath, 'utf8');
const problemas = [];
const falhar = (msg) => problemas.push(msg);

function linhasDaTabela(fonte, cabecalho) {
  const inicio = fonte.indexOf(cabecalho);
  if (inicio === -1) return null;
  const linhas = [];
  for (const linha of fonte.slice(inicio).split('\n').slice(2)) {
    if (!linha.startsWith('|')) break;
    linhas.push(linha.split('|').slice(1, -1).map((c) => c.trim()));
  }
  return linhas;
}

const CABECALHO = '| Funcionalidade | Motor | Tela | Integração real | E2E real | Produção | Evidência |';
const linhas = linhasDaTabela(roadmap, CABECALHO);
if (!linhas) falhar('não achei a matriz de prontidão no ROADMAP.md');
if (linhas && linhas.length === 0) falhar('a matriz de prontidão está vazia');

const ESTADOS = new Set(['✅', '⚠️', '❌', '—']);
const OBRIGATORIAS = [
  'Agenda',
  'Comanda / caixa / comissão',
  'WhatsApp (Meta Cloud)',
  'Stripe (cobrança da plataforma)',
  'Split de pagamento',
  'Fiscal (NFS-e)',
  'Sinal cobrado online',
  'Foto por envio de arquivo',
];
const porNome = new Map();

for (const [nome, motor, tela, integracao, e2e, producao, evidencia] of linhas ?? []) {
  if (!nome) {
    falhar('há uma linha de prontidão sem funcionalidade');
    continue;
  }
  if (porNome.has(nome)) falhar(`${nome}: funcionalidade duplicada na matriz`);
  porNome.set(nome, { motor, tela, integracao, e2e, producao });

  for (const [coluna, valor] of [['Motor', motor], ['Tela', tela], ['Integração real', integracao], ['E2E real', e2e], ['Produção', producao]]) {
    if (!ESTADOS.has(valor)) falhar(`${nome}: ${coluna} tem estado inválido "${valor}"`);
  }

  if (producao === '✅') {
    if (motor !== '✅' || tela !== '✅' || e2e === '❌' || !['✅', '—'].includes(integracao)) {
      falhar(`${nome}: Produção ✅ exige Motor/Tela ✅, E2E diferente de ❌ e Integração ✅ ou —`);
    }
  }
  if (integracao === '❌' && producao !== '❌') {
    falhar(`${nome}: Integração real ❌ exige Produção ❌`);
  }

  const refs = [...(evidencia ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (refs.length === 0) {
    falhar(`${nome}: coluna Evidência não tem referência verificável`);
    continue;
  }
  for (const ref of refs) {
    const [arquivo, ...partes] = ref.split('::');
    const trecho = partes.join('::');
    if (!arquivo || arquivo.includes('..')) {
      falhar(`${nome}: evidência inválida "${ref}"`);
      continue;
    }
    const absoluto = join(raiz, arquivo);
    if (!existsSync(absoluto) || !statSync(absoluto).isFile()) {
      falhar(`${nome}: arquivo de evidência não existe: ${arquivo}`);
      continue;
    }
    if (trecho && !readFileSync(absoluto, 'utf8').includes(trecho)) {
      falhar(`${nome}: evidência perdeu o trecho "${trecho}" em ${arquivo}`);
    }
  }
}

for (const nome of OBRIGATORIAS) {
  if (!porNome.has(nome)) falhar(`a matriz perdeu a funcionalidade obrigatória "${nome}"`);
}

// R7 substitui o contador. Ele pode sobreviver em histórico de commit, não na
// fonte de verdade atual.
if (/\*\*Status:\s*\d+\s+de\s+\d+\s+blocos\.\*\*/.test(roadmap) || /129\s*(?:de|\/)\s*129/i.test(roadmap)) {
  falhar('o ROADMAP ainda usa contador global de blocos como prontidão');
}

// A busca de contradição percorre o repositório inteiro, com três exclusões
// deliberadas: SPEC/docs/spec descrevem o produto-alvo; documentos 01/02 são
// pesquisa de concorrente; testes e migrações contêm frases fabricadas ou
// históricas. Todo o resto — documentação, scripts e código que chega à UI — é
// superfície de estado atual para esta guarda.
const EXTENSOES_DE_TEXTO = new Set(['.md', '.ts', '.tsx', '.js', '.mjs', '.sql', '.sh']);

function fontesDeEstadoAtual(diretorio = raiz) {
  const saida = [];
  for (const nome of readdirSync(diretorio)) {
    const absoluto = join(diretorio, nome);
    const rel = absoluteToRelative(absoluto);
    const st = statSync(absoluto);
    if (st.isDirectory()) {
      if (['.git', 'node_modules', 'dist', '.next'].includes(nome)) continue;
      if (rel === 'docs/spec' || rel === 'docs/comercial') continue;
      saida.push(...fontesDeEstadoAtual(absoluto));
      continue;
    }
    if (!st.isFile()) continue;
    if (!EXTENSOES_DE_TEXTO.has(extensao(nome))) continue;
    if (rel === 'SPEC.md' || rel === 'docs/01-analise-salonsoft.md' || rel === 'docs/02-benchmark-apps-barbearia.md') continue;
    if (/\.test\.[^.]+$/.test(nome) || rel.startsWith('packages/db/migrations/')) continue;
    saida.push({ arquivo: rel, conteudo: readFileSync(absoluto, 'utf8') });
  }
  return saida;
}

function absoluteToRelative(absoluto) {
  const normalizado = absoluto.replaceAll('\\', '/');
  const base = raiz.replaceAll('\\', '/').replace(/\/$/, '');
  return normalizado.startsWith(`${base}/`) ? normalizado.slice(base.length + 1) : normalizado;
}

function extensao(nome) {
  const i = nome.lastIndexOf('.');
  return i === -1 ? '' : nome.slice(i);
}

// Contradições de alto sinal. A guarda não tenta interpretar português livre;
// ela impede as formulações inequívocas que transformariam um ❌ da matriz em
// promessa de produto. R8 fará a revisão comercial completa.
const regras = [
  {
    nome: 'Split de pagamento',
    ativo: (r) => r?.integracao === '❌' || r?.producao === '❌',
    positivos: [
      /\bsplit\b[^\n]{0,80}\b(?:est[aá]\s+)?pront[oa]\b/i,
      /\bsplit\b[^\n]{0,80}\bem produ[cç][aã]o\b/i,
      /\bsplit\b[^\n]{0,80}\bintegra[cç][aã]o real\b/i,
    ],
  },
  {
    nome: 'Fiscal (NFS-e)',
    ativo: (r) => r?.integracao === '❌' || r?.producao === '❌',
    positivos: [
      /NFS-e[^\n]{0,80}\b(?:est[aá]\s+)?pront[oa]\b/i,
      /NFS-e[^\n]{0,80}\bem produ[cç][aã]o\b/i,
      /NFS-e[^\n]{0,80}\bintegra[cç][aã]o real\b/i,
    ],
  },
  {
    nome: 'Sinal cobrado online',
    ativo: (r) => r?.producao === '❌',
    positivos: [
      /sinal[^\n]{0,80}\bonline[^\n]{0,40}\bpront[oa]\b/i,
      /sinal[^\n]{0,80}\bcobran[cç]a autom[aá]tica[^\n]{0,40}\bpront[oa]\b/i,
    ],
  },
  {
    nome: 'Foto por envio de arquivo',
    ativo: (r) => r?.producao === '❌',
    positivos: [
      /(?:upload|envio) de (?:arquivo|foto)[^\n]{0,60}\bpront[oa]\b/i,
      /foto[^\n]{0,60}\bupload[^\n]{0,40}\bem produ[cç][aã]o\b/i,
    ],
  },
];

for (const { arquivo, conteudo } of fontesDeEstadoAtual()) {
  for (const regra of regras) {
    const estado = porNome.get(regra.nome);
    if (!regra.ativo(estado)) continue;
    for (const padrao of regra.positivos) {
      const achado = padrao.exec(conteudo);
      if (achado) {
        falhar(`${regra.nome}: ${arquivo} contradiz a matriz com "${achado[0].trim()}"`);
      }
    }
  }
}

if (problemas.length === 0) {
  console.log(`prontidão: ${linhas?.length ?? 0} funcionalidade(s), matriz e evidências coerentes`);
  process.exit(0);
}

console.error('prontidão: %d problema(s)\n', problemas.length);
for (const problema of problemas) console.error(`  - ${problema}`);
process.exit(1);
