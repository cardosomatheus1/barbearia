import { TributosEmissor } from './tributos-emissor';
import type { SituacaoNfseNaTela } from '@/lib/admin-api';
import { PERFIL_IBSCBS_BARBEARIA } from '@barbearia/core';
import { acaoSalvarNfse } from '../acoes';
import { CertificadoFiscal } from './certificado-fiscal';

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
        <TributosEmissor key={regime} regime={regime} config={c} />
        {regime === 'normal' ? <fieldset className="formulario">
          <legend>IBS e CBS</legend>
          <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-ibscbs">Perfil da operação</label>
            <select className="ui-field__input" id="nfse-ibscbs" name="perfilIbsCbs" defaultValue={c?.perfilIbsCbs ?? ''} required>
              <option value="">Selecione com seu contador</option>
              <option value={PERFIL_IBSCBS_BARBEARIA}>Tributação integral — atendimento presencial na unidade</option>
            </select>
            <p className="ui-field__hint">Para serviço de barbearia prestado à própria pessoa física identificada na nota.
              Cadastre o CPF do cliente antes de emitir. Serviço 060101, NBS 126021000.</p>
          </div>
          <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-nbs">NBS do serviço</label>
            <input className="ui-field__input" id="nfse-nbs" name="nbs" inputMode="numeric" pattern="[0-9]{9}" maxLength={9} defaultValue={c?.nbs ?? ''} required /></div>
          <p className="ui-field__hint">Outros perfis de IBS/CBS ainda não estão disponíveis nesta versão. Para essas operações, use o portal fiscal indicado pelo contador. Os valores de IBS e CBS deste perfil são calculados pelo emissor nacional.</p>
        </fieldset> : null}
        <details className="dobra"><summary className="dobra__titulo">Complementos exigidos pelo município</summary>
          <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-municipal">Código municipal complementar</label>
            <input className="ui-field__input" id="nfse-municipal" name="codigoMunicipal" inputMode="numeric" pattern="[0-9]{3}" maxLength={3} defaultValue={c?.codigoMunicipal ?? ''} /></div>
          {regime !== 'normal' ? <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-nbs-opcional">NBS</label>
            <input className="ui-field__input" id="nfse-nbs-opcional" name="nbs" inputMode="numeric" pattern="[0-9]{9}" maxLength={9} defaultValue={c?.nbs ?? ''} /></div> : null}
        </details>
        <div className="ui-field"><label className="ui-field__label" htmlFor="nfse-habilitada">Emissão nesta unidade</label>
          <select className="ui-field__input" id="nfse-habilitada" name="habilitada" defaultValue={c?.habilitada ? '1' : '0'}>
            <option value="0">Desabilitada</option><option value="1">Habilitada</option>
          </select></div>
        <button className="ui-button ui-button--primary" type="submit">Salvar emissor</button>
      </form>
    </details>
    <CertificadoFiscal certificado={certificado} />
  </section>;
}
