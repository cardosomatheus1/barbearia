'use server';

import { redirect } from 'next/navigation';
import { salvarMunicipalNaApi } from '@/lib/admin-api/fiscal-municipal';
import { exigirSessao, falhar, texto } from './comum';

export async function acaoSalvarMunicipal(form: FormData): Promise<void> {
  const token = await exigirSessao();
  const ambiente = texto(form, 'ambiente');
  const layout = texto(form, 'layoutSaoPaulo');
  if (!['producao', 'homologacao'].includes(ambiente) || layout !== '1' || texto(form, 'serieExclusiva') !== '1') return falhar('/admin/fiscal', 'invalid_request');
  const r = await salvarMunicipalNaApi(token, {
    config: {
      ambiente: ambiente as 'homologacao' | 'producao', serie: texto(form, 'serie'), numeroInicial: Number(texto(form, 'numeroInicial')), serieExclusiva: true,
      itemListaServico: texto(form, 'itemListaServico'), codigoMunicipal: texto(form, 'codigoMunicipal'),
      codigoCancelamento: texto(form, 'codigoCancelamento'), cnae: texto(form, 'cnae') || null,
      nbs: texto(form, 'nbs') || null, razaoSocial: texto(form, 'razaoSocial'),
      layoutSaoPaulo: 1, habilitada: texto(form, 'habilitada') === '1',
      enderecoPrestador: { logradouro: texto(form, 'logradouro'), numero: texto(form, 'numero'),
        bairro: texto(form, 'bairro'), cep: texto(form, 'cep').replace(/\D/g, ''),
        municipio: Number(texto(form, 'municipio')), nomeMunicipio: texto(form, 'nomeMunicipio'),
        uf: texto(form, 'uf'), complemento: texto(form, 'complemento') || null },
    },
    ...(texto(form, 'alterarCredenciais') === '1' ? { credenciais: { usuario: texto(form, 'usuario') || null,
      senha: texto(form, 'senha') || null, token: texto(form, 'tokenMunicipal') || null } } : {}),
  });
  if (!r.ok) return falhar('/admin/fiscal?emissor=municipal', r);
  redirect('/admin/fiscal?emissor=municipal&feito=municipal-salvo');
}
