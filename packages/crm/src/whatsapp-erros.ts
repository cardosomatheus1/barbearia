export type WhatsAppFailure =
  | 'nao_configurado'
  | 'token_invalido'
  | 'template_nao_encontrado'
  | 'template_nao_aprovado'
  | 'numero_invalido'
  | 'numero_indisponivel'
  | 'nome_invalido'
  | 'botao_invalido'
  | 'sem_telefone_da_casa'
  | 'sem_pagina_da_casa'
  | 'template_em_processamento';

export class WhatsAppError extends Error {
  constructor(
    readonly code: WhatsAppFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

const MENSAGEM: Readonly<Record<WhatsAppFailure, string>> = {
  nao_configurado: 'Cadastre o número do WhatsApp antes.',
  token_invalido: 'O token de acesso não confere. Copie de novo do painel da Meta.',
  template_nao_encontrado: 'Este texto não existe.',
  template_nao_aprovado: 'Só um texto aprovado pela Meta pode ser enviado.',
  numero_invalido: 'Confira o identificador do número.',
  /**
   * A mesma frase de "não deu para gravar", e é decisão.
   *
   * "Este número é de outra barbearia" confirmaria o id para quem o adivinhou —
   * o precedente do OTP, que responde igual para telefone existente e
   * inexistente.
   */
  numero_indisponivel: 'Não foi possível salvar este número. Confira o identificador.',
  nome_invalido: 'O nome do texto aceita só minúsculas, números e sublinhado.',
  botao_invalido:
    'Este botão precisa de um horário marcado, e quem recebe esta mensagem não tem um.',
  sem_telefone_da_casa:
    'O botão de ligação precisa do telefone da unidade, e ele não está cadastrado.',
  sem_pagina_da_casa:
    'O botão de agendar precisa da página pública da barbearia, e ela não está no ar.',
  template_em_processamento:
    'Este texto já está sendo enviado para a Meta ou aguarda conciliação. Tente novamente após a verificação.',
};

export function recusar(code: WhatsAppFailure): never {
  throw new WhatsAppError(code, MENSAGEM[code]);
}

