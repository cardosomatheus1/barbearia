/**
 * Normalização de telefone para E.164.
 *
 * O telefone é a identidade do cliente neste produto: é por ele que o cliente
 * entra, recebe o código e recupera os agendamentos, e é a chave de
 * deduplicação na importação de base (SPEC Parte 5 §5.8).
 *
 * Guardar `(71) 98888-7777` e `+5571988887777` como pessoas diferentes é o
 * defeito clássico de cadastro de barbearia. Toda entrada passa por aqui.
 */

export type PhoneError =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'invalid_characters'
  | 'invalid_country'
  | 'invalid_br_area_code'
  | 'invalid_br_subscriber';

export class InvalidPhoneError extends Error {
  constructor(readonly code: PhoneError) {
    super(`Telefone inválido: ${code}`);
    this.name = 'InvalidPhoneError';
  }
}

/** DDDs válidos no Brasil. Sequência com buracos — 20, 30, 40, 50, 60, 70, 72… */
const BR_AREA_CODES = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

/**
 * Converte entrada livre em E.164.
 *
 * `defaultCountry` só é aplicado quando o número não traz prefixo internacional
 * — o cliente digitando `71 98888-7777` no site de uma barbearia brasileira.
 */
export function normalizePhone(input: string, defaultCountry = '55'): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new InvalidPhoneError('empty');

  // Aceita apenas dígitos, espaço, parênteses, hífen, ponto e o `+` inicial.
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) {
    throw new InvalidPhoneError('invalid_characters');
  }

  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (digits === '') throw new InvalidPhoneError('empty');

  if (!hadPlus) {
    // `0` de operadora e `00` de discagem internacional não fazem parte do número.
    digits = digits.replace(/^00/, '').replace(/^0+/, '');
    if (!digits.startsWith(defaultCountry)) digits = defaultCountry + digits;
  }

  if (digits.startsWith('0')) throw new InvalidPhoneError('invalid_country');
  if (digits.length < 8) throw new InvalidPhoneError('too_short');
  if (digits.length > 15) throw new InvalidPhoneError('too_long');

  if (digits.startsWith('55')) return normalizeBrazil(digits);
  return `+${digits}`;
}

/**
 * Regras específicas do Brasil.
 *
 * Celular tem nove dígitos e começa com 9. Números antigos de oito dígitos
 * ainda circulam em base importada e em cliente que digita de memória, então
 * são aceitos com o nono dígito acrescentado — em vez de recusados.
 */
function normalizeBrazil(digits: string): string {
  const national = digits.slice(2);

  if (national.length < 10) throw new InvalidPhoneError('too_short');
  if (national.length > 11) throw new InvalidPhoneError('too_long');

  const areaCode = Number(national.slice(0, 2));
  if (!BR_AREA_CODES.has(areaCode)) throw new InvalidPhoneError('invalid_br_area_code');

  let subscriber = national.slice(2);

  if (subscriber.length === 8) {
    const first = subscriber[0] ?? '';
    // 6, 7, 8 e 9 eram faixas de celular antes do nono dígito.
    if (!'6789'.includes(first)) throw new InvalidPhoneError('invalid_br_subscriber');
    subscriber = `9${subscriber}`;
  }

  if (subscriber.length !== 9 || !subscriber.startsWith('9')) {
    throw new InvalidPhoneError('invalid_br_subscriber');
  }

  return `+55${areaCode.toString().padStart(2, '0')}${subscriber}`;
}

/** Versão que não lança — para validação em formulário. */
export function tryNormalizePhone(
  input: string,
  defaultCountry = '55',
): { ok: true; phone: string } | { ok: false; code: PhoneError } {
  try {
    return { ok: true, phone: normalizePhone(input, defaultCountry) };
  } catch (error) {
    if (error instanceof InvalidPhoneError) return { ok: false, code: error.code };
    throw error;
  }
}

/**
 * Máscara para exibição em mensagem e log.
 *
 * Telefone completo é dado pessoal: `+5571988887777` vira `+5571*****7777`.
 */
export function maskPhone(phoneE164: string): string {
  if (phoneE164.length <= 8) return phoneE164;
  const head = phoneE164.slice(0, 6);
  const tail = phoneE164.slice(-4);
  return `${head}${'*'.repeat(phoneE164.length - 10)}${tail}`;
}
