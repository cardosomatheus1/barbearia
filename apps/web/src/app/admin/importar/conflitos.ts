export type EscolhaDoConflito = 'anterior' | 'linha';

export function escolhaValida(valor: string): valor is EscolhaDoConflito {
  return valor === 'anterior' || valor === 'linha';
}

export function mascararTelefone(telefone: string): string {
  const digitos = telefone.replace(/\D/g, '');
  if (digitos.length < 4) return '••••';
  return `•••• ${digitos.slice(-4)}`;
}

export interface ConflitoVisivel {
  readonly linha: number;
  readonly nomeAnterior: string;
  readonly nomeDaLinha: string;
  readonly telefoneMascarado: string;
}
