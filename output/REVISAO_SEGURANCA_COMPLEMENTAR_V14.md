# Revisão complementar da área WhatsApp — 10/09/2026

Complementa as revisões de consentimento, fiscal, bibliotecas e migrações já registradas. É revisão local, sem certificação externa.

- O parâmetro de consulta aceita apenas meta/baileys, usa fallback definido e não chama a seleção de conexão. O botão explícito mantém a ação autenticada existente e a validação de borda da API.
- A consulta à Meta não transmite credenciais do aplicativo ao navegador. O campo de token permanece vazio; o formulário avançado recolhido não é considerado controle de acesso. A API continua exigindo a permissão de gerenciamento.
- O novo editor restringe opções na interface, mas a API e o domínio continuam responsáveis por validar tipo, variáveis, tamanho e compatibilidade dos botões. A correção de botoes=[] preserva a escolha sem ampliar permissões.
- A navegação externa de custos usa endereço oficial fixo com noopener/noreferrer. Mensagens e números continuam renderizados pelo React, sem HTML de cliente inserido diretamente.
- A fila manual mantém reserva por operador, controle de unidade, confirmação explícita e opt-out. A reorganização não transforma navegação em envio nem marca a mensagem ao abrir o link. O percurso de navegador comprova que sent_at permanece nulo até a confirmação.
- A revisão do único auxiliar detectou três problemas de coerência: pré-requisitos antes de trocar conexão, fila manual independente e botões padrão invisíveis. Todos foram tratados. O auxiliar não executou serviços nem alterou código nesta revisão.
- Prova dirigida: 3 testes da ação de botões aprovados; mutação que omite a lista vazia é rejeitada. Guarda da prévia passou em 12 testes junto da ação, incluindo prévia divergente/campo não editável/ausente.

A regressão integral v14 e os escaneamentos finais de árvore, histórico e dependências são registrados separadamente. Nenhum payload ou segredo de cliente real foi usado.
