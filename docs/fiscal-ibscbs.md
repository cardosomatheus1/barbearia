# IBS/CBS no emissor nacional

O cadastro do emissor permite escolher o perfil `regular_presencial` para não
optante pelo Simples: serviço de barbearia prestado na própria unidade à pessoa
física identificada como tomador. A seleção não é automática. O emitente deve
confirmar o enquadramento com seu contador.

O perfil exige serviço nacional `060101`, NBS `126021000` e CPF válido do cliente.
A DPS declara finalidade regular, consumo pessoal, indicador de operação `030101`,
destinatário igual ao tomador, CST `000` e classificação `000001`. A competência
deve ser a partir de janeiro de 2026. O snapshot cifra e congela o perfil, o
serviço, o destinatário e os demais dados usados na emissão.

O software não fornece alíquotas arbitrárias de IBS/CBS. Elas vêm do cálculo da
autoridade. Na resposta assinada, confere a presença do grupo, local de incidência,
base, alíquotas efetivas, parcelas e total, incluindo a diferença entre a fórmula
de 2026 e a partir de 2027. Essa conferência não substitui a parametrização fiscal
da autoridade ou a homologação externa.

Sem nome/CPF, o pagamento da comanda é preservado e a emissão automática não cria
uma nota incompleta. Ao solicitar a nota, a recepção recebe orientação para
corrigir o cadastro; a tentativa recusada não consome numeração de DPS.

O modelo não estende esse perfil a Simples/MEI, governo, destinatário diferente do
tomador, atendimento domiciliar, benefícios, retenções ou salão-parceiro. Essas
operações precisam de perfis próprios. O perfil normal não pode ser habilitado
sem a configuração de IBS/CBS. Snapshots anteriores sem esse grupo são preservados
para consulta e conciliação, sem reescrever documentos históricos.

## Referências conferidas em 10/09/2026

- [Documentação de produção](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual):
  XSD 1.01 de 09/02/2026 ainda vinculado nessa página; o validador atual usa
  a atualização de 27/07/2026 do ambiente restrito, documentada no README do bundle.
- [Anexo I de produção](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_i-sefin_adn-dps_nfse-snnfse-v1-01-20260209.xlsx):
  E0850/E0854 (competência/versão), E0958/E0959 (classificação), E1515/E1517
  (grupo na resposta), E1555 (total), E1568/E1572 (parcelas e margem de R$ 0,01).
- [Anexo VIII RTC v1.01.00](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/anexoviii-correlacaoitemnbsindopcclasstrib_ibscbs_v1-01-00.xlsx):
  correlação do item 06.01 com NBS, indicador de operação e classificação.
- [NT 009](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/nt-009-se-cgnfse-v1-0-1.pdf):
  anuncia evoluções adicionais e cronograma separado. A publicação dessa nota não
  foi tomada como prova de implantação de todos os campos no ambiente de produção.
- [Atualizações e implantações](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/atualizacoes-e-implantacoes):
  confirma correções das alíquotas efetivas em 01/07/2026; em 10/08/2026 anuncia
  CNPJ alfanumérico e IBS/CBS no emissor web. A compatibilidade dos demais perfis
  e contratos deve ser acompanhada separadamente.

Testes locais usam autoridade e contribuintes sintéticos. Não houve transmissão
para a SEFIN nem uso de dados fiscais reais.
