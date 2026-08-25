import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raiz = join(import.meta.dirname, '..');
const ler = (p) => readFileSync(join(raiz, p), 'utf8');
const exigir = (condicao, mensagem) => {
  if (!condicao) throw new Error(mensagem);
};
const linhas = (texto) => texto.split('\n').length;

const fachada = ler('packages/scheduling/src/booking.ts');
const leitura = ler('packages/scheduling/src/booking-leitura.ts');
const contratos = ler('packages/scheduling/src/booking-contratos.ts');
const idempotencia = ler('packages/scheduling/src/booking-idempotencia.ts');

// O hotspot original tinha 1.731 linhas e concentrava contrato público,
// interpretação de SQLSTATE, consultas do cliente e mutações concorrentes.
// A fachada continua dona das transações de criação/cancelamento/remarcação,
// mas leitura e contratos não devem voltar a crescer dentro dela.
exigir(linhas(fachada) <= 1300, `booking.ts voltou a crescer demais: ${linhas(fachada)} linhas`);
exigir(linhas(leitura) <= 400, `booking-leitura.ts cresceu além do domínio de consulta: ${linhas(leitura)} linhas`);
exigir(linhas(contratos) <= 190, `booking-contratos.ts cresceu além do contrato: ${linhas(contratos)} linhas`);
exigir(linhas(idempotencia) <= 180, `booking-idempotencia.ts cresceu além do domínio: ${linhas(idempotencia)} linhas`);

for (const [nome, fonte] of [
  ['booking-leitura.ts', leitura],
  ['booking-contratos.ts', contratos],
  ['booking-idempotencia.ts', idempotencia],
]) {
  exigir(!fonte.includes("from './booking.js'"), `${nome} criou dependência circular com a fachada`);
}

for (const nome of [
  'listCustomerAppointments',
  'getAppointmentReceipt',
  'getReschedulableAppointment',
  'bookingPolicy',
  'confirmAppointment',
]) {
  exigir(!new RegExp(`export\\s+(?:async\\s+function|interface|type)\\s+${nome}\\b`).test(fachada), `${nome} voltou para booking.ts`);
  exigir(new RegExp(`export\\s+(?:async\\s+function|interface|type)\\s+${nome}\\b`).test(leitura), `${nome} saiu do módulo de leitura`);
}

for (const nome of ['BookingError', 'BookingRecusadoPorScore', 'pgCode', 'contencaoDeHorario']) {
  exigir(contratos.includes(`export ${nome.startsWith('Booking') ? 'class ' : 'function '}${nome}`), `${nome} saiu do módulo de contratos`);
}

for (const nome of ['AppointmentRef', 'AppointmentSource', 'BookingFailure', 'CreateAppointmentRequest']) {
  exigir(new RegExp(`export\\s+(?:interface|type)\\s+${nome}\\b`).test(contratos), `${nome} saiu do módulo de contratos`);
}

// As travas de concorrência e privacidade mais fáceis de perder numa refatoração
// continuam explícitas no ponto em que são aplicadas.
exigir(fachada.includes("throw new BookingError(\n          'slot_taken'"), 'contencao de horario deixou de virar slot_taken');
exigir(fachada.includes('customer_id = ${params.customerId}::uuid') || leitura.includes('customer_id = ${params.customerId}::uuid'), 'leitura do cliente perdeu filtro de customer_id');
exigir(contratos.includes("const EXCLUSION_VIOLATION = '23P01'"), 'SQLSTATE de exclusion violation deixou de ser reconhecido');
exigir(contratos.includes("const DEADLOCK = '40P01'"), 'SQLSTATE de deadlock deixou de ser reconhecido');
exigir(contratos.includes("const SERIALIZATION_FAILURE = '40001'"), 'SQLSTATE de serializacao deixou de ser reconhecido');

console.log(
  `scheduling/booking modular: fachada ${linhas(fachada)}; leitura ${linhas(leitura)}; contratos ${linhas(contratos)}; idempotencia ${linhas(idempotencia)} linhas`,
);
