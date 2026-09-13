import { readFileSync } from 'node:fs';
import { lerCssDoApp } from './css-do-app.mjs';
import { fonteAcoesAdmin } from './fonte-admin.mjs';

const secoes = readFileSync('apps/web/src/app/admin/secoes.ts', 'utf8');
const casco = readFileSync('apps/web/src/app/admin/casco.tsx', 'utf8');
const css = lerCssDoApp();
const admin = readFileSync('apps/web/src/app/admin/page.tsx', 'utf8');
const entrar = readFileSync('apps/web/src/app/admin/entrar/page.tsx', 'utf8');
const acoes = fonteAcoesAdmin();

const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

const LEGADO = [
  '/admin/painel', '/admin/assistente', '/admin/dia', '/admin/agenda', '/admin/fila',
  '/admin/recados', '/admin/recepcao', '/admin/avaliacoes', '/admin/caixa', '/admin/comanda',
  '/admin/fiado', '/admin/financeiro', '/admin/comissao', '/admin/dre', '/admin/whatsapp',
  '/admin/campanhas', '/admin/automacoes', '/admin/avisos', '/admin/retencao', '/admin/fidelidade',
  '/admin/catalogo', '/admin/precos', '/admin/pacotes', '/admin/clube', '/admin/profissionais',
  '/admin/recursos', '/admin/estoque', '/admin/fotos', '/admin/franquia', '/admin/fiscal',
  '/admin/chaves', '/admin/webhooks', '/admin/equipe', '/admin/unidades', '/admin/plano',
  '/admin/configuracoes', '/admin/seguranca', '/admin/importar', '/admin/lgpd', '/admin/trilha',
];

for (const href of LEGADO) {
  exigir(secoes.includes(`href: '${href}'`), `destino legado desapareceu do registro: ${href}`);
}

const hrefs = [...secoes.matchAll(/href: '(\/admin\/[^']+)'/g)].map((m) => m[1]);
for (const href of LEGADO) {
  exigir(hrefs.filter((x) => x === href).length === 1, `destino legado duplicado ou ausente: ${href}`);
}

// O bloco 140 partiu duas áreas e fundiu uma terceira. "Atendimento" saiu porque
// metade dela era caixa de entrada de reclamação, e o que restava — a fila e a
// comanda — pertence a quem já tem área: a agenda e o dinheiro. "Gestão" saiu
// porque doze telas sem parentesco não são uma área, são o que sobrou.
for (const nome of ['Hoje', 'Agenda', 'Clientes', 'Financeiro', 'Crescimento', 'Cardápio e equipe', 'Marca e lojas', 'Configurações']) {
  exigir(secoes.includes(`nome: '${nome}'`), `área sem o vocabulário esperado: ${nome}`);
}
// `Visão geral`, `Marketing`, `Cadastros`, `Integrações` e `Administração` foram
// as áreas até o V0, e saíram por um motivo escrito em
// `docs/04-backlog-pos-revisao.md`: é como um arquiteto organiza funcionalidade,
// não como a recepção pensa. A avaliação cega do bloco 139 propôs de volta
// "Visão geral" e "Cadastros" — é o nome que ocorre a quem olha a lista de
// fora, e esta linha é o que impede de refazer a decisão sem saber que ela
// já foi tomada.
for (const antigo of ["nome: 'Visão geral'", "nome: 'Marketing'", "nome: 'Cadastros'", "nome: 'Integrações'", "nome: 'Administração'", "nome: 'Atendimento'", "nome: 'Gestão'", "nome: 'Minha barbearia'", "nome: 'A casa'"]) {
  exigir(!secoes.includes(antigo), `vocabulário antigo ainda está como área: ${antigo}`);
}

const pares = [
  ['/admin/comanda', "id: 'financeiro'"],
  ['/admin/clube', "id: 'crescimento'"],
  ['/admin/fiscal', "id: 'financeiro'"],
  ['/admin/unidades', "id: 'lojas'"],
  ['/admin/chaves', "id: 'configuracoes'"],
  ['/admin/webhooks', "id: 'configuracoes'"],
];
for (const [href, id] of pares) {
  const posHref = secoes.indexOf(`href: '${href}'`);
  const posModulo = secoes.lastIndexOf(id, posHref);
  exigir(posHref >= 0 && posModulo >= 0, `${href} não está sob ${id}`);
}

exigir(/href: '\/admin\/assistente'[\s\S]{0,180}posicao: 'utilitario'/.test(secoes), 'Assistente voltou a competir como destino de menu');
exigir(casco.includes('utilitariosVisiveis(modulos)'), 'casco não deriva o Assistente do registro');
exigir(casco.includes('trilho__separador'), 'Configurações não tem separação visual mínima');

for (const modulo of ['hoje', 'agenda', 'clientes', 'financeiro', 'crescimento', 'barbearia', 'lojas', 'configuracoes']) {
  exigir(css.includes(`data-modulo-atual='${modulo}'`), `CSS não reconhece o módulo ${modulo}`);
}

exigir(admin.includes('redirect(destinoInicialDoPainel(estado))'), '/admin não usa a decisão central de destino por perfil');
exigir(entrar.includes("redirect('/admin')"), 'sessão existente no login não volta para /admin');
exigir(acoes.includes("mustChangePassword ? '/admin/trocar-senha' : '/admin'"), 'login não passa pela porta central /admin');

if (falhas.length) {
  console.error(`V0: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}

console.log(`V0: vocabulário, ${LEGADO.length} destinos legados e porta por perfil coerentes`);
