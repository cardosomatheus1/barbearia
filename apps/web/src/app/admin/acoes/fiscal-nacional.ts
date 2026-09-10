'use server';

import { redirect } from 'next/navigation';
import { certificadoNfseNaApi, removerCertificadoNfseNaApi, salvarNfseNaApi } from '@/lib/admin-api/fiscal-nacional';
import { exigirSessao, falhar, texto } from './comum';

const ROTA = '/admin/fiscal';
export async function acaoSalvarNfse(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const ambiente = texto(form, 'ambiente');
  if (ambiente !== 'producao' && ambiente !== 'homologacao') return falhar(ROTA, 'invalid_request');
  const percentual = texto(form, 'aliquotaTotalSimples');
  if (percentual && !/^\d{1,2}(?:[.,]\d{1,2})?$/.test(percentual)) return falhar(ROTA, 'invalid_request');
  const r = await salvarNfseNaApi(token, { ambiente, serie: Number(texto(form, 'serie')),
    codigoNacional: texto(form, 'codigoNacional'), codigoMunicipal: texto(form, 'codigoMunicipal') || null,
    nbs: texto(form, 'nbs') || null, aliquotaTotalSimplesBps: percentual ? Math.round(Number(percentual.replace(',', '.')) * 100) : null,
    habilitada: texto(form, 'habilitada') === '1' });
  if (!r.ok) return falhar(ROTA, r);
  redirect(`${ROTA}?feito=nfse-configurada`);
}
export async function acaoSalvarCertificadoNfse(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const arquivo = form.get('certificado');
  if (!(arquivo instanceof File) || arquivo.size < 1 || arquivo.size > 512 * 1024) return falhar(ROTA, 'nfse_certificado_tamanho');
  const senha = form.get('senhaCertificado');
  if (typeof senha !== 'string') return falhar(ROTA, 'invalid_request');
  const bytes = Buffer.from(await arquivo.arrayBuffer());
  const r = await certificadoNfseNaApi(token, bytes.toString('base64'), senha);
  bytes.fill(0);
  if (!r.ok) return falhar(ROTA, r);
  redirect(`${ROTA}?feito=certificado-salvo`);
}
export async function acaoRemoverCertificadoNfse(): Promise<void> {
  const token = await exigirSessao(); const r = await removerCertificadoNfseNaApi(token);
  if (!r.ok) return falhar(ROTA, r);
  redirect(`${ROTA}?feito=certificado-removido`);
}
