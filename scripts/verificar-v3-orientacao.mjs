import { readdirSync, readFileSync, statSync } from 'node:fs';
import { lerCssDoApp } from './css-do-app.mjs';
import { join, relative } from 'node:path';

const secoes = readFileSync('apps/web/src/app/admin/secoes.ts', 'utf8');
const casco = readFileSync('apps/web/src/app/admin/casco.tsx', 'utf8');
const css = lerCssDoApp();

const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

// A orientação sai da mesma fonte do menu: não existe uma segunda tabela de breadcrumbs.
exigir(secoes.includes('export function orientacoesVisiveis('), 'registro não deriva a orientação das telas');
exigir(casco.includes('orientacoesVisiveis(modulos)'), 'casco não usa a orientação derivada do registro');
exigir(casco.includes('aria-label="Localização"'), 'migalha de localização não existe no casco');
exigir(casco.includes('className="contexto__nota"'), 'nota da tela não acompanha a localização');

// Toda tela interna precisa de vocabulário — string nua não consegue desenhar uma migalha honesta.
for (const secao of ['meu-dia', 'cliente', 'meus-numeros', 'onboarding']) {
  const linha = secoes.split('\n').find((item) => item.includes(`secao: '${secao}'`)) ?? '';
  exigir(
    linha.includes("nome: '") && linha.includes("nota: '"),
    `seção interna ${secao} não tem nome e nota no registro`,
  );
}

// Orientações ocultas continuam no DOM; internas também precisam respeitar a
// permissão da própria porta para não anunciar telas que a pessoa não abre.
for (const [secao, permissao] of [
  ['meu-dia', 'appointments.view'],
  ['cliente', 'customers.view'],
  ['meus-numeros', 'commission.view_own'],
  ['onboarding', 'settings.manage'],
]) {
  const linha = secoes.split('\n').find((item) => item.includes(`secao: '${secao}'`)) ?? '';
  exigir(
    linha.includes(`permissao: ['${permissao}']`),
    `orientação interna ${secao} não está recortada por ${permissao}`,
  );
}
exigir(/dentro: modulo\.dentro\.filter/.test(secoes), 'modulosVisiveis não filtra as orientações internas');

// Toda seção registrada precisa de uma regra de revelação da migalha.
const registradas = [...secoes.matchAll(/secao: '([a-z-]+)'/g)].map((m) => m[1]);
const unicas = [...new Set(registradas)];
for (const secao of unicas) {
  exigir(
    css.includes(`.casco:has([data-secao='${secao}']) .contexto__orientacao[data-para='${secao}']`),
    `seção ${secao} não revela a própria migalha`,
  );
}

// O V3 elimina o segundo menu vertical no notebook. A única navegação vertical é o trilho.
exigir(css.includes('grid-template-columns: 5.25rem minmax(0, 1fr);'), 'casco desktop ainda reserva uma segunda coluna vertical');
exigir(!css.includes('grid-template-columns: 5.25rem 15rem 1fr;'), 'layout antigo de três colunas voltou');
exigir(!/\.contexto__faixa\s*\{[^}]*flex-direction:\s*column/s.test(css), 'abas voltaram a ser lista vertical');
exigir(casco.includes('if (telas.length <= 1) return null;'), 'módulo de tela única desenha aba redundante');
exigir(css.includes('.contexto__link::after'), 'aba atual não tem marcador visual consistente');

/**
 * O trilho não pode esconder destino no celular.
 *
 * Ele era `overflow-x: auto` em toda largura, e sete módulos com rótulo nunca
 * couberam em 390px: Financeiro, Crescimento, Gestão e Configurações ficavam à
 * direita da borda, atrás de um arrasto lateral que nada anunciava — a barra de
 * rolagem de celular é sobreposta e some quando ninguém a está usando. O dono
 * relatou duas vezes não achar uma tela que estava lá.
 *
 * A regra cobrada é a que o projeto já escreveu: refluir em vez de esconder, e
 * **quebrar por dentro também** — a barra da plataforma tinha `flex-wrap` na
 * externa e não na interna, e os seis destinos formavam uma linha só que não
 * cabia. Por isso os dois são cobrados, e o `nowrap` só é aceito atrás de um
 * `min-width`: solto, ele volta a valer no aparelho pequeno.
 */
// Comentário sai antes de casar: os blocos abaixo **citam** `flex: none` e
// `nowrap` para explicar por que não podem estar ali, e a primeira versão desta
// guarda reprovou a própria explicação. É a segunda vez nesta base — a de
// pureza do `core` foi a primeira.
const semComentario = css.replace(/\/\*[\s\S]*?\*\//g, '');
const semMedia = semComentario.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
for (const seletor of ['.trilho', '.trilho__grupo']) {
  const bloco = new RegExp(`\\${seletor}\\s*\\{[^}]*\\}`).exec(semMedia)?.[0] ?? '';
  exigir(/flex-wrap:\s*wrap/.test(bloco), `${seletor} não quebra em linhas no celular`);
  exigir(!/flex-wrap:\s*nowrap/.test(bloco), `${seletor} tem nowrap fora de um min-width`);
}

/**
 * `flex-wrap: wrap` no grupo não basta: com `flex: none` — que é `0 0 auto` — ele
 * não encolhe abaixo do próprio conteúdo, e os filhos nunca chegam a quebrar. A
 * primeira versão deste conserto tinha o `wrap` e o `flex: none` juntos: só o
 * grupo de configuração desceu, os sete módulos continuaram numa faixa cortada
 * em "ATEN…", e **esta guarda ficou verde** sobre a tela errada. Guarda que
 * aprova o defeito que ela existe para pegar é pior que guarda nenhuma, então o
 * que ela cobra agora é a condição inteira.
 */
const blocoGrupo = /\.trilho__grupo\s*\{[^}]*\}/.exec(semMedia)?.[0] ?? '';
exigir(
  !/flex:\s*(none|0\s+0\s)/.test(blocoGrupo),
  'grupo do trilho não encolhe, então os módulos não quebram por mais wrap que tenham',
);

// Migalha escrita dentro de página volta a criar duas fontes de verdade.
const raiz = 'apps/web/src/app/admin';
const paginas = [];
const andar = (pasta) => {
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) andar(caminho);
    else if (nome === 'page.tsx') paginas.push(caminho);
  }
};
andar(raiz);
for (const pagina of paginas) {
  const fonte = readFileSync(pagina, 'utf8');
  exigir(!fonte.includes('aria-label="Localização"'), `${relative(raiz, pagina)} escreveu migalha à mão`);
  exigir(!fonte.includes('className="migalha'), `${relative(raiz, pagina)} escreveu migalha à mão`);
}

// A ficha, que é o caso que motivou o V1, precisa dizer explicitamente Clientes > Ficha do cliente.
const linhaFicha = secoes.split('\n').find((item) => item.includes("secao: 'cliente'")) ?? '';
exigir(linhaFicha.includes("nome: 'Ficha do cliente'"), 'ficha perdeu nome de orientação');
exigir(/secao: 'cliente'[^\n]+pai: 'clientes'/.test(secoes), 'ficha não aponta para a porta Clientes');

if (falhas.length) {
  console.error(`V3: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}

console.log(`V3: ${unicas.length} seções com localização derivada e apenas um eixo vertical`);
