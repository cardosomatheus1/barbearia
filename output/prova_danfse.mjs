import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { certificadoNfseSintetico, nfseSintetica, CHAVE_TESTE_NFSE } from '../packages/finance/test/nfse-fixtures.ts';
import { gerarDps } from '../packages/finance/src/nfse/dps.ts';
import { assinarDps } from '../packages/finance/src/nfse/assinatura.ts';
import { gerarDanfse } from '../packages/finance/src/nfse/danfse.ts';
const require = createRequire(new URL('../packages/finance/package.json', import.meta.url));
const { getDocument } = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const { createCanvas } = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
const cred = certificadoNfseSintetico();
process.env.FISCAL_AUTORIDADES_PEM_B64 = Buffer.from(cred.certificado.certificadoPem).toString('base64');
const pastaFontes = '/home/ec2-user/codex-tmp/raiz-audit-independent/tools/font-runtime/usr/share/fonts/liberation-sans/';
const fontes = { arialNegrito: await readFile(pastaFontes + 'LiberationSans-Bold.ttf'), arialRegular: await readFile(pastaFontes + 'LiberationSans-Regular.ttf'), conteudo: await readFile(pastaFontes + 'LiberationSans-Regular.ttf') };
const pasta = new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/', import.meta.url);
await mkdir(pasta, { recursive: true });
const casos = [];
for (const nome of ['regular', 'cancelada', 'descricao-longa', 'mei-sem-tomador']) {
 const mei = nome === 'mei-sem-tomador';
 const dados = { ambiente: 'homologacao', cnpj: cred.certificado.cnpj, municipioEmissor: '3550308', municipioPrestacao: '3550308',
  serie: 7, numero: '1234', emitidaEm: new Date('2026-09-10T01:00:00Z'), competencia: '2026-09-09', regime: mei ? 'mei' : 'normal',
  codigoNacional: '060101', servicoCents: 5000, descricao: nome === 'descricao-longa' ? 'Corte e barba com acabamento detalhado. '.repeat(50) : 'Corte e barba com acabamento. Documento sintético sem valor fiscal.',
  ...(!mei ? { nbs: '126021000', perfilIbsCbs: 'regular_presencial', tributosAproximadosBps: { federal: 1345, estadual: 0, municipal: 500 },
  tomador: { documento: '52998224725', nome: 'Cliente do atendimento sintético' } } : {}) };
 const dps = gerarDps(dados);
 const xml = nfseSintetica(assinarDps(dps.xml, cred.certificado, dps.id, 'sha1'), cred.certificado);
 const pdf = await gerarDanfse(xml, CHAVE_TESTE_NFSE, fontes, nome === 'cancelada');
 await writeFile(new URL(`danfse-${nome}.pdf`, pasta), pdf);
 const doc = await getDocument({ data: Uint8Array.from(pdf), useSystemFonts: false, disableFontFace: true }).promise;
 try {
  assert.equal(doc.numPages, 1); const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1.6 }); const canvas = createCanvas(viewport.width, viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
  await writeFile(new URL(`danfse-${nome}.png`, pasta), canvas.toBuffer('image/png'));
  const texto = (await page.getTextContent()).items.map(i => i.str ?? '').join(' ');
  assert.ok(texto.includes('NFS-e SEM VALIDADE JURÍDICA')); assert.ok(texto.includes('INFORMAÇÕES COMPLEMENTARES'));
  casos.push({ nome, paginas: doc.numPages, bytes: pdf.length });
 } finally { await doc.destroy(); }
}
console.log(JSON.stringify({ resultado: 'passou', casos, fontesSinteticas: true, redeFiscal: false }));
