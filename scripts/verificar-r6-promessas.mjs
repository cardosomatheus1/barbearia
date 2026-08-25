#!/usr/bin/env node
/**
 * R6 — títulos históricos não podem prometer o pedaço que a tabela de lacunas
 * ainda declara aberto.
 *
 * Não tenta "entender português". Os pares abaixo são deliberados e ficam
 * documentados no ROADMAP. A guarda prova três coisas:
 *  1. a lacuna que justifica a ressalva continua aberta;
 *  2. o bloco continua existindo e marcado ✅;
 *  3. o título não voltou à formulação que escondia a lacuna.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = process.env['R6_RAIZ'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const roadmap = readFileSync(join(raiz, 'ROADMAP.md'), 'utf8');
const problemas = [];
const falhar = (m) => problemas.push(m);

function linhasDaTabela(fonte, cabecalho) {
  const i = fonte.indexOf(cabecalho);
  if (i === -1) return null;
  const out = [];
  for (const linha of fonte.slice(i).split('\n').slice(2)) {
    if (!linha.startsWith('|')) break;
    out.push(linha.split('|').slice(1, -1).map((c) => c.trim()));
  }
  return out;
}

function blocos(fonte) {
  const out = new Map();
  for (const linha of fonte.split('\n')) {
    const m = /^\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(✅)?\s*\|$/.exec(linha);
    if (!m) continue;
    out.set(m[1], { titulo: m[2], feito: Boolean(m[3]) });
  }
  return out;
}

const lacunas = linhasDaTabela(roadmap, '| Lacuna | Pronto | Falta | Bloco |') ?? [];
const nomesDasLacunas = new Set(lacunas.map(([nome]) => nome));
const porBloco = blocos(roadmap);

const regras = [
  { bloco: '15', lacuna: 'Arrastar o cartão na agenda para remarcar', proibido: [/\barrastar\b/i] },
  { bloco: '23', lacuna: 'Publicação automática e ambiente de staging', proibido: [/\bCI\/CD\b/i, /\bstaging\b/i] },
  { bloco: '33', lacuna: 'Teto de requisição compartilhado entre processos', proibido: [/rate limit global/i] },
  { bloco: '35', lacuna: 'Pix pela Stripe, e o prazo do QR Code', proibido: [/Pix pela Stripe/i], exige: [/ativa[cç][aã]o na conta pendente/i] },
  { bloco: '50', lacuna: 'Contrato de split exercido pelo adquirente', exige: [/provider fake/i] },
  { bloco: '53', lacuna: 'Fatura em PDF e nota fiscal', exige: [/provider fake/i] },
  { bloco: '54', lacuna: 'Fatura em PDF e nota fiscal', exige: [/emissor real pendente/i] },
  { bloco: '57', lacuna: 'Campanha por e-mail, push e SMS', proibido: [/Campanhas:\s*filtros,\s*canais/i], exige: [/WhatsApp/i] },
  { bloco: '70', lacuna: 'Filtro por **serviço** na busca do marketplace', exige: [/filtros implementados/i] },
];

for (const regra of regras) {
  if (!nomesDasLacunas.has(regra.lacuna)) {
    falhar(`R6: a lacuna que limita o bloco ${regra.bloco} sumiu sem revisar a guarda: "${regra.lacuna}"`);
    continue;
  }
  const bloco = porBloco.get(regra.bloco);
  if (!bloco) {
    falhar(`R6: bloco ${regra.bloco} não foi encontrado`);
    continue;
  }
  if (!bloco.feito) falhar(`R6: bloco ${regra.bloco} deixou de estar marcado ✅`);
  for (const p of regra.proibido ?? []) {
    if (p.test(bloco.titulo)) falhar(`R6: bloco ${regra.bloco} voltou a prometer a lacuna aberta: "${bloco.titulo}"`);
  }
  for (const p of regra.exige ?? []) {
    if (!p.test(bloco.titulo)) falhar(`R6: bloco ${regra.bloco} perdeu a ressalva que o torna honesto: "${bloco.titulo}"`);
  }
}

if (!/## R6 — títulos históricos limitados por lacunas abertas/.test(roadmap)) {
  falhar('R6: ROADMAP perdeu a seção que explica por que os títulos foram limitados');
}

if (problemas.length) {
  console.error(`R6: ${problemas.length} problema(s)\n`);
  for (const p of problemas) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`R6: ${regras.length} promessa(s) históricas limitadas por lacunas abertas`);
