-- ============================================================================
-- 0084 — os escopos concedidos deixam o log e viram cadastro (bloco 88)
--
-- O bloco 84 já lê do `debug_token` quais permissões a Meta concedeu, e as
-- imprime:
--
--     [whatsapp] permissões concedidas { escopos: [...], podeGerenciar: false }
--
-- O comentário que a acompanha previu o defeito inteiro antes de ele acontecer:
-- criar template exige `whatsapp_business_management`, o produto se contenta
-- com `messaging` para **descobrir** a conta, e quem concedesse só a segunda
-- conectaria o número normalmente para descobrir a falta na primeira tentativa
-- de aprovar um texto — com "esta conta não pode criar um novo modelo", que não
-- nomeia permissão nenhuma.
--
-- Foi o que aconteceu. E o custo não foi a mensagem ruim: foi que a **única**
-- maneira de responder "este token cria modelo?" era dar SSH no servidor e
-- grepar log. O balcão escreve o texto inteiro, clica em aprovar, e recebe uma
-- frase da Meta sobre a qual não pode agir.
--
-- Um valor que decide o que a tela pode oferecer não mora em log. Log é para
-- reconstruir o que aconteceu; isto é estado do cadastro, e a tela precisa dele
-- **antes** de a pessoa começar a escrever.
--
-- ## Por que os escopos, e não uma coluna `pode_gerenciar`
--
-- Um booleano responde uma pergunta só, e a Meta acrescenta permissão sem
-- avisar. Guardando o que ela **disse**, a pergunta seguinte — "este token lê
-- o catálogo?", "este token responde conversa?" — se responde em `core`, sem
-- migração e sem reconectar as barbearias que já estão ligadas. É a mesma razão
-- de `commission_entries` guardar base e regra em vez do valor.
--
-- ## `NULL` é "não dá para dizer", e não é "não pode"
--
-- E é a decisão mais importante deste arquivo. Três cadastros legítimos não têm
-- escopo nenhum para gravar:
--
--   - o que foi conectado antes deste bloco;
--   - o que foi preenchido pelo **formulário** do bloco 55, que é o caminho de
--     escape de quem já tem os ids na mão e nunca passa pela Meta;
--   - o que a barbearia mantém enquanto troca de conta.
--
-- Tratar esses três como "sem permissão" faria a tela acusar de falta de acesso
-- justamente quem está com o acesso funcionando — e a acusação apareceria como
-- um aviso vermelho sobre um cadastro que manda mensagem sem reclamar. Entre
-- calar e mentir, cala: `null` não desenha aviso, e a pessoa descobre pelo
-- caminho de antes, que é o comportamento que já existia.
--
-- É a distinção que o bloco 61 escreveu para o score — "não dá para dizer" é
-- diferente de "risco zero" — e o mesmo motivo: numa tela, os dois se parecem e
-- levam a decisões opostas.
--
-- ## Vazio é recusado
--
-- `{}` significaria "a Meta respondeu e não concedeu nada", e isso não
-- acontece: `descobrirWaba` recusa a conexão antes, porque sem escopo não há
-- como saber a qual conta o token pertence. Uma linha vazia só entraria aqui
-- por um caminho novo escrito errado — e aí ela seria lida como "não pode
-- gerenciar", com a tela acusando por um defeito nosso. O `CHECK` é o que
-- transforma esse caminho em erro na gravação, que é onde ele dá para achar.
-- ============================================================================

-- ## Por que esta migração é reaplicável, e as anteriores não são
--
-- Ela é a **primeira depois da baseline** (`0083_recurso_fiscal.sql`, em
-- `migrate.sh`). Banco que existe lá fora sem livro-caixa é adotado marcando
-- tudo até a baseline como aplicado — e tudo **depois** dela roda de verdade,
-- que é a metade da adoção que impede a migração nova de ser pulada em
-- silêncio.
--
-- O preço é que ela pode reencontrar o que ela mesma criou. Sem as guardas, o
-- `preparar` do compose morre em "column already exists", os contêineres que o
-- esperam com `service_completed_successfully` não sobem, e o Caddy fica fora
-- do ar — o sintoma é o site na porta 443 recusando conexão depois de um
-- comando que era só para atualizar. Já aconteceu uma vez neste produto, e é o
-- que `migracoes-repetiveis.test.mjs` existe para não deixar voltar.
--
-- Mover a baseline para cá seria a saída errada e mais perigosa: o banco de
-- produção veria esta migração marcada como aplicada **sem** ter a coluna, e a
-- falha só apareceria quando a aplicação a lesse.
ALTER TABLE whatsapp_settings
  ADD COLUMN IF NOT EXISTS granted_scopes text[];

COMMENT ON COLUMN whatsapp_settings.granted_scopes IS
  'Permissoes que a Meta concedeu a este token, como ela as nomeia '
  '(whatsapp_business_messaging, whatsapp_business_management). NULL e "nao da '
  'para dizer" — cadastro pelo formulario, ou anterior ao bloco 88 — e nunca '
  '"nao pode": quem decide o aviso da tela e podeGerenciarTemplates, em core.';

-- `ADD CONSTRAINT IF NOT EXISTS` não existe no Postgres, então a guarda é a
-- consulta ao catálogo. `conrelid` junto do nome porque `conname` só é único
-- por tabela: sem ele, uma constraint homônima noutra tabela faria esta ser
-- pulada em silêncio, que é o formato de falha que este arquivo inteiro evita.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'whatsapp_settings_escopos_nao_vazios'
       AND conrelid = 'whatsapp_settings'::regclass
  ) THEN
    ALTER TABLE whatsapp_settings
      ADD CONSTRAINT whatsapp_settings_escopos_nao_vazios CHECK (
        granted_scopes IS NULL OR cardinality(granted_scopes) > 0
      );
  END IF;
END $$;
