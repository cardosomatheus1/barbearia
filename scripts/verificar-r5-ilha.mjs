#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { lerCssDoApp } from './css-do-app.mjs';

const raiz = process.cwd();
const web = join(raiz, 'apps/web/src');
const ilha = join(web, 'app/admin/importar/resolver-conflitos.tsx');
const cssDaIlha = join(web, 'app/admin/importar/resolver-conflitos.module.css');
const problemas = [];
const falhar = (m) => problemas.push(m);

function arquivos(dir) {
  const saida = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivos(caminho));
    else if (/\.(ts|tsx)$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

const todos = arquivos(web);
const client = todos.filter((f) => /^['"]use client['"];?/m.test(readFileSync(f, 'utf8')));
if (!client.includes(ilha)) {
  falhar('a ilha inicial do R5 desapareceu');
}
// R5 abre o padrão de ilhas no admin; não congela o produto em exatamente uma.
// Novas ilhas administrativas (como a busca global do V11) são permitidas.
// Superfície pública continua server-only até um bloco que a altere deliberadamente.
const foraDoAdmin = client.filter((f) => !relative(web, f).startsWith('app/admin/'));
for (const arquivo of foraDoAdmin) {
  falhar(`Client Component fora do admin sem decisão de arquitetura: ${relative(raiz, arquivo)}`);
}

const fonte = readFileSync(ilha, 'utf8');
const css = readFileSync(cssDaIlha, 'utf8');
const globalCss = lerCssDoApp();
const controller = readFileSync(join(raiz, 'apps/api/src/admin/importacao.controller.ts'), 'utf8');
const dominio = readFileSync(join(raiz, 'packages/crm/src/importacao.ts'), 'utf8');
const resolucao = readFileSync(join(raiz, 'packages/crm/src/resolucao-de-conflito.ts'), 'utf8');
if (!/useState<Record<number, EscolhaDoConflito/.test(fonte)) falhar('a ilha não mantém estado independente por linha');
if (!/acaoResolverConflitoImportacao/.test(fonte)) falhar('a escolha da ilha não chega à ação do servidor');
if (/from ['"](?:@barbearia\/|@prisma|node:)/.test(fonte)) falhar('a ilha puxou domínio/banco/node para o bundle do navegador');
if (!/resolver-conflitos\.module\.css/.test(fonte)) falhar('a ilha não usa CSS Module próprio');
if (!/\.option\[aria-checked='true'\]/.test(css)) falhar('a escolha não tem estado visual local no CSS Module');
if (/resolver-conflitos|r5-conflict|conflito-option/.test(globalCss)) falhar('estilo da ilha vazou para o CSS global');
if (/LinhaComProblema|linha\.telefone\b/.test(fonte)) falhar('a ilha recebeu telefone bruto em vez de representação sanitizada');
if (!/@Post\('imports\/:id\/conflicts'\)[\s\S]{0,350}@Exige/.test(controller) && !/@Exige\('customers\.edit'\)[\s\S]{0,180}@Post\('imports\/:id\/conflicts'\)/.test(controller)) {
  // Decorators podem vir em qualquer ordem; o importante é a rota exigir customers.edit.
  const trecho = controller.match(/@Exige\('customers\.edit'\)[\s\S]{0,240}@Post\('imports\/:id\/conflicts'\)/);
  if (!trecho) falhar('endpoint de conflito não está protegido por customers.edit');
}
if (!/FOR UPDATE/.test(dominio)) falhar('resolução não trava o preview antes de alterar o payload');
if (!/action: 'import\.conflict_resolved'/.test(dominio)) falhar('resolução não deixa trilha de auditoria');
if (!/conflitaCom: conflito\.nome/.test(resolucao)) falhar('conflitos repetidos do mesmo telefone mantêm nome canônico obsoleto');

// Budget de fonte: não substitui o bundle do Next, mas impede a ilha de crescer
// silenciosamente enquanto a medição pós-build cuida dos chunks reais.
const gzip = gzipSync(Buffer.from(fonte)).length;
if (gzip > 2500) falhar(`ilha passou de 2,5 kB gzip de fonte (${gzip} bytes)`);

// Nenhuma superfície pública pode declarar Client Component ou importar a ilha.
const publicos = arquivos(join(web, 'app/[slug]'));
for (const arquivo of publicos) {
  const s = readFileSync(arquivo, 'utf8');
  if (/^['"]use client['"];?/m.test(s)) falhar(`superfície pública virou Client Component: ${relative(raiz, arquivo)}`);
  if (/resolver-conflitos/.test(s)) falhar(`superfície pública referencia a ilha R5: ${relative(raiz, arquivo)}`);
}

if (problemas.length) {
  console.error(`R5: ${problemas.length} problema(s)`);
  for (const p of problemas) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`R5 estrutural: ilha isolada; fonte gzip ${gzip} bytes; ${publicos.length} arquivo(s) públicos continuam servidor. Bundle/LCP final dependem do build.`);
