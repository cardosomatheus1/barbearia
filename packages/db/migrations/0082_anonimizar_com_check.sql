-- ============================================================================
-- 0082 — a anonimização para de bater na constraint que exige texto
--
-- `anonimizar_cliente` respondia **500** para qualquer pessoa com um ajuste
-- manual de fidelidade no extrato. O gatilho da 0079 faz
-- `UPDATE loyalty_entries SET note = NULL`, e a 0044 tem
-- `loyalty_entries_ajuste_tem_motivo`: linha de `ajuste` exige dez caracteres de
-- motivo escrito. Nulo viola a constraint, a transação inteira aborta, e o
-- direito à exclusão fica **impossível de exercer** — não parcialmente, não em
-- silêncio: com erro interno na tela de quem tentou responder ao titular.
--
-- Esta é a segunda vez, e a regra já estava escrita depois da primeira:
--
--   > `CHECK` que exige texto para sempre impede a limpeza que a lei manda
--   > fazer. Quem carrega a exigência passa a ser o campo que **não** sai.
--
-- No bloco 80 ela foi aplicada a `marketplace_attributions`, cuja categoria de
-- lista fechada passou a carregar a exigência. Aqui não há categoria: o motivo
-- do ajuste é texto livre por desenho, e é ele mesmo que precisa sair. Então a
-- saída é a que `data_requests.note` já usava **no mesmo gatilho** — marcador
-- fixo no lugar de nulo. A linha continua se explicando ("este saldo foi
-- mexido à mão e o porquê saiu com o titular"), o `CHECK` continua valendo
-- para tudo que alguém escrever, e o texto sobre a pessoa vai embora.
--
-- ## Por que nada ficou vermelho até agora
--
-- A suíte de LGPD anonimiza clientes que não têm ajuste manual, e o `ajuste` da
-- fidelidade tem suíte própria que não anonimiza ninguém. Cada metade era
-- coerente sozinha — é o mesmo formato do defeito do bloco 45. Quem encontrou
-- foi o percurso de navegador, clicando "Apagar os dados" numa ficha de
-- verdade: o dado que torna o defeito alcançável (uma anotação de saldo) é
-- justamente o que a semente da medição põe na ficha para a tela não sair vazia.
-- ============================================================================

/**
 * Marcador, nunca nulo — e o mesmo texto que `data_requests` já recebe.
 *
 * Uma segunda frase para a mesma coisa seria a lista paralela de sempre, e a
 * pergunta que chega no balcão é a mesma nos dois casos: *"por que este campo
 * está assim?"*. Dez caracteres é o piso do `CHECK`; esta frase tem folga de
 * sobra, e o `CHECK` continua sendo quem garante isso.
 */
CREATE OR REPLACE FUNCTION customers_anonimiza_textos_satelites() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  marcador constant text := 'texto removido na anonimizacao do titular';
BEGIN
  IF OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL THEN
    /**
     * `ajuste` recebe o marcador; o resto recebe nulo.
     *
     * O recorte é pelo **fato**, não pelo nome do tipo: o que a constraint
     * cobra é motivo escrito em linha criada à mão, e é só nela que apagar de
     * vez é recusado. Nulo continua sendo a resposta certa onde ele é aceito —
     * marcar tudo encheria o extrato de uma frase que não explica nada sobre
     * um acúmulo automático.
     */
    UPDATE public.loyalty_entries
       SET note = CASE WHEN kind = 'ajuste' THEN marcador ELSE NULL END
     WHERE customer_id = NEW.id AND tenant_id = NEW.tenant_id
       AND note IS NOT NULL AND note <> marcador;

    UPDATE public.data_requests
       SET note = marcador
     WHERE customer_id = NEW.id AND tenant_id = NEW.tenant_id
       AND note IS NOT NULL AND note <> marcador;

    UPDATE public.marketplace_attributions
       SET contested_reason = NULL
     WHERE customer_id = NEW.id AND tenant_id = NEW.tenant_id
       AND contested_reason IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- E as que já estão anonimizadas
--
-- Nenhuma barbearia está em produção, então não há linha para consertar hoje.
-- A instrução fica porque o custo é zero e a alternativa é confiar nisso.
-- ---------------------------------------------------------------------------
UPDATE loyalty_entries l
   SET note = 'texto removido na anonimizacao do titular'
  FROM customers c
 WHERE c.id = l.customer_id
   AND c.anonymized_at IS NOT NULL
   AND l.kind = 'ajuste'
   AND l.note IS NOT NULL
   AND l.note <> 'texto removido na anonimizacao do titular';
