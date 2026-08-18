-- ============================================================================
-- 0085 — a automação aponta para um texto, e não para um tipo (bloco 94)
--
-- ## O defeito
--
-- A barbearia monta uma automação escolhendo entre onze gatilhos: primeiro
-- atendimento, aniversário, sem retorno, assinatura vencendo, pacote acabando,
-- cancelamento, avaliação boa, avaliação ruim, serviço realizado, produto
-- comprado, vaga na espera. Onze situações diferentes, e é por serem diferentes
-- que elas existem.
--
-- E todas mandavam **o mesmo texto**. Três coisas conspiravam:
--
--   1. só `retorno` é permitido em automação e campanha, pela decisão do bloco
--      88 — as outras cinco falam de horário marcado, que quem recebe não tem;
--   2. o nome do template é derivado do tipo desde o bloco 89, então existe um
--      texto por tipo;
--   3. o índice `whatsapp_templates_um_aprovado_por_tipo` **impõe** isso: um
--      aprovado por `(location_id, kind, language)`.
--
-- Resultado: "avisa quando a assinatura está vencendo" e "avisa quando o pacote
-- está acabando" saem com a mesma frase. O dono monta as duas com cuidado e
-- descobre depois — ou não descobre, e o cliente recebe o texto errado.
--
-- ## O conserto é inverter a ligação
--
-- A automação passa a apontar para **um texto**, escolhido por quem a montou. O
-- tipo continua existindo e continua decidindo o que importa — natureza da
-- mensagem, opt-out, teto do mês, categoria na Meta —, mas deixa de ser o
-- endereço do texto.
--
-- ## Por que o índice pode cair só para `retorno`
--
-- O comentário que o criou está certo e continua valendo para os outros cinco:
-- *"dois aprovados para o mesmo aviso, porque aí a escolha de qual mandar seria
-- arbitrária e mudaria entre duas leituras"*. O motor resolve o lembrete de 24h
-- por tipo — não há quem escolha, é ele que dispara sozinho — e ali a
-- ambiguidade seria real.
--
-- Em `retorno` não é mais: quem escolhe é a automação, pelo id. A ambiguidade
-- que o índice evitava deixou de existir **porque a escolha passou a ser
-- explícita**, e não porque alguém decidiu tolerá-la.
--
-- ## `RESTRICT`, e não `CASCADE`
--
-- Apagar um texto que uma automação usa não pode apagar a automação junto: ela
-- é a decisão do dono sobre quando falar com o cliente, e o texto é só a frase.
-- `RESTRICT` faz a tentativa falhar com a pergunta certa — "esta automação usa
-- este texto" —, que é o que a tela precisa dizer.
-- ============================================================================

-- O nome que a barbearia deu ao texto, em português.
--
-- `name` é o identificador da Meta: minúsculas, números e sublinhado, e é ele
-- que viaja na API. Nunca foi para ser lido por gente — o balcão foi obrigado a
-- digitá-lo até o bloco 89, e "Lembrete 24h" voltava como "Parâmetro inválido".
--
-- Nulo é o texto criado antes deste bloco: a tela cai no rótulo do tipo, que é
-- o que ela já mostrava.
ALTER TABLE whatsapp_templates
  ADD COLUMN IF NOT EXISTS titulo text;

COMMENT ON COLUMN whatsapp_templates.titulo IS
  'O nome que a barbearia deu ao texto, em portugues e para ler. O identificador '
  'da Meta e "name", que so aceita minusculas, numeros e sublinhado. NULL e '
  'texto anterior ao bloco 94: a tela cai no rotulo do tipo.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'whatsapp_templates_titulo_nao_vazio'
       AND conrelid = 'whatsapp_templates'::regclass
  ) THEN
    ALTER TABLE whatsapp_templates
      ADD CONSTRAINT whatsapp_templates_titulo_nao_vazio CHECK (
        titulo IS NULL OR length(btrim(titulo)) > 0
      );
  END IF;
END $$;

-- O índice de um-aprovado-por-tipo passa a valer só para o que o motor resolve
-- sozinho. Ver o cabeçalho: em `retorno` quem escolhe é a automação, pelo id.
DROP INDEX IF EXISTS whatsapp_templates_um_aprovado_por_tipo;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_um_aprovado_por_tipo
  ON whatsapp_templates (location_id, kind, language)
  WHERE status = 'aprovado' AND kind <> 'retorno';

-- Qual texto esta automação manda.
--
-- Nulo é a automação criada antes deste bloco: ela continua resolvendo por tipo,
-- como sempre fez, e a tela pede o texto na primeira edição. Obrigatório de
-- saída trancaria toda automação existente no dia da migração — é a decisão de
-- `staff_locations`, onde ausência significa o comportamento anterior.
ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES whatsapp_templates(id) ON DELETE RESTRICT;

COMMENT ON COLUMN automations.template_id IS
  'O texto que esta automacao manda. NULL e automacao anterior ao bloco 94, que '
  'resolve por tipo como antes. RESTRICT: apagar um texto em uso falha com a '
  'pergunta certa em vez de levar a automacao junto.';

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES whatsapp_templates(id) ON DELETE RESTRICT;

COMMENT ON COLUMN campaigns.template_id IS
  'O texto que esta campanha mandou. Congelado como o publico: trocar o texto '
  'depois nao reescreve o que ja saiu.';

CREATE INDEX IF NOT EXISTS automations_template_idx
  ON automations (template_id) WHERE template_id IS NOT NULL;
