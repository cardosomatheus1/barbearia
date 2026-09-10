-- A tela lê a descrição do catálogo. A implementação própria não exige um intermediário.
UPDATE feature_flags SET description = 'Emissão de NFS-e pela comanda e consulta de notas. Exige configuração fiscal e certificado digital. Disponível conforme o regime e o município atendidos pelo emissor.'
WHERE code = 'fiscal';
