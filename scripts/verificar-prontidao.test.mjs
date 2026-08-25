import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./verificar-prontidao.mjs', import.meta.url));
const temporarios = [];
afterEach(() => {
  for (const dir of temporarios.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PADRAO = {
  'Agenda': ['✅', '✅', '—', '⚠️', '✅'],
  'Comanda / caixa / comissão': ['✅', '✅', '—', '⚠️', '✅'],
  'WhatsApp (Meta Cloud)': ['✅', '✅', '✅', '⚠️', '⚠️'],
  'Stripe (cobrança da plataforma)': ['✅', '✅', '✅', '⚠️', '⚠️'],
  'Split de pagamento': ['✅', '✅', '❌', '❌', '❌'],
  'Fiscal (NFS-e)': ['✅', '✅', '❌', '❌', '❌'],
  'Sinal cobrado online': ['✅', '⚠️', '⚠️', '❌', '❌'],
  'Foto por envio de arquivo': ['❌', '❌', '❌', '❌', '❌'],
};

function repo({ overrides = {}, evidencia = {}, extraRoadmap = '', readme = '', omitir = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'barbearia-prontidao-'));
  temporarios.push(dir);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'apps/web/src'), { recursive: true });
  writeFileSync(join(dir, 'prova.txt'), 'existe\n');
  writeFileSync(join(dir, 'README.md'), readme);
  writeFileSync(join(dir, 'docs/go-live.md'), '');
  writeFileSync(join(dir, 'docs/deploy.md'), '');

  const linhas = Object.entries(PADRAO)
    .filter(([nome]) => nome !== omitir)
    .map(([nome, estados]) => {
      const e = overrides[nome] ?? estados;
      return `| ${nome} | ${e.join(' | ')} | ${evidencia[nome] ?? '`prova.txt::existe`'} |`;
    })
    .join('\n');

  writeFileSync(join(dir, 'ROADMAP.md'), `# Roadmap\n\n| Funcionalidade | Motor | Tela | Integração real | E2E real | Produção | Evidência |\n|---|---|---|---|---|---|---|\n${linhas}\n\n${extraRoadmap}\n`);
  return dir;
}

function rodar(dir) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, PRONTIDAO_RAIZ: dir },
    encoding: 'utf8',
  });
}

test('aceita a matriz coerente com evidência real', () => {
  const r = rodar(repo());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /8 funcionalidade\(s\)/);
});

test('recusa produção verde sobre integração ausente', () => {
  const r = rodar(repo({ overrides: { 'Split de pagamento': ['✅', '✅', '❌', '⚠️', '✅'] } }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Produção ✅ exige/);
  assert.match(r.stderr, /Integração real ❌ exige Produção ❌/);
});

test('recusa produção verde quando o E2E é explicitamente ausente', () => {
  const r = rodar(repo({ overrides: { 'Agenda': ['✅', '✅', '—', '❌', '✅'] } }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /E2E diferente de ❌/);
});

test('recusa evidência cujo trecho sumiu do código', () => {
  const r = rodar(repo({ evidencia: { 'Agenda': '`prova.txt::nao-existe`' } }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /evidência perdeu o trecho/);
});

test('recusa evidência cujo arquivo sumiu', () => {
  const r = rodar(repo({ evidencia: { 'Agenda': '`sumiu.txt::existe`' } }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /arquivo de evidência não existe/);
});

test('recusa promessa explícita de split pronto quando a matriz diz ❌', () => {
  const r = rodar(repo({ readme: 'O split está pronto para todos.\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /README.md contradiz a matriz/);
});

test('recusa promessa explícita de NFS-e pronta quando não há emissor real', () => {
  const r = rodar(repo({ readme: 'A NFS-e está pronta para produção.\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Fiscal \(NFS-e\).*contradiz a matriz/);
});


test('recusa promessa contraditória em código de UI, não só em documentação', () => {
  const dir = repo();
  writeFileSync(join(dir, 'apps/web/src/promessa.tsx'), 'export const texto = \"O split está pronto para uso.\";\n');
  const r = rodar(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /apps\/web\/src\/promessa\.tsx contradiz a matriz/);
});

test('recusa o contador global antigo como selo de prontidão', () => {
  const r = rodar(repo({ extraRoadmap: '**Status: 129 de 129 blocos.**' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /contador global de blocos/);
});

test('recusa remoção silenciosa de uma capacidade da matriz', () => {
  const r = rodar(repo({ omitir: 'Fiscal (NFS-e)' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /perdeu a funcionalidade obrigatória/);
});
