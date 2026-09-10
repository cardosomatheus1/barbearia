import { verificarRespostaArquivada, type ProvaArquivada } from './prova-resposta.js';
import { registro } from './transporte.js';
import { lerXmlFiscal } from './xml-seguro.js';
import { validarSchemaNfse } from './schema.js';
import { verificarAssinaturaDaResposta } from './assinatura-resposta.js';
import { desenhoDanfse, BORDA_DANFSE, LARGURA_DANFSE } from './danfse-desenho.js';
import { fontesDanfse, type FontesDanfse } from './danfse-fontes.js';
import { campo, localidade, valorFiscal as dinheiro, somarValores, dataFiscal, documentoFiscal, rotulo, tributosAproximadosDanfse } from './danfse-campos.js';
import { NfseError } from './erros.js';

/** DANFSe próprio, conforme NT008 v1.02. Não chama a API suspensa do ADN. */
export async function gerarDanfse(xml: string, chave: string, fontes: FontesDanfse = fontesDanfse(), cancelada = false, prova?: ProvaArquivada): Promise<Buffer> {
  validarSchemaNfse(xml, 'NFSe');
  const autenticado = prova ? verificarRespostaArquivada(xml, 'NFSe', prova) : verificarAssinaturaDaResposta(xml, 'NFSe');
  const inf = registro(registro(lerXmlFiscal(autenticado))['infNFSe']);
  const dps = registro(registro(inf['DPS'])['infDPS']);
  if (campo(inf, '@_Id') !== `NFS${chave}` || campo(inf, 'cStat') !== '100') {
    throw new NfseError('nfse_pdf_documento_invalido', 'O documento fiscal não corresponde à nota autorizada.', 502);
  }
  const d = desenhoDanfse(fontes); const f = (c: string) => campo(dps, c); const n = (c: string) => campo(inf, c);
  const rtc = 'IBSCBS/valores/'; const totais = 'IBSCBS/totCIBS/';
  d.cabecalho(localidade(f('cLocEmi'), n('xLocEmi')),
    rotulo(n('ambGer'), { '1': 'Prefeitura', '2': 'Nacional' }), f('tpAmb') === '2', chave);
  d.campo('Chave de acesso da NFS-e', chave, 0, 1.48, 3, 0.77, false, true);
  [
    ['Número da NFS-e', n('nNFSe')], ['Competência da NFS-e', dataFiscal(f('dCompet'))], ['Data e hora da emissão da NFS-e', dataFiscal(n('dhProc'))],
    ['Número da DPS', f('nDPS')], ['Série da DPS', f('serie')], ['Data e hora da emissão da DPS', dataFiscal(f('dhEmi'))],
    ['Emitente da NFS-e', rotulo(f('tpEmit'), { '1': 'Prestador', '2': 'Tomador', '3': 'Intermediário' })],
    ['Situação da NFS-e', 'NFS-e autorizada'], ['Finalidade', rotulo(f('IBSCBS/finNFSe'), { '0': 'NFS-e regular' })],
  ].forEach(([titulo = '', valor = ''], i) => d.campo(titulo, valor, i % 3, 2.27 + Math.floor(i / 3) * 0.69, 1, 0.67, i === 6, true));
  d.linha(4.32);

  function pessoa(titulo: string, no: unknown, y: number, prestador = false): number {
    const p = (c: string) => campo(no, c);
    if (!Object.keys(registro(no)).length) { d.faixa(`${titulo} DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e`, y); return y + 0.42; }
    d.tituloNaLinha(titulo, y);
    d.campo('CNPJ / CPF / NIF', documentoFiscal(p('CNPJ') || p('CPF') || p('NIF')), 1, y);
    d.campo('Indicador Municipal (Inscrição)', p('IM'), 2, y); d.campo('Telefone', p('fone'), 3, y);
    const endereco = registro(no)['end'] ?? (prestador ? { ...registro(registro(inf['emit'])['enderNac']), endNac: registro(registro(inf['emit'])['enderNac']) } : {});
    const cMun = campo(endereco, 'endNac/cMun');
    d.campo('Nome / Nome Empresarial', p('xNome') || (prestador ? n('emit/xNome') : ''), 0, y + 0.65, 2);
    d.campo('Município / Sigla UF', localidade(cMun) || campo(endereco, 'endExt/xCidade'), 2, y + 0.65);
    d.campo('Código IBGE / CEP', [cMun, campo(endereco, 'endNac/CEP') || campo(endereco, 'endExt/cEndPost')].filter(Boolean).join(' / '), 3, y + 0.65);
    d.campo('Endereço', ['xLgr', 'nro', 'xCpl', 'xBairro'].map(c => campo(endereco, c)).filter(Boolean).join(', '), 0, y + 1.3, 2);
    d.campo('Email', p('email'), 2, y + 1.3, 2);
    if (prestador) {
      d.campo('Simples Nacional na Data de Competência', rotulo(f('prest/regTrib/opSimpNac'),
        { '1': 'Não optante', '2': 'Optante — MEI', '3': 'Optante — ME/EPP' }), 0, y + 1.95, 2);
      d.campo('Regime de Apuração Tributária pelo SN', rotulo(f('prest/regTrib/regApTribSN'),
        { '1': 'Tributos federais e ISSQN pelo Simples Nacional', '2': 'Tributos federais pelo SN e ISSQN fora do SN', '3': 'Tributos federais e ISSQN fora do SN' }), 2, y + 1.95, 2);
    }
    const fim = y + (prestador ? 2.6 : 1.95); d.linha(fim); return fim + 0.02;
  }
  let y = pessoa('PRESTADOR / FORNECEDOR', dps['prest'], 4.34, true);
  y = pessoa('TOMADOR / ADQUIRENTE', dps['toma'], y);
  if (f('IBSCBS/indDest') === '0') { d.faixa('O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO', y); y += 0.42; }
  else y = pessoa('DESTINATÁRIO', registro(dps['IBSCBS'])['dest'], y);
  y = pessoa('INTERMEDIÁRIO', dps['interm'], y);
  d.tituloNaLinha('SERVIÇO PRESTADO', y);
  d.campo('Código Tributação Nacional / Municipal', [f('serv/cServ/cTribNac'), f('serv/cServ/cTribMun')].filter(Boolean).join(' / '), 1, y);
  d.campo('Código da NBS', f('serv/cServ/cNBS'), 2, y);
  d.campo('Local da Prestação / Sigla UF / País', localidade(f('serv/locPrest/cLocPrestacao'), n('xLocPrestacao')) || f('serv/locPrest/cPaisPrestacao'), 3, y);
  d.texto(n('xTribMun') || n('xTribNac'), BORDA_DANFSE + 0.06, y + 0.67, LARGURA_DANFSE - 0.12, 0.38);
  // Supressão dos blocos sem atores devolve espaço à descrição (§2.3).
  const espacoDescricao = 14.43 - (y + 1.07);
  d.campo('Descrição do Serviço', f('serv/cServ/xDescServ'), 0, y + 1.07, 4, Math.max(0.65, espacoDescricao));
  y = Math.max(14.43, y + 1.72); d.linha(y);
  const mun = 'valores/trib/tribMun/'; const reg = 'prest/regTrib/';
  d.tituloNaLinha('TRIBUTAÇÃO MUNICIPAL (ISSQN)', y);
  d.campo('Tipo de Tributação do ISSQN', rotulo(f(mun + 'tribISSQN'), { '1': 'Operação tributável', '2': 'Imunidade', '3': 'Exportação', '4': 'Não incidência' }), 1, y);
  d.campo('Município / UF / País de Incidência', localidade(n('cLocIncid'), n('xLocIncid')) || f(mun + 'cPaisResult'), 2, y, 2);
  d.campo('Regime Especial de Tributação do ISSQN', rotulo(f(reg + 'regEspTrib'), { '0': 'Nenhum', '1': 'Ato cooperado', '2': 'Estimativa', '3': 'Microempresa municipal', '4': 'Notário ou registrador', '5': 'Profissional autônomo', '6': 'Sociedade de profissionais' }), 0, y + 0.65);
  d.campo('Tipo de Imunidade do ISSQN', f(mun + 'tpImunidade'), 1, y + 0.65);
  d.campo('Suspensão da Exigibilidade do ISSQN', rotulo(f(mun + 'exigSusp/tpSusp'), { '1': 'Decisão judicial', '2': 'Processo administrativo' }), 2, y + 0.65);
  d.campo('Número Processo Suspensão', f(mun + 'exigSusp/nProcesso'), 3, y + 0.65);
  d.campo('Benefício Municipal', n('valores/tpBM'), 0, y + 1.3);
  d.campo('Cálculo do BM', dinheiro(n('valores/vCalcBM') || f(mun + 'BM/vRedBCBM')), 1, y + 1.3);
  d.campo('Total Deduções / Reduções', dinheiro(somarValores(f('valores/vDedRed/vDR') || n('valores/vCalcDR'), n(rtc + 'vCalcReeRepRes'))), 2, y + 1.3);
  d.campo('Desconto Incondicionado', dinheiro(f('valores/vDescCondIncond/vDescIncond')), 3, y + 1.3);
  d.campo('BC ISSQN', dinheiro(n('valores/vBC')), 0, y + 1.95);
  d.campo('Alíquota Aplicada', dinheiro(n('valores/pAliqAplic'), true), 1, y + 1.95);
  d.campo('Retenção do ISSQN', rotulo(f(mun + 'tpRetISSQN'), { '1': 'Não retido', '2': 'Retido pelo tomador', '3': 'Retido pelo intermediário' }), 2, y + 1.95);
  d.campo('ISSQN Apurado', dinheiro(n('valores/vISSQN')), 3, y + 1.95);
  y += 2.6; d.linha(y);
  const fed = 'valores/trib/tribFed/'; const pis = fed + 'piscofins/'; const retido = f(pis + 'tpRetPisCofins') === '1';
  d.tituloNaLinha('TRIBUTAÇÃO FEDERAL (EXCETO CBS)', y);
  d.campo('IRRF', dinheiro(f(fed + 'vRetIRRF')), 1, y); d.campo('Contribuição Previdenciária — Retida', dinheiro(f(fed + 'vRetCP')), 2, y);
  d.campo('Contribuições Sociais — Retidas', dinheiro(somarValores(f(fed + 'vRetCSLL'), ...(retido ? [f(pis + 'vPis'), f(pis + 'vCofins')] : []))), 3, y);
  y += 0.65;
  if (f('dCompet') < '2027-01-01') {
    d.campo('PIS — Débito Apuração Própria', dinheiro(retido ? '0.00' : f(pis + 'vPis')), 0, y);
    d.campo('COFINS — Débito Apuração Própria', dinheiro(retido ? '0.00' : f(pis + 'vCofins')), 1, y);
    d.campo('Descrição Contribuições Sociais — Retidas', rotulo(f(pis + 'tpRetPisCofins'), { '1': 'PIS/COFINS retido', '2': 'PIS/COFINS não retido' }), 2, y, 2); y += 0.65;
  }
  d.linha(y); d.tituloNaLinha('TRIBUTAÇÃO IBS / CBS', y);
  d.campo('CST / cClassTrib', [f('IBSCBS/valores/trib/gIBSCBS/CST'), f('IBSCBS/valores/trib/gIBSCBS/cClassTrib')].filter(Boolean).join(' / '), 1, y);
  d.campo('Indicador Operação / IBGE Incidência / Município / UF', [f('IBSCBS/cIndOp'), n('IBSCBS/cLocalidadeIncid'), localidade(n('IBSCBS/cLocalidadeIncid'), n('IBSCBS/xLocalidadeIncid'))].filter(Boolean).join(' / '), 2, y, 2);
  const temRtc = Object.hasOwn(inf, 'IBSCBS');
  d.campo('Exclusões e Reduções da Base de Cálculo', dinheiro(temRtc ? somarValores(f('valores/vDescCondIncond/vDescIncond'), n(rtc + 'vCalcReeRepRes'), n('valores/vISSQN'), ...(f('dCompet') < '2027-01-01' ? [f(pis + 'vPis'), f(pis + 'vCofins')] : [])) : ''), 0, y + 0.65);
  d.campo('Base Após Exclusões e Reduções', dinheiro(n(rtc + 'vBC')), 1, y + 0.65);
  d.campo('Red. Alíquota IBS UF / Mun / CBS', [n(rtc + 'uf/pRedAliqUF'), n(rtc + 'mun/pRedAliqMun'), n(rtc + 'fed/pRedAliqCBS')].map(v => dinheiro(v, true)).join(' / '), 2, y + 0.65);
  d.campo('Alíquota — IBS UF / IBS Mun', [n(rtc + 'uf/pIBSUF'), n(rtc + 'mun/pIBSMun')].map(v => dinheiro(v, true)).join(' / '), 3, y + 0.65);
  d.campo('Alíquota Efetiva Municipal — IBS', dinheiro(n(rtc + 'mun/pAliqEfetMun'), true), 0, y + 1.3);
  d.campo('Valor Apurado Municipal — IBS', dinheiro(n(totais + 'gIBS/gIBSMunTot/vIBSMun')), 1, y + 1.3);
  d.campo('Alíquota Efetiva Estadual — IBS', dinheiro(n(rtc + 'uf/pAliqEfetUF'), true), 2, y + 1.3);
  d.campo('Valor Apurado Estadual — IBS', dinheiro(n(totais + 'gIBS/gIBSUFTot/vIBSUF')), 3, y + 1.3);
  d.campo('Valor Total Apurado — IBS', dinheiro(n(totais + 'gIBS/vIBSTot')), 0, y + 1.95);
  d.campo('Alíquota — CBS', dinheiro(n(rtc + 'fed/pCBS'), true), 1, y + 1.95);
  d.campo('Alíquota Efetiva — CBS', dinheiro(n(rtc + 'fed/pAliqEfetCBS'), true), 2, y + 1.95);
  d.campo('Valor Total Apurado — CBS', dinheiro(n(totais + 'gCBS/vCBS')), 3, y + 1.95);
  y += 2.6; d.linha(y); d.tituloNaLinha('VALOR TOTAL DA NFS-e', y);
  d.campo('Valor da Operação / Serviço', dinheiro(f('valores/vServPrest/vServ')), 1, y);
  d.campo('Desconto Incondicionado', dinheiro(f('valores/vDescCondIncond/vDescIncond')), 2, y);
  d.campo('Desconto Condicionado', dinheiro(f('valores/vDescCondIncond/vDescCond')), 3, y);
  y += 0.67;
  d.campo('Total Retenções (ISSQN / Federais)', dinheiro(n('valores/vTotalRet')), 0, y);
  d.campo('Valor Líquido da NFS-e', dinheiro(n('valores/vLiq')), 1, y);
  d.campo('Total do IBS/CBS', dinheiro(somarValores(n(totais + 'gIBS/vIBSTot'), n(totais + 'gCBS/vCBS'))), 2, y);
  d.campo('Valor Líquido da NFS-e + IBS/CBS', dinheiro(n(totais + 'vTotNF') || n('valores/vLiq')), 3, y, 1, 0.67, true);
  y += 0.69; d.faixa('INFORMAÇÕES COMPLEMENTARES', y);
  const complemento = [f('serv/infoCompl/xInfComp'), f('subst/chSubstda') ? `NFS-e Subst.: ${f('subst/chSubstda')}` : '',
    n('xOutInf') ? `Inf. A. T. Mun.: ${n('xOutInf')}` : '', tributosAproximadosDanfse(dps)].filter(Boolean).join(' | ');
  d.texto(complemento, BORDA_DANFSE + 0.06, y + 0.45, LARGURA_DANFSE - 0.12, 29.45 - y - 0.45);
  if (cancelada) d.cancelada();
  return d.terminar();
}
