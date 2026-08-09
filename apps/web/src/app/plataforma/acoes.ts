'use server';

import { redirect } from 'next/navigation';
import {
  bloquear,
  desbloquear,
  entrarNaPlataforma,
  sairDaPlataforma,
  trocarPlano,
} from '@/lib/plataforma-api';
import {
  apagarSessaoDaPlataforma,
  gravarSessaoDaPlataforma,
  lerSessaoDaPlataforma,
} from '@/lib/sessao-plataforma';

const texto = (form: FormData, campo: string): string => String(form.get(campo) ?? '').trim();

function falhar(destino: string, code: string): never {
  redirect(`${destino}?erro=${encodeURIComponent(code)}`);
}

async function exigirSessao(): Promise<string> {
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');
  return token;
}

export async function acaoEntrarNaPlataforma(form: FormData): Promise<void> {
  const resultado = await entrarNaPlataforma(texto(form, 'email'), String(form.get('senha') ?? ''));
  if (!resultado.ok) falhar('/plataforma/entrar', resultado.code);

  await gravarSessaoDaPlataforma(resultado.dados.token, resultado.dados.expiraEm);
  redirect('/plataforma');
}

export async function acaoSairDaPlataforma(): Promise<void> {
  const token = await lerSessaoDaPlataforma();
  // Revoga no servidor antes de apagar o cookie: só apagar deixaria o token
  // aceito por quem o tivesse capturado.
  if (token) await sairDaPlataforma(token);
  await apagarSessaoDaPlataforma();
  redirect('/plataforma/entrar');
}

export async function acaoTrocarPlano(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await trocarPlano(token, texto(form, 'tenantId'), texto(form, 'planoCode'));
  if (!resultado.ok) falhar('/plataforma', resultado.code);
  redirect('/plataforma?feito=plano');
}

export async function acaoBloquear(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const motivo = texto(form, 'motivo');
  // Recusado aqui, no domínio e no `CHECK` do banco. A tela é a primeira das
  // três porque é a única que consegue dizer onde está o campo vazio.
  if (motivo.length < 3) falhar('/plataforma', 'reason_required');

  const resultado = await bloquear(token, texto(form, 'tenantId'), motivo);
  if (!resultado.ok) falhar('/plataforma', resultado.code);
  redirect('/plataforma?feito=bloqueio');
}

export async function acaoDesbloquear(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await desbloquear(token, texto(form, 'tenantId'));
  if (!resultado.ok) falhar('/plataforma', resultado.code);
  redirect('/plataforma?feito=desbloqueio');
}
