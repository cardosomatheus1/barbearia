import { readFileSync } from 'node:fs';
import { XmlBufferInputProvider, XmlDocument, XsdValidator, xmlRegisterInputProvider } from 'libxml2-wasm';
import { conferirXmlFiscal } from './xml-seguro.js';

const arquivos = ['DPS_v1.01.xsd', 'NFSe_v1.01.xsd', 'pedRegEvento_v1.01.xsd',
  'evento_v1.01.xsd', 'tiposComplexos_v1.01.xsd', 'tiposSimples_v1.01.xsd',
  'tiposEventos_v1.01.xsd', 'xmldsig-core-schema.xsd'];
const BASE = 'nfse-oficial-1.01/';
let recursos: Record<string, Buffer> | undefined;
const validadores = new Map<string, XsdValidator>();

/** Validação XSD com o ajuste de série documentado no README dos schemas. */
export function validarSchemaNfse(xml: string, tipo: 'DPS' | 'NFSe' | 'pedRegEvento' | 'evento'): void {
  conferirXmlFiscal(xml);
  if (!['DPS', 'NFSe', 'pedRegEvento', 'evento'].includes(tipo)) throw new Error('nfse_schema_desconhecido');
  if (!recursos) {
    recursos = Object.fromEntries(arquivos.map(nome => {
      const original = readFileSync(new URL(`../../schemas/nfse-1.01/${nome}`, import.meta.url));
      if (nome !== 'tiposSimples_v1.01.xsd') return [BASE + nome, original];
      // O arquivo publicado usa âncoras de regex .NET/JS na série. Em XSD 1.0
      // elas são literais: rejeitam "1" e aceitam "^1$". Preservamos o original
      // e ajustamos somente essa incompatibilidade na cópia em memória.
      const publicado = '<xs:pattern value="^0{0,4}\\d{1,5}$"/>';
      const texto = original.toString('utf8');
      if (texto.split(publicado).length !== 2) throw new Error('nfse_schema_requer_revisao');
      return [BASE + nome, Buffer.from(texto.replace(publicado, '<xs:pattern value="0{0,4}\\d{1,5}"/>'))];
    }));
    // Não registrar o leitor genérico de filesystem nem um leitor de rede.
    if (!xmlRegisterInputProvider(new XmlBufferInputProvider(recursos))) throw new Error('nfse_schema_indisponivel');
  }
  let validador = validadores.get(tipo);
  if (!validador) {
    const nome = `${BASE}${tipo}_v1.01.xsd`;
    const schema = XmlDocument.fromBuffer(recursos[nome]!, { url: nome });
    try { validador = XsdValidator.fromDoc(schema); validadores.set(tipo, validador); }
    finally { schema.dispose(); }
  }
  const documento = XmlDocument.fromString(xml);
  try { validador.validate(documento); }
  finally { documento.dispose(); }
}
