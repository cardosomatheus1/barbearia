#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function avaliarA11yUx({
  casco,
  busca,
  buscaCss,
  comanda,
  cliente,
  primitives,
  tokensCss,
  agendaCss,
  agendaPage,
  conferirTelas,
}) {
  const falhas = [];
  const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

  exigir(casco.includes('<SkipLink targetId="conteudo-principal" />'), 'casco do admin perdeu o atalho de pular navegação');
  exigir(casco.includes('id="conteudo-principal" tabIndex={-1}'), 'destino do skip-link não é focalizável');
  exigir(primitives.includes('.ui-skip-link:focus'), 'skip-link não tem estado visível de foco');

  exigir(busca.includes('aria-modal="true"'), 'busca global deixou de se declarar modal');
  exigir(busca.includes('aria-expanded={aberta}'), 'gatilho da busca não expõe o estado aberto/fechado');
  exigir(busca.includes('aria-controls="busca-global-dialogo"'), 'gatilho da busca não aponta para o diálogo controlado');
  exigir(busca.includes('ref={dialogo}'), 'busca global perdeu a referência do diálogo');
  exigir(busca.includes("evento.key !== 'Tab'"), 'busca global não trata Tab para manter o foco no modal');
  exigir(busca.includes('evento.shiftKey'), 'busca global não trata Shift+Tab no ciclo de foco');
  exigir(busca.includes("evento.key === 'Escape'"), 'busca global não fecha com Escape global');
  exigir(busca.includes('ultimoFoco.current'), 'busca global não guarda/restaura o foco de origem');
  exigir(busca.includes("document.body.style.overflow = 'hidden'"), 'busca global não bloqueia a rolagem atrás do modal');
  exigir(busca.includes('ref={gatilho}'), 'gatilho da busca não pode receber foco de volta');

  exigir(buscaCss.includes('.cabecalho:focus-within'), 'campo de busca não tem indicação visual de foco');
  const focoFechar = buscaCss.match(/\.fechar:focus-visible\s*\{[^}]+\}/s)?.[0] ?? '';
  exigir(focoFechar.includes('outline: 2px solid var(--color-accent)'), 'botão de fechar busca perdeu o anel de foco');
  const focoResultado = buscaCss.match(/\.resultado:focus-visible\s*\{[^}]+\}/s)?.[0] ?? '';
  exigir(focoResultado.includes('outline: 2px solid var(--color-accent)'), 'resultado da busca perdeu o anel de foco');
  const gatilho = buscaCss.match(/\.gatilho\s*\{[^}]+\}/s)?.[0] ?? '';
  exigir(gatilho.includes('min-height: var(--size-touch)'), 'gatilho da busca ficou menor que o alvo de toque do produto');

  exigir(comanda.includes('{linhaDePagamento(0)}'), 'comanda deixou de mostrar uma forma de pagamento primária');
  exigir(comanda.includes('Dividir em mais formas'), 'comanda perdeu a revelação progressiva do pagamento dividido');
  exigir(comanda.includes('([1, 2] as const).map(linhaDePagamento)'), 'formas extras da comanda não estão confinadas à dobra opcional');
  exigir(!comanda.includes('[0, 1, 2].map((i)'), 'comanda voltou a mostrar três formas de pagamento de uma vez');

  exigir(cliente.includes("alt={foto.legenda ?? `Foto ${foto.tipo === 'antes' ? 'antes' : 'depois'} do atendimento`}"), 'foto clínica/operacional da ficha voltou a ter alt vazio');

  exigir(
    tokensCss.includes(':where(a, button, input, select, textarea, summary, [tabindex]):focus-visible'),
    'summary deixou de herdar o anel de foco global do design system',
  );
  const resumoAgenda = agendaCss.match(/\.agenda-evento__acoes > summary\s*\{[^}]+\}/s)?.[0] ?? '';
  exigir(resumoAgenda.includes('width: var(--size-touch)'), 'menu de ações da Agenda voltou a ter alvo menor que 44px');
  exigir(resumoAgenda.includes('height: var(--size-touch)'), 'menu de ações da Agenda voltou a ter altura menor que 44px');
  exigir(agendaCss.includes('padding: 4px 3rem 4px 8px;'), 'cartão da Agenda não reserva espaço para o alvo de 44px das ações');
  const removerBloqueio = agendaCss.match(/\.agenda-bloqueio__remover\s*\{[^}]+\}/s)?.[0] ?? '';
  exigir(removerBloqueio.includes('min-height: var(--size-touch)'), 'remoção de bloqueio voltou a ter alvo menor que 44px');
  exigir(agendaPage.includes('const cabeAcao = altura >= 44;'), 'bloqueio curto voltou a desenhar ação que não cabe na escala temporal');
  exigir(agendaPage.includes('{cabeAcao ? ('), 'ação de bloqueio curto deixou de ser progressiva');

  exigir(conferirTelas.includes('async function auditarSuperficie'), 'conferência global perdeu o V8 técnico em runtime');
  exigir(conferirTelas.includes('auditarSuperficie(page, rota, 360)'), 'V8 runtime não mede mais a largura móvel de 360px');
  exigir(conferirTelas.includes('overflow horizontal do documento'), 'V8 runtime deixou de detectar overflow horizontal');
  exigir(conferirTelas.includes('controle sem rótulo'), 'V8 runtime deixou de detectar controle sem rótulo');
  exigir(conferirTelas.includes('alvo <44px'), 'V8 runtime deixou de medir alvos de toque');
  exigir(conferirTelas.includes('imagem quebrada'), 'V8 runtime deixou de detectar mídia quebrada');
  exigir(conferirTelas.includes('H1 visível'), 'V8 runtime deixou de conferir hierarquia de título');
  exigir(conferirTelas.includes('tabela larga sem .ui-scroll-x'), 'V8 runtime deixou de confinar tabela larga');

  return falhas;
}

function fontesDoRepositorio() {
  return {
    casco: readFileSync('apps/web/src/app/admin/casco.tsx', 'utf8'),
    busca: readFileSync('apps/web/src/app/admin/busca-global.tsx', 'utf8'),
    buscaCss: readFileSync('apps/web/src/app/admin/busca-global.module.css', 'utf8'),
    comanda: readFileSync('apps/web/src/app/admin/comanda/[id]/page.tsx', 'utf8'),
    cliente: readFileSync('apps/web/src/app/admin/cliente/[id]/componentes.tsx', 'utf8'),
    primitives: readFileSync('packages/ui/src/components/primitives.tsx', 'utf8'),
    tokensCss: readFileSync('packages/ui/src/tokens/css.ts', 'utf8'),
    agendaCss: readFileSync('apps/web/src/app/styles/120-agenda-timeline.css', 'utf8'),
    agendaPage: readFileSync('apps/web/src/app/admin/agenda/page.tsx', 'utf8'),
    conferirTelas: readFileSync('scripts/conferir-telas.mjs', 'utf8'),
  };
}

const executadoDireto = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (executadoDireto) {
  const falhas = avaliarA11yUx(fontesDoRepositorio());
  if (falhas.length) {
    console.error(`A11Y/UX reprovado (${falhas.length})`);
    for (const falha of falhas) console.error(`- ${falha}`);
    process.exit(1);
  }
  console.log('A11Y/UX: shell, modal, pagamento progressivo, foco de summary, alvo da Agenda e V8 runtime global OK');
}
