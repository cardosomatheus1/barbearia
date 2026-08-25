import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/verificar-segredos.mjs');
const executar = (arquivos) => {
  const dir = mkdtempSync(join(tmpdir(), 'barberdock-secrets-'));
  try {
    for (const [nome, conteudo] of Object.entries(arquivos)) {
      const caminho = join(dir, nome);
      mkdirSync(resolve(caminho, '..'), { recursive: true });
      writeFileSync(caminho, conteudo);
    }
    return spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('árvore sem secret passa', () => {
  const r = executar({ '.env.example': 'TOKEN=changeme\n', 'src/app.ts': "const x = process.env['TOKEN'];\n" });
  assert.equal(r.status, 0, r.stderr);
});

test('recusa arquivo .env real', () => {
  const r = executar({ '.env': 'A=B\n' });
  assert.equal(r.status, 1); assert.match(r.stderr, /arquivo \.env/);
});

test('recusa private key sem imprimir conteúdo', () => {
  const marcador = '-----BEGIN ' + 'PRIVATE KEY-----';
  const r = executar({ 'segredo.txt': `${marcador}\nmaterial\n` });
  assert.equal(r.status, 1); assert.match(r.stderr, /chave privada PEM/); assert.doesNotMatch(r.stderr, /material/);
});

test('recusa credencial AWS de alta confiança', () => {
  const chave = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
  const r = executar({ 'src/config.ts': `export const x = '${chave}';\n` });
  assert.equal(r.status, 1); assert.match(r.stderr, /AWS access key/); assert.doesNotMatch(r.stderr, new RegExp(chave));
});

test('recusa literal longo atribuído a nome de secret em produção', () => {
  const literal = 'muito-longo-e-unico-valor-confidencial-123456789';
  const r = executar({ 'src/config.ts': `const API_KEY = '${literal}';\n` });
  assert.equal(r.status, 1); assert.match(r.stderr, /secret literal/); assert.doesNotMatch(r.stderr, new RegExp(literal));
});


const executarHistorico = (primeiroNome, primeiroConteudo) => {
  const dir = mkdtempSync(join(tmpdir(), 'barberdock-secrets-git-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(git('init').status, 0);
    git('config','user.email','teste@example.com'); git('config','user.name','Teste');
    const caminho = join(dir, primeiroNome); mkdirSync(resolve(caminho,'..'), { recursive: true }); writeFileSync(caminho, primeiroConteudo);
    assert.equal(git('add','.').status,0); assert.equal(git('commit','-m','segredo antigo').status,0);
    rmSync(caminho,{force:true}); assert.equal(git('add','-A').status,0); assert.equal(git('commit','-m','remove segredo').status,0);
    return spawnSync(process.execPath, [script,'--history'], { cwd: dir, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('histórico recusa .env que já foi removido', () => {
  const r = executarHistorico('.env', 'NORMAL=valor\n');
  assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /\.env no histórico Git/);
});

test('histórico recusa secret genérico removido sem imprimir valor', () => {
  const valor = 'segredo-antigo-unico-12345678901234567890';
  const r = executarHistorico('config.txt', `WHATSAPP_APP_SECRET=${valor}\n`);
  assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /secret literal no histórico Git/); assert.doesNotMatch(r.stderr, new RegExp(valor));
});
