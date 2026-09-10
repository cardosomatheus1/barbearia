# Avaliação do fluxo WhatsApp como operador

Status: revisão e percursos locais v13 concluídos; repetição final interrompida a pedido para publicação. Esta avaliação distingue uso local de homologação externa.

## O que causava confusão

A conexão oficial e a alternativa por QR eram opções de um seletor, enquanto o envio manual aparecia separado como “campanhas e automações”. O formulário de credenciais Meta podia ficar aberto no primeiro acesso. O cadastro da mensagem mostrava variáveis e botões de todos os avisos ao mesmo tempo. Essa organização exigia conhecimento prévio da integração.

## Mudanças aplicadas

- A entrada compara três opções: Meta oficial e recomendada, com custos variáveis; Baileys gratuito/não oficial, com risco de bloqueio/banimento; manual sem envio automático.
- Consultar uma opção não muda a conexão da unidade. A troca exige uma ação explícita; o passo a passo Meta e a advertência sobre número dedicado/coexistência podem ser lidos antes disso.
- A Meta explica acesso à empresa, cadastro do número, verificação e retorno para conferir o estado real. Credenciais ficam em configuração avançada recolhida. O retorno do cadastro não é apresentado como prova de ativação.
- O editor mostra atalhos e botões compatíveis com o aviso escolhido, oferece prévia e elimina escolhas incompatíveis ao mudar o aviso. Não marcar botões envia uma lista vazia, sem aplicar padrões ocultos.
- Campanhas e automações identificam o envio automático e a conexão utilizada. As campanhas são uma lista enviada uma vez; as automações reagem a acontecimentos.
- O manual oferece Fila, Campanhas e Lembretes. A mensagem é cadastrada antes da escolha do público. Lembretes preparam a fila; o operador abre, envia e confirma individualmente. Entrar no manual não pausa os envios automáticos existentes, e isso é dito na tela.
- Configurações avançadas e instruções repetidas foram recolhidas ou removidas para reduzir a altura da página.

## Evidência disponível

Os três percursos locais v13 (Meta, Baileys e manual) passaram com API/web/banco reais e transportes sintéticos, incluindo erros e larguras 360/390/768/1280. A repetição final e a prova adicional de coexistência não foram concluídas antes da interrupção solicitada.

Minha avaliação: a escolha inicial e a próxima ação ficaram claras. O editor apresenta somente opções compatíveis com o aviso. Meta continua exigindo atenção no cadastro externo; Baileys tem um caminho curto por QR, com risco visível; manual é simples de entender, mas depende de voltar e confirmar cada envio. É uma avaliação feita percorrendo a interface, sem estudo com clientes externos. Capturas em [telas da entrega](TELAS_ENTREGA_PRE_GO_LIVE.md).

## Atrito que continua existindo

O cadastro externo no site da Meta não foi percorrido: os ensaios conferem as instruções e os avisos locais dos modos padrão e coexistência. O cadastro e a aprovação na Meta dependem das telas e regras externas. O aviso sobre número dedicado deve ser lido antes de conectar quando coexistência não está habilitada. Baileys continua sujeito a desconexão/banimento. No manual, o operador precisa voltar ao sistema para confirmar o envio; o sistema não lê o WhatsApp para inferir que a mensagem saiu.
