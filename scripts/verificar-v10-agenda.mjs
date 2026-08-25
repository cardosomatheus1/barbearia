import { readFileSync } from 'node:fs';
import { lerCssDoApp } from './css-do-app.mjs';
import { fonteAdminApi } from './fonte-admin.mjs';

const pagina = readFileSync('apps/web/src/app/admin/agenda/page.tsx', 'utf8');
const marcar = readFileSync('apps/web/src/app/admin/dia/marcar/page.tsx', 'utf8');
const dominio = readFileSync('packages/scheduling/src/agenda.ts', 'utf8');
const api = fonteAdminApi();
const geometria = readFileSync('apps/web/src/lib/agenda-timeline.ts', 'utf8');
const css = lerCssDoApp();

const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

// A régua não pode inventar jornada a partir dos compromissos.
exigir(dominio.includes('resolveWorkingDay({'), 'agenda não reutiliza resolveWorkingDay para a jornada visual');
exigir(dominio.includes('FROM work_schedules'), 'agenda não carrega a jornada cadastrada');
exigir(dominio.includes('workingDays: jornadaDoDia(date, weekday)'), 'payload não entrega jornada efetiva por dia');
exigir(api.includes('workingDays: JornadaDaAgenda[]'), 'cliente web não conhece workingDays');

// Tempo é geometria, não ordem de lista.
exigir(pagina.includes('data-agenda-timeline'), 'a agenda ainda não identifica a linha do tempo');
exigir(pagina.includes('<LinhaDoTempo'), 'dia/semana continuam usando a lista antiga de colunas');
exigir(geometria.includes('export const PIXELS_POR_MINUTO = 1.5'), 'não há escala única de minutos para pixels');
exigir(geometria.includes('livresDoProfissional'), 'buracos não são derivados de jornada menos pausa/ocupação');
exigir(geometria.includes('occupiedStart'), 'buraco ignora buffer e pode oferecer o que o motor recusa');

// Horário livre é ação no lugar em que aparece, mas só para quem pode criar.
exigir(pagina.includes("const podeMarcar = podeNaTela(estado, 'appointments.create')"), 'horário livre não respeita appointments.create');
exigir(pagina.includes('/admin/dia/marcar?d=${dia.date}&p=${profissional.id}&ah=${hhmm(inicio)}'), 'buraco não abre o fluxo de agendamento no próprio ponto');
exigir(pagina.includes('const alvoCabeNaEscala = alturaPx(inicio, fim) >= 44'), 'buraco não verifica se o alvo de 44px cabe sem distorcer o tempo');
exigir(pagina.includes('podeClicar(inicio) && alvoCabeNaEscala'), 'buraco curto vira ação sobreposta em vez de preservar a proporção temporal');
exigir(marcar.includes("const horaSugerida = first(query['ah'])"), 'fluxo de marcar perde a hora clicada na agenda');
exigir(marcar.includes("href={link({ e: profissional ? 'c' : 'b' })}"), 'fluxo obriga escolher de novo o profissional já vindo da agenda');

// Mobile: uma cadeira de cada vez, sem espremer colunas para caber.
exigir(/@media (?:\(min-width: 0px\) and )?\(max-width: 767px\)[\s\S]*?\.agenda-linha__coluna\s*\{[^}]*flex-basis:\s*calc\(100vw - 4\.5rem\);[^}]*width:\s*calc\(100vw - 4\.5rem\)/.test(css), 'mobile não dá uma coluna inteira, com largura própria, para cada profissional');
exigir(css.includes('scroll-snap-align: start'), 'mobile não oferece troca horizontal previsível entre profissionais');
exigir(css.includes('.agenda-linha__scroll') && css.includes('overflow-x: auto'), 'rolagem da agenda não está contida no próprio recipiente');

// A vista lista continua existindo como alternativa textual; V10 muda dia/semana.
exigir(pagina.includes("vista === 'lista'"), 'V10 removeu a alternativa de lista');

if (falhas.length) {
  console.error(`V10: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}

console.log('V10: agenda proporcional ao tempo; jornada real, alvos livres seguros e mobile sem colunas espremidas');
