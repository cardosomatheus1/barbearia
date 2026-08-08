'use server';

import { redirect } from 'next/navigation';
import {
  criarConta,
  entrarComoGestor,
  publicarBarbearia,
  sairDoGestor,
  salvarEmpresa,
  salvarJanela,
  salvarPagamentos,
  salvarProfissionais,
  salvarServicos,
} from '@/lib/admin-api';
import { apagarSessaoGestor, gravarSessaoGestor, lerSessaoGestor } from '@/lib/sessao-gestor';


/**
 * Ações do painel.
 *
 * Cada etapa do onboarding grava sozinha e volta para a etapa seguinte. Nenhum
 * "salvar tudo no fim": quem cadastra barbearia faz isso no celular, entre um
 * cliente e outro, e abandonar no passo 4 não pode custar os passos 1 a 3.
 */

const texto = (form: FormData, campo: string): string => String(form.get(campo) ?? '').trim();
const numero = (form: FormData, campo: string, padrao: number): number => {
  const valor = Number(form.get(campo));
  return Number.isFinite(valor) ? valor : padrao;
};

function falhar(rota: string, code: string): never {
  redirect(`${rota}?erro=${encodeURIComponent(code)}`);
}

async function exigirSessao(): Promise<string> {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');
  return token;
}

export async function acaoCriarConta(form: FormData): Promise<void> {
  const resultado = await criarConta({
    name: texto(form, 'name'),
    email: texto(form, 'email'),
    password: String(form.get('password') ?? ''),
    phone: texto(form, 'phone'),
    businessName: texto(form, 'businessName'),
  });

  if (!resultado.ok) falhar('/admin/criar-conta', resultado.code);

  // Sem sessão automática: a API responde igual para e-mail novo e já
  // cadastrado, e entregar sessão só num dos casos desfaria isso na tela.
  redirect('/admin/entrar?criada=1');
}

export async function acaoEntrar(form: FormData): Promise<void> {
  const resultado = await entrarComoGestor(texto(form, 'email'), String(form.get('password') ?? ''));
  if (!resultado.ok) falhar('/admin/entrar', resultado.code);

  await gravarSessaoGestor(resultado.dados.token, resultado.dados.expiresAt);
  redirect('/admin/onboarding');
}

export async function acaoSair(): Promise<void> {
  const token = await lerSessaoGestor();
  // Revoga no servidor antes de apagar o cookie: só apagar deixaria o token
  // aceito por quem o tivesse capturado.
  if (token) await sairDoGestor(token);
  await apagarSessaoGestor();
  redirect('/admin/entrar');
}

// -- Etapa 2 -----------------------------------------------------------------

export async function acaoEmpresa(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const resultado = await salvarEmpresa(token, {
    name: texto(form, 'name'),
    ...(texto(form, 'street') ? { street: texto(form, 'street') } : {}),
    ...(texto(form, 'district') ? { district: texto(form, 'district') } : {}),
    ...(texto(form, 'city') ? { city: texto(form, 'city') } : {}),
    ...(texto(form, 'state') ? { state: texto(form, 'state').toUpperCase() } : {}),
    ...(texto(form, 'instagram') ? { instagram: texto(form, 'instagram') } : {}),
    ...(texto(form, 'about') ? { about: texto(form, 'about') } : {}),
    // O fuso vem da unidade, nunca do aparelho de quem visita — é aqui, e só
    // aqui, que ele é escolhido.
    ...(texto(form, 'timezone') ? { timezone: texto(form, 'timezone') } : {}),
    amenities: form.getAll('amenities').map(String),
  });

  if (!resultado.ok) falhar('/admin/onboarding?e=2', resultado.code);
  redirect('/admin/onboarding?e=3');
}

// -- Etapa 3 -----------------------------------------------------------------

/**
 * Grava o cardápio a partir do que o dono marcou e editou.
 *
 * O formulário manda todos os templates; os desmarcados são descartados aqui.
 * A duração vai como o dono deixou — e se ele encurtar um combo abaixo da soma
 * das partes, a API recusa e devolve **qual** combo está errado. É o defeito D4
 * barrado na origem, e não descoberto com o barbeiro atrasado.
 */
export async function acaoServicos(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const marcados = new Set(form.getAll('escolhidos').map(String));
  const chaves = form.getAll('chave').map(String);

  const services = chaves
    .filter((chave) => marcados.has(chave))
    .map((chave) => {
      const componentes = texto(form, `componentes_${chave}`)
        .split(',')
        .filter((c) => c && marcados.has(c));

      return {
        key: chave,
        name: texto(form, `nome_${chave}`),
        description: texto(form, `descricao_${chave}`) || undefined,
        category: texto(form, `categoria_${chave}`),
        durationMinutes: numero(form, `duracao_${chave}`, 30),
        bufferAfterMinutes: numero(form, `buffer_${chave}`, 5),
        priceCents: Math.round(numero(form, `preco_${chave}`, 0) * 100),
        ...(componentes.length >= 2 ? { componentKeys: componentes } : {}),
      };
    });

  if (services.length === 0) falhar('/admin/onboarding?e=3', 'nenhum_servico');

  const resultado = await salvarServicos(token, services);
  if (!resultado.ok) {
    const busca = new URLSearchParams({ e: '3', erro: resultado.code });
    // O detalhe diz qual combo está incoerente; sem ele a tela só saberia dizer
    // "dados inválidos".
    if (Array.isArray(resultado.detail)) {
      busca.set('quais', resultado.detail.map((p) => String((p as { key: string }).key)).join(','));
    }
    redirect(`/admin/onboarding?${busca.toString()}`);
  }

  redirect('/admin/onboarding?e=4');
}

// -- Etapa 4 -----------------------------------------------------------------

export async function acaoProfissionais(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const nomes = form.getAll('profissional').map(String).filter(Boolean);
  if (nomes.length === 0) falhar('/admin/onboarding?e=4', 'nenhum_profissional');

  const dias = form.getAll('dia').map(Number);
  const abre = numero(form, 'abre', 540);
  const fecha = numero(form, 'fecha', 1080);

  if (dias.length === 0) falhar('/admin/onboarding?e=4', 'nenhum_dia');
  if (abre >= fecha) falhar('/admin/onboarding?e=4', 'jornada_invertida');

  // A jornada é a mesma para toda a equipe nesta etapa. Diferenciar por pessoa
  // é trabalho de cadastro, e o objetivo aqui é chegar ao link em dez minutos —
  // o ajuste fino fica na agenda do admin (bloco 12).
  const schedule = dias.map((weekday) => ({ weekday, startMinute: abre, endMinute: fecha }));

  const resultado = await salvarProfissionais(
    token,
    nomes.map((name) => ({ name, schedule })),
  );
  if (!resultado.ok) falhar('/admin/onboarding?e=4', resultado.code);

  redirect('/admin/onboarding?e=5');
}

// -- Etapa 5 -----------------------------------------------------------------

export async function acaoPagamentos(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const resultado = await salvarPagamentos(token, form.getAll('metodo').map(String));
  if (!resultado.ok) falhar('/admin/onboarding?e=5', resultado.code);
  redirect('/admin/onboarding?e=6');
}

// -- Etapa 6 -----------------------------------------------------------------

export async function acaoPublicar(): Promise<void> {
  const token = await exigirSessao();
  const resultado = await publicarBarbearia(token);
  if (!resultado.ok) falhar('/admin/onboarding?e=6', resultado.code);
  redirect(`/admin/onboarding?e=6&publicado=1`);
}

// -- Configuração ------------------------------------------------------------

export async function acaoJanela(form: FormData): Promise<void> {
  const token = await exigirSessao();

  const resultado = await salvarJanela(token, {
    cancelMinHours: numero(form, 'cancelMinHours', 2),
    rescheduleMinHours: numero(form, 'rescheduleMinHours', 2),
    maxReschedules: numero(form, 'maxReschedules', 2),
    ...(texto(form, 'cancellationPolicy')
      ? { cancellationPolicy: texto(form, 'cancellationPolicy') }
      : {}),
  });

  if (!resultado.ok) falhar('/admin/configuracoes', resultado.code);
  redirect('/admin/configuracoes?salvo=1');
}
