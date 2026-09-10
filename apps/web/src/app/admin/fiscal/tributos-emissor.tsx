'use client';

import { useState } from 'react';
import type { SituacaoNfseNaTela } from '@/lib/admin-api';

export function TributosEmissor({ regime, config }: {
  readonly regime: string | undefined; readonly config: SituacaoNfseNaTela['configuracao'];
}) {
  const [apuracao, setApuracao] = useState(config?.federaisForaDas ? '2' : config?.issForaDas ? '1' : '0');
  const fora = apuracao !== '0';
  return <>
    {regime === 'simples' ? <div className="ui-field">
      <label className="ui-field__label" htmlFor="nfse-apuracao">Como sua empresa apura os tributos?</label>
      <select className="ui-field__input" id="nfse-apuracao" name="apuracaoSimples" value={apuracao} onChange={e => setApuracao(e.target.value)}>
        <option value="0">Tributos federais e ISS no DAS</option>
        <option value="1">Só o ISS fora do DAS</option>
        <option value="2">Tributos federais e ISS fora do DAS</option>
      </select>
      <p className="ui-field__hint">Confirme o enquadramento com o contador. As opções fora do DAS seguem as legislações dos respectivos tributos. Este emissor atende serviços sem retenção.</p>
    </div> : null}
    {regime === 'simples' && !fora ? <div className="ui-field">
      <label className="ui-field__label" htmlFor="nfse-simples">Tributos totais do Simples (%)</label>
      <input className="ui-field__input" id="nfse-simples" name="aliquotaTotalSimples" inputMode="decimal"
        defaultValue={config?.aliquotaTotalSimplesBps != null ? (config.aliquotaTotalSimplesBps / 100).toFixed(2).replace('.', ',') : ''} required />
      <p className="ui-field__hint">Use o percentual informado pelo contador. Este perfil recolhe ISS pelo DAS, sem retenção.</p>
    </div> : null}
    {regime === 'normal' || (regime === 'simples' && fora) ? <fieldset className="formulario">
      <legend>Tributos aproximados (%)</legend>
      <p className="ui-field__hint">Informe os percentuais da Lei 12.741 com seu contador. São informações da nota, não valores a recolher.
        Este perfil atende serviços sem retenção em município habilitado no emissor nacional.</p>
      {(['federal', 'estadual', 'municipal'] as const).map(tipo => <div className="ui-field" key={tipo}>
        <label className="ui-field__label" htmlFor={`nfse-tributos-${tipo}`}>
          {tipo === 'federal' ? 'Federais' : tipo === 'estadual' ? 'Estaduais' : 'Municipais'} (%)</label>
        <input className="ui-field__input" id={`nfse-tributos-${tipo}`} name={`tributos-${tipo}`} inputMode="decimal"
          defaultValue={config?.tributosAproximadosBps?.[tipo] != null ? (config.tributosAproximadosBps[tipo] / 100).toFixed(2).replace('.', ',') : ''} required />
      </div>)}
    </fieldset> : null}
  </>;
}
