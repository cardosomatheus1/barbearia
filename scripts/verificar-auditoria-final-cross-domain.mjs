import fs from 'node:fs';
import path from 'node:path';

const ler = (p) => fs.readFileSync(p, 'utf8');
const falhas = [];
const exigir = (ok, mensagem) => { if (!ok) falhas.push(mensagem); };

const catalogoConcorrencia = ler('packages/catalog/src/concorrencia.ts');
const recursosCatalogo = ler('packages/catalog/src/recursos.ts');
const equipeCatalogo = ler('packages/catalog/src/equipe.ts');
const servicosCatalogo = ler('packages/catalog/src/servicos.ts');
const franquiaCatalogo = ler('packages/catalog/src/franquia.ts');
const schedulingConcorrencia = ler('packages/scheduling/src/concorrencia.ts');
const booking = ler('packages/scheduling/src/booking.ts');
const fila = ler('packages/scheduling/src/fila.ts');
const oferta = ler('packages/scheduling/src/oferta.ts');
const dayboard = ler('packages/scheduling/src/dayboard.ts');
const conciliacao = ler('packages/platform/src/conciliacao.ts');
const migracao0115 = ler('packages/db/migrations/0115_platform_jobs_integracoes.sql');
const verify = ler('scripts/verify.sh');

const contar = (fonte, trecho) => fonte.split(trecho).length - 1;
const ordem = (fonte, trechos, mensagem) => {
  let anterior = -1;
  for (const trecho of trechos) {
    const atual = fonte.indexOf(trecho, anterior + 1);
    if (atual < 0 || atual <= anterior) {
      falhas.push(mensagem);
      return;
    }
    anterior = atual;
  }
};

// Catálogo × Agenda: jornada usa exatamente o mesmo namespace de lock.
exigir(
  catalogoConcorrencia.includes('barberdock:professional-config:${professionalId}')
    && schedulingConcorrencia.includes('barberdock:professional-config:${professionalId}')
    && schedulingConcorrencia.includes('pg_advisory_xact_lock_shared('),
  'Catálogo e Agenda deixaram de compartilhar a trava de configuração do profissional',
);

// Catálogo × Agenda: recurso também é capacidade e precisa de lock compartilhado.
exigir(
  contar(recursosCatalogo, "travarCatalogoDoTenant(tx, 'resources')") >= 2
    && schedulingConcorrencia.includes("${'barberdock:catalog:resources:'} || current_setting('app.tenant_id', true)"),
  'Catálogo e Agenda deixaram de compartilhar o namespace de configuração de recursos',
);
exigir(
  contar(schedulingConcorrencia, 'pg_advisory_xact_lock_shared(') >= 3,
  'leitores de disponibilidade voltaram a serializar uns aos outros com lock exclusivo',
);
exigir(
  schedulingConcorrencia.includes("${'barberdock:catalog:services:'} || current_setting('app.tenant_id', true)")
    && contar(servicosCatalogo, "travarCatalogoDoTenant(tx, 'services')") >= 2
    && franquiaCatalogo.includes("travarCatalogoDoTenant(tx, 'services')"),
  'serviço/combo voltou a mudar sem disputar a leitura de disponibilidade',
);
exigir(
  contar(equipeCatalogo, 'travarConfiguracaoDoProfissional(tx, professionalId);') >= 1
    && contar(equipeCatalogo, 'travarConfiguracaoDoProfissional(tx, params.professionalId);') >= 3,
  'edição/ativação de profissional voltou a correr contra a Agenda',
);
exigir(
  contar(booking, 'await travarConfiguracaoDoProfissional(tx,') >= 3
    && contar(booking, 'await travarConfiguracaoDeRecursos(tx);') >= 3
    && contar(booking, 'await travarConfiguracaoDeServicos(tx);') >= 3,
  'criação/hold/remarcação deixaram de disputar jornada ou configuração de recursos',
);

// Walk-in não pode ser um atalho fora das invariantes da Agenda.
ordem(fila, [
  'await travarDiaDaAgenda(tx, entrada.location_id, dataLocal);',
  'await travarConfiguracaoDoProfissional(tx, params.professionalId);',
  'await travarConfiguracaoDeRecursos(tx);',
  'await travarConfiguracaoDeServicos(tx);',
  'const contextoDoDia = await loadDayContext(tx, {',
], 'walk-in perdeu ordem day -> professional -> resources -> revalidação');
exigir(
  fila.includes('const profissionalHabilitado = contextoDoDia?.professionals.find')
    && fila.includes('Este profissional não executa todos os serviços escolhidos.')
    && fila.includes('const jornada = resolveWorkingDay({')
    && fila.includes('const janelasAtendiveis = subtract(jornada.working, jornada.breaks);')
    && fila.includes('const cabeNaJornada =')
    && fila.includes('Este atendimento não cabe na jornada atual do profissional.'),
  'walk-in voltou a ignorar skill, jornada, break ou exceção atual',
);

// Lista de espera precisa recalcular a vaga sob as mesmas travas antes do hold.
ordem(oferta, [
  'await travarDiaDaAgenda(tx, params.locationId, diaDaVaga);',
  'await travarConfiguracaoDoProfissional(tx, params.professionalId);',
  'await travarConfiguracaoDeRecursos(tx);',
  'await travarConfiguracaoDeServicos(tx);',
], 'oferta perdeu ordem day -> professional -> resources');
exigir(
  oferta.includes('async function vagaAindaExisteParaEntrada(')
    && oferta.includes('const serviceIds = await idsDeServicosDaEntrada(tx, params.entryId);')
    && oferta.includes('const context = await loadDayContext(tx, {')
    && oferta.includes('const grade = computeFromContext(context, {')
    && oferta.includes('if (!(await vagaAindaExisteParaEntrada(tx, {')
    && oferta.indexOf('if (!(await vagaAindaExisteParaEntrada(tx, {') < oferta.indexOf('INSERT INTO slot_holds'),
  'oferta da lista de espera deixou de revalidar a grade vigente antes do hold',
);

// Undo de no-show reativa recurso: também precisa disputar mudança do pool/requisito.
exigir(
  dayboard.includes('await travarConfiguracaoDeRecursos(tx);')
    && dayboard.indexOf('await travarConfiguracaoDeRecursos(tx);') < dayboard.indexOf('recursosAindaCabemAoDesfazerFalta(tx'),
  'undo_no_show deixou de serializar a configuração de recursos antes da revalidação',
);

// Platform × Financeiro: eventos/compensações precisam continuar atômicos/fenced.
exigir(
  conciliacao.includes('INSERT INTO psp_events')
    && conciliacao.includes('pagarFaturaNaTransacao(tx')
    && conciliacao.includes('encerrarEventoNaTransacao(tx')
    && conciliacao.includes("UPDATE refunds SET status = 'failed'\n           WHERE id = ${lancamento.id}::uuid AND status = 'pending'"),
  'regressão cross-domain entre PSP, fatura ou compensação de estorno',
);
exigir(
  migracao0115.includes('FOREIGN KEY (tenant_id, endpoint_id)')
    && migracao0115.includes("outcome IN ('paid', 'failed', 'ignored')"),
  'migração 0115 perdeu invariantes cross-tenant/estado usadas por Platform',
);

// A sequência canônica precisa permanecer única e terminar no mesmo head auditado.
const migracoes = fs.readdirSync('packages/db/migrations')
  .filter((nome) => /^\d{4}_.+\.sql$/.test(nome))
  .sort();
const versoes = migracoes.map((nome) => nome.slice(0, 4));
exigir(new Set(versoes).size === versoes.length, 'existem versões duplicadas de migração SQL');
exigir(versoes.at(-1) === '0116', 'head de migração mudou sem passar pela auditoria final/recheck');
for (const v of ['0110', '0111', '0112', '0113', '0114', '0115', '0116']) {
  exigir(versoes.includes(v), `migração cumulativa ${v} desapareceu`);
}

// O portão final precisa fazer parte do verify principal.
exigir(
  verify.includes('auditoria Final Cross-Domain')
    && verify.includes('node scripts/verificar-auditoria-final-cross-domain.mjs')
    && verify.includes('node --test scripts/verificar-auditoria-final-cross-domain.test.mjs'),
  'verify.sh não executa a auditoria final cross-domain e sua prova negativa',
);

if (falhas.length) {
  console.error(`Auditoria Final Cross-Domain: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}
console.log('Auditoria Final Cross-Domain: Agenda, Catálogo, Financeiro, CRM e Platform preservam as invariantes cumulativas');
