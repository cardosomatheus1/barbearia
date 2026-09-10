import type { SituacaoNfseNaTela } from '@/lib/admin-api';
import { acaoSalvarCertificadoNfse, acaoSalvarNfse, acaoRemoverCertificadoNfse } from '../acoes';

export function EmissorNacional({ situacao, regime }: { readonly situacao: SituacaoNfseNaTela; readonly regime: string | undefined }) {
  const c = situacao.configuracao;
  const certificado = situacao.certificado;
  return <section className="cartao-balcao">
    <h2 className="cartao-balcao__titulo">Emissor nacional</h2>
    <p className="painel__nota" role="status">
      {c?.ambiente === 'producao' ? 'Produção: emissão de notas com valor fiscal.' : 'Homologação: notas de teste, sem valor fiscal.'}
      {' '}{situacao.motivo ?? 'Configuração local pronta. O município e os dados da nota são conferidos no envio.'}
    </p>
    <details className="dobra" open={!c}>
      <summary className="dobra__titulo">Configurar emissão</summary>
      <form action={acaoSalvarNfse} className="formulario">
        <div className="campos-lado">
          <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-ambiente">Ambiente</label>
            <select className="ui-field__input" id="nfse-ambiente" name="ambiente" defaultValue={c?.ambiente ?? 'homologacao'}>
              <option value="homologacao">Homologação (testes)</option><option value="producao">Produção</option>
            </select></div>
          <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-serie">Série exclusiva deste sistema</label>
            <input className="ui-field__input" id="nfse-serie" name="serie" type="number" min={1} max={49999} defaultValue={c?.serie ?? 1} required />
            <p className="ui-field__hint">Confirme com o contador uma série ainda não utilizada. A numeração começa em 1.</p></div>
        </div>
        <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-codigo">Código nacional do serviço</label>
          <input className="ui-field__input" id="nfse-codigo" name="codigoNacional" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} defaultValue={c?.codigoNacional ?? '060101'} required />
          <p className="ui-field__hint">060101 corresponde a barbearia e serviços de beleza. Confirme o enquadramento da atividade.</p></div>
        {regime === 'simples' ? <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-simples">Tributos totais do Simples (%)</label>
          <input className="ui-field__input" id="nfse-simples" name="aliquotaTotalSimples" inputMode="decimal"
            defaultValue={c?.aliquotaTotalSimplesBps != null ? (c.aliquotaTotalSimplesBps / 100).toFixed(2).replace('.', ',') : ''} required />
          <p className="ui-field__hint">Use o percentual informado pelo contador. Este perfil recolhe ISS pelo DAS, sem retenção.</p></div> : null}
        <details className="dobra"><summary className="dobra__titulo">Complementos exigidos pelo município</summary>
          <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-municipal">Código municipal complementar</label>
            <input className="ui-field__input" id="nfse-municipal" name="codigoMunicipal" inputMode="numeric" pattern="[0-9]{3}" maxLength={3} defaultValue={c?.codigoMunicipal ?? ''} /></div>
          <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-nbs">NBS</label>
            <input className="ui-field__input" id="nfse-nbs" name="nbs" inputMode="numeric" pattern="[0-9]{9}" maxLength={9} defaultValue={c?.nbs ?? ''} /></div>
        </details>
        <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-habilitada">Emissão nesta unidade</label>
          <select className="ui-field__input" id="nfse-habilitada" name="habilitada" defaultValue={c?.habilitada ? '1' : '0'}>
            <option value="0">Desabilitada</option><option value="1">Habilitada</option>
          </select></div>
        <button className="ui-button ui-button--primary" type="submit">Salvar emissor</button>
      </form>
    </details>
    <details className="dobra" open={!certificado}>
      <summary className="dobra__titulo">{certificado ? 'Certificado A1 cadastrado' : 'Adicionar certificado A1'}</summary>
      {certificado ? <p className="painel__nota">Válido até {certificado.validoAte.slice(0, 10).split('-').reverse().join('/')}.
        {certificado.correspondeAoCnpj ? '' : ' O CNPJ do cadastro difere do certificado.'}</p> : null}
      <form action={acaoSalvarCertificadoNfse} className="formulario">
        <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-arquivo">Arquivo A1 (.pfx ou .p12)</label>
          <input className="ui-field__input" id="nfse-arquivo" name="certificado" type="file" accept=".pfx,.p12" required />
          <p className="ui-field__hint">Até 512 KB. O certificado e a senha ficam protegidos e não são exibidos depois do cadastro.</p></div>
        <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-senha">Senha do certificado</label>
          <input className="ui-field__input" id="nfse-senha" name="senhaCertificado" type="password" autoComplete="new-password" maxLength={1024} /></div>
        <button className="ui-button ui-button--secondary" type="submit">{certificado ? 'Substituir certificado' : 'Salvar certificado'}</button>
      </form>
      {certificado ? <details className="dobra"><summary className="dobra__titulo">Remover certificado</summary>
        <p className="painel__nota">A emissão e as consultas ficam paradas até cadastrar outro certificado. As notas já emitidas continuam guardadas.</p>
        <form action={acaoRemoverCertificadoNfse}><button className="ui-button ui-button--ghost" type="submit">Remover desta unidade</button></form>
      </details> : null}
    </details>
  </section>;
}
