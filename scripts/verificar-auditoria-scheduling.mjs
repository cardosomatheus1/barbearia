import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ler = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const falhas = [];
const exigir = (cond, msg) => { if (!cond) falhas.push(msg); };

const booking = ler('packages/scheduling/src/booking.ts');
const idempotencia = ler('packages/scheduling/src/booking-idempotencia.ts');
const repository = ler('packages/scheduling/src/repository.ts');
const service = ler('packages/scheduling/src/service.ts');
const espera = ler('packages/scheduling/src/espera.ts');
const oferta = ler('packages/scheduling/src/oferta.ts');
const fila = ler('packages/scheduling/src/fila.ts');
const agenda = ler('packages/scheduling/src/agenda.ts');
const dayboard = ler('packages/scheduling/src/dayboard.ts');
const concorrencia = ler('packages/scheduling/src/concorrencia.ts');
const migracao = ler('packages/db/migrations/0110_scheduling_concorrencia_recursos.sql');
const contratos = ler('packages/scheduling/src/booking-contratos.ts');
const schemaPublico = ler('apps/api/src/auth/auth.schemas.ts');
const appointmentsController = ler('apps/api/src/booking/appointments.controller.ts');
const prismaSchema = ler('packages/db/prisma/schema.prisma');

exigir(concorrencia.includes('pg_advisory_xact_lock') && concorrencia.includes('barberdock:agenda:'),
  'agenda não possui lock transacional por unidade+dia');
exigir((booking.match(/travarDiaDaAgenda\(/g) ?? []).length >= 3,
  'criação/hold/remarcação não estão todas serializadas pelo dia');
exigir(agenda.includes('travarDiaDaAgenda(tx, params.locationId, params.date)'),
  'exceção de agenda não disputa a mesma trava de capacidade');
exigir(fila.includes('travarDiaDaAgenda(tx, entrada.location_id, dataLocal)'),
  'walk-in não disputa a trava diária');
exigir(oferta.includes('travarDiaDaAgenda(tx, params.locationId, diaDaVaga)'),
  'oferta de vaga não disputa a trava diária');

exigir(booking.includes('idempotency_fingerprint') && booking.includes('bookingIntentFingerprint')
        && idempotencia.includes('fingerprintDaIntencao'),
  'agendamento não congela fingerprint da intenção idempotente');
exigir(idempotencia.includes("'idempotencia_conflitante'")
        && idempotencia.includes('row.idempotency_fingerprint ?? fingerprintDaIntencao'),
  'reuso de Idempotency-Key com outra intenção não vira conflito explícito');
exigir(contratos.includes("| 'idempotencia_conflitante'"),
  'contrato de falhas não expõe conflito de idempotência');

exigir(migracao.includes('CREATE TABLE slot_hold_resources') && migracao.includes('FORCE ROW LEVEL SECURITY'),
  'holds não persistem recursos com RLS');
exigir(prismaSchema.includes('idempotency_fingerprint String?') && prismaSchema.includes('model slot_hold_resources'),
  'schema Prisma não acompanha a migração 0110');
exigir(booking.includes('INSERT INTO slot_hold_resources'),
  'hold comum não congela os recursos necessários');
exigir(repository.includes('FROM slot_hold_resources') && repository.includes('generate_series(1, shr.quantity)'),
  'disponibilidade não conta recursos dos holds ou quantity corretamente');
exigir(repository.includes('generate_series(1, ar.quantity)'),
  'quantity de appointment_resources continua sendo tratado como uma linha');
exigir(fila.includes('INSERT INTO appointment_resources'),
  'walk-in cria atendimento sem congelar os recursos consumidos');
exigir(oferta.includes('INSERT INTO slot_hold_resources'),
  'oferta exclusiva segura profissional mas não recurso compartilhado');

exigir(repository.includes('(${params.atCounter === true} OR bookable_online)') &&
        repository.includes('(${params.atCounter === true} OR p.bookable_online)'),
  'bookable_online ainda bloqueia o balcão ou não protege o público');
exigir(service.includes('...(request.atCounter ? { atCounter: true } : {})'),
  'faixa de disponibilidade perde o contexto atCounter');
exigir(espera.includes('AND bookable_online') && espera.includes("kind IN ('professional', 'external')"),
  'lista de espera pública aceita catálogo/profissional só de balcão');

exigir(espera.includes('barberdock:espera:') && espera.includes('pg_advisory_xact_lock'),
  'limite de esperas do cliente continua sujeito a corrida');
exigir(fila.includes('slot_holds') && fila.includes('daily_limit'),
  'walk-in não conta holds no limite diário');
exigir(oferta.includes('profissionalTemCotaNoDia') && oferta.includes('profissionalAindaLivre'),
  'oferta de vaga não revalida profissional/cota depois do cancelamento');
exigir(dayboard.includes("params.action === 'undo_no_show'")
        && dayboard.includes('travarDiaDaAgenda(tx, params.locationId')
        && dayboard.includes('recursosAindaCabemAoDesfazerFalta')
        && dayboard.includes('slot_hold_resources'),
  'desfazer falta pode reativar capacidade/recurso sem revalidação');


exigir(!/createAppointmentSchema[\s\S]{0,900}holdId/.test(schemaPublico) && !appointmentsController.includes('body.holdId'),
  'API pública ainda aceita holdId arbitrário');
exigir(booking.includes("'hold_invalido'") && booking.includes('FOR UPDATE OF h')
        && booking.includes('A reserva temporária não pertence a este horário')
        && booking.includes('JSON.stringify(recursosDoHold)'),
  'domínio não valida posse/janela/recursos antes de consumir hold');

exigir(booking.includes('FOR UPDATE OF a') && booking.includes('encerrados !== 1'),
  'remarcação não serializa a linha antiga ou não confirma a transição');
exigir(booking.includes('...(!request.customerId ? { atCounter: true } : {})'),
  'remarcação administrativa não respeita itens configurados como só balcão');

if (falhas.length) {
  console.error(`Auditoria Scheduling: ${falhas.length} falha(s)`);
  for (const f of falhas) console.error(`- ${f}`);
  process.exit(1);
}
console.log('Auditoria Scheduling: invariantes de concorrência, recursos e canal preservados');
