-- A fila da conciliação passa a alcançar o cancelamento em voo.
--
-- `fiscal_invoices_em_curso_idx` cobria 'pendente' e 'processando' — os dois
-- estados da **emissão**. `cancelando` ficava de fora, e com ele a nota cujo
-- processo caiu entre gravar o estado e receber a resposta da prefeitura: ela
-- não era alcançada por tarefa nenhuma (a de emissão morre com a nota), não
-- entrava em varredura, e `ESTADOS_QUE_OCUPAM_A_VENDA` a inclui — então a
-- comanda nunca mais aceitava nota nova. A saída era UPDATE no banco.
--
-- O filtro da aplicação e o índice parcial dizem a mesma coisa, e agora os dois
-- dizem ESTADOS_EM_VOO. Há teste que lê esta migração e compara com a constante
-- do domínio: escrever a lista só de um lado é o defeito que ele existe para
-- pegar, e que já aconteceu neste mesmo índice.
--
-- Reaplicável, como toda migração depois da baseline do livro-caixa.

DROP INDEX IF EXISTS fiscal_invoices_em_curso_idx;

CREATE INDEX IF NOT EXISTS fiscal_invoices_em_curso_idx
  ON fiscal_invoices (requested_at)
  WHERE status IN ('pendente', 'processando', 'cancelando');
