import type { SituacaoMunicipalNaTela } from '@/lib/admin-api';
import type { SituacaoNfseNaTela } from '@/lib/admin-api';
import { acaoSalvarMunicipal } from '../acoes';
import { CertificadoFiscal } from './certificado-fiscal';

export function EmissorMunicipal({ situacao, certificado }: {
  readonly situacao: SituacaoMunicipalNaTela;
  readonly certificado: SituacaoNfseNaTela['certificado'];
}) {
  const c = situacao.configuracao;
  const m = situacao.municipio;
  const e = c?.enderecoPrestador;
  const temSuporte = Boolean(m?.producao || m?.homologacao);
  return <section className="cartao-balcao">
    <h2 className="cartao-balcao__titulo">Emissor municipal{m ? ` · ${m.nome}/${m.uf}` : ''}</h2>
    <p className="painel__nota" role="status">{situacao.motivo ?? 'Configuração local pronta. A prefeitura confirma a autorização de cada nota.'}</p>
    {!temSuporte ? <p className="painel__nota">Use o portal da prefeitura para este município. Se sua empresa pode emitir pelo sistema nacional, configure a opção Emissor nacional.</p> : <>
      <p className="painel__nota">Confira o credenciamento e os códigos com seu contador. Produção emite notas com valor fiscal.</p>
      <details className="dobra" open={!c}>
        <summary className="dobra__titulo">Configurar emissão municipal</summary>
        <form action={acaoSalvarMunicipal} className="formulario">
          <input type="hidden" name="municipio" value={m?.codigo ?? ''} />
          <input type="hidden" name="nomeMunicipio" value={m?.nome ?? ''} />
          <input type="hidden" name="uf" value={m?.uf ?? ''} />
          <div className="campos-lado">
            <div className="ui-field"><label className="ui-field__label" htmlFor="municipal-ambiente">Ambiente</label>
              <select className="ui-field__input" id="municipal-ambiente" name="ambiente" defaultValue={c?.ambiente ?? (m?.homologacao ? 'homologacao' : 'producao')}>
                {m?.homologacao ? <option value="homologacao">Homologação (testes sem valor fiscal)</option> : null}
                {m?.producao ? <option value="producao">Produção (valor fiscal)</option> : null}
              </select>
              {!m?.homologacao ? <p className="ui-field__hint">Esta integração não oferece o fluxo completo de homologação. Mantenha desabilitada até conferir o credenciamento.</p> : null}
            </div>
            <Campo nome="serie" rotulo="Série exclusiva deste sistema" valor={c?.serie ?? ''} max={5} obrigatorio dica={m?.codigo === 3550308 ? "Confirme uma série reservada exclusivamente para este sistema." : "Use uma série de 1 a 99999, sem zeros à esquerda, reservada somente para este sistema."} />
          </div>
          <div className="ui-field"><label className="ui-field__label" htmlFor="municipal-numeroInicial">Primeiro número do RPS nesta série</label>
            <input className="ui-field__input" id="municipal-numeroInicial" name="numeroInicial" type="number" min={1} max={2000000000} required defaultValue={c?.numeroInicial ?? 1} />
            <p className="ui-field__hint">Depois de salvar, o número inicial desta série não pode ser alterado. As próximas notas seguem a sequência automaticamente.</p>
          </div>
          <label className="check-linha"><input type="checkbox" name="serieExclusiva" value="1" required defaultChecked={c?.serieExclusiva ?? false} /> Confirmo que esta série será usada somente neste sistema.</label>
          <Campo nome="razaoSocial" rotulo="Razão social" valor={c?.razaoSocial ?? ''} obrigatorio />
          <div className="campos-lado">
            <Campo nome="itemListaServico" rotulo="Item da lista de serviços" valor={c?.itemListaServico ?? '06.01'} max={10} obrigatorio />
            <Campo nome="codigoMunicipal" rotulo="Código do serviço na prefeitura" valor={c?.codigoMunicipal ?? ''} max={20} obrigatorio />
          </div>
          <fieldset className="formulario"><legend>Endereço fiscal da unidade</legend>
            <Campo nome="logradouro" rotulo="Logradouro" valor={e?.logradouro ?? ''} obrigatorio />
            <div className="campos-lado"><Campo nome="numero" rotulo="Número" valor={e?.numero ?? ''} obrigatorio />
              <Campo nome="complemento" rotulo="Complemento" valor={e?.complemento ?? ''} /></div>
            <div className="campos-lado"><Campo nome="bairro" rotulo="Bairro" valor={e?.bairro ?? ''} obrigatorio />
              <Campo nome="cep" rotulo="CEP" valor={e?.cep ?? ''} max={9} obrigatorio /></div>
          </fieldset>
          <details className="dobra" open={!c?.codigoCancelamento}><summary className="dobra__titulo">Códigos complementares e cancelamento</summary>
            <Campo nome="cnae" rotulo="CNAE" valor={c?.cnae ?? ''} max={7} />
            <Campo nome="nbs" rotulo="NBS" valor={c?.nbs ?? ''} max={9} />
            <Campo nome="codigoCancelamento" rotulo="Código municipal para cancelamento" valor={c?.codigoCancelamento ?? ''} max={10} obrigatorio dica="Confirme o código aceito pela prefeitura para erro na emissão. O motivo será informado ao cancelar cada nota." />
            <input type="hidden" name="layoutSaoPaulo" value="1" />
            {m?.codigo === 3550308 ? <p className="ui-field__hint">Disponível para operações no layout 1, sem desconto. Se sua operação exige o layout 2 ou IBS/CBS, utilize o portal da prefeitura.</p> : null}
          </details>
          <details className="dobra"><summary className="dobra__titulo">Acesso à prefeitura, se exigido</summary>
            <p className="painel__nota">{situacao.temCredenciais ? 'Acesso cadastrado. Os dados atuais não são exibidos.' : 'Preencha apenas quando a prefeitura exigir acesso além do certificado A1.'}</p>
            <label className="check-linha"><input type="checkbox" name="alterarCredenciais" value="1" /> Substituir os dados de acesso ao salvar</label>
            <Campo nome="usuario" rotulo="Usuário da prefeitura" valor="" />
            <div className="ui-field"><label className="ui-field__label" htmlFor="municipal-senha">Senha da prefeitura</label>
              <input className="ui-field__input" id="municipal-senha" name="senha" type="password" autoComplete="new-password" maxLength={2000} /></div>
            <div className="ui-field"><label className="ui-field__label" htmlFor="municipal-token">Chave de acesso, se exigida</label>
              <input className="ui-field__input" id="municipal-token" name="tokenMunicipal" type="password" autoComplete="new-password" maxLength={2000} /></div>
          </details>
          <div className="ui-field"><label className="ui-field__label" htmlFor="municipal-habilitada">Emissão nesta unidade</label>
            <select className="ui-field__input" id="municipal-habilitada" name="habilitada" defaultValue={c?.habilitada ? '1' : '0'}>
              <option value="0">Desabilitada</option><option value="1">Habilitada</option>
            </select></div>
          <button className="ui-button ui-button--primary" type="submit">Salvar emissor municipal</button>
        </form>
      </details>
      <CertificadoFiscal certificado={certificado} emissor="municipal" />
    </>}
  </section>;
}

function Campo({ nome, rotulo, valor, max = 150, obrigatorio = false, dica }: {
  readonly nome: string; readonly rotulo: string; readonly valor: string; readonly max?: number;
  readonly obrigatorio?: boolean; readonly dica?: string;
}) {
  return <div className="ui-field"><label className="ui-field__label" htmlFor={`municipal-${nome}`}>{rotulo}</label>
    <input className="ui-field__input" id={`municipal-${nome}`} name={nome} defaultValue={valor} maxLength={max} required={obrigatorio} />
    {dica ? <p className="ui-field__hint">{dica}</p> : null}</div>;
}
