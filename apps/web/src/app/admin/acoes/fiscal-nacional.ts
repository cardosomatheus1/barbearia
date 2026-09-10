'use server';

import { redirect } from 'next/navigation';
import { certificadoNfseNaApi, removerCertificadoNfseNaApi, salvarNfseNaApi } from '@/lib/admin-api/fiscal-nacional';
import { exigirSessao, falhar, texto } from './comum';
import { tributosAproximadosValidos, PERFIL_IBSCBS_BARBEARIA } from '@barbearia/core';

const ROTA = '/admin/fiscal';
export async function acaoSalvarNfse(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const ambiente = texto(form, 'ambiente');
  if (ambiente !== 'producao' && ambiente !== 'homologacao') return falhar(ROTA, 'invalid_request');
  const percentual = texto(form, 'aliquotaTotalSimples');
  const perfil = texto(form, 'perfilIbsCbs');
  const apuracao = texto(form, 'apuracaoSimples');
  if (apuracao && !['0', '1', '2'].includes(apuracao)) return falhar(ROTA, 'invalid_request');
  if (perfil && perfil !== PERFIL_IBSCBS_BARBEARIA) return falhar(ROTA, 'invalid_request');
  if (percentual && !/^\d{1,2}(?:[.,]\d{1,2})?$/.test(percentual)) return falhar(ROTA, 'invalid_request');
  const valores = ['federal', 'estadual', 'municipal'].map(tipo => texto(form, `tributos-${tipo}`));
  let tributos = null;
  if (valores.some(v => v !== '')) {
    if (!valores.every(v => /^\d{1,3}(?:[.,]\d{1,2})?$/.test(v))) return falhar(ROTA, 'invalid_request');
    const [federal, estadual, municipal] = valores.map(v => Math.round(Number(v.replace(',', '.')) * 100));
    const dados = { federal, estadual, municipal };
    if (!tributosAproximadosValidos(dados)) return falhar(ROTA, 'invalid_request');
    tributos = dados;
  }
  const r = await salvarNfseNaApi(token, { ambiente, serie: Number(texto(form, 'serie')),
    codigoNacional: texto(form, 'codigoNacional'), codigoMunicipal: texto(form, 'codigoMunicipal') || null,
    nbs: texto(form, 'nbs') || null, aliquotaTotalSimplesBps: percentual ? Math.round(Number(percentual.replace(',', '.')) * 100) : null,
    tributosAproximadosBps: tributos, issForaDas: apuracao === '1' || apuracao === '2', federaisForaDas: apuracao === '2',
    perfilIbsCbs: perfil === PERFIL_IBSCBS_BARBEARIA ? perfil : null,
    habilitada: texto(form, 'habilitada') === '1' });
  if (!r.ok) return falhar(ROTA, r);
  redirect(`${ROTA}?feito=nfse-configurada`);
}
export async function acaoSalvarCertificadoNfse(form: FormData): Promise<void> {
  const rota = texto(form, 'emissor') === 'municipal' ? `${ROTA}?emissor=municipal` : ROTA;
  const separador = rota.includes('?') ? '&' : '?';
  const token = await exigirSessao();
  const arquivo = form.get('certificado');
  if (!(arquivo instanceof File) || arquivo.size < 1 || arquivo.size > 512 * 1024) return falhar(rota, 'nfse_certificado_tamanho');
  const senha = form.get('senhaCertificado');
  if (typeof senha !== 'string') return falhar(rota, 'invalid_request');
  const bytes = Buffer.from(await arquivo.arrayBuffer());
  const r = await certificadoNfseNaApi(token, bytes.toString('base64'), senha);
  bytes.fill(0);
  if (!r.ok) return falhar(rota, r);
  redirect(`${rota}${separador}feito=certificado-salvo`);
}
export async function acaoRemoverCertificadoNfse(form: FormData): Promise<void> {
  const rota = texto(form, 'emissor') === 'municipal' ? `${ROTA}?emissor=municipal` : ROTA;
  const separador = rota.includes('?') ? '&' : '?';
  const token = await exigirSessao(); const r = await removerCertificadoNfseNaApi(token);
  if (!r.ok) return falhar(rota, r);
  redirect(`${rota}${separador}feito=certificado-removido`);
}
