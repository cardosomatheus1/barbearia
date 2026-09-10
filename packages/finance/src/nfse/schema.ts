import { readFileSync } from 'node:fs';
import { XmlBufferInputProvider, XmlDocument, XsdValidator, xmlRegisterInputProvider } from 'libxml2-wasm';
import { conferirXmlFiscal } from './xml-seguro.js';

const arquivos = ['DPS_v1.01.xsd', 'NFSe_v1.01.xsd', 'pedRegEvento_v1.01.xsd',
  'evento_v1.01.xsd', 'tiposComplexos_v1.01.xsd', 'tiposSimples_v1.01.xsd',
  'tiposEventos_v1.01.xsd', 'xmldsig-core-schema.xsd'];
const BASE = 'nfse-oficial-1.01-20260727/';
let recursos: Record<string, Buffer> | undefined;
const validadores = new Map<string, XsdValidator>();

/** XSD de julho/2026, com correção documentada da posição do CNPJ na chave. */
export function validarSchemaNfse(xml: string, tipo: 'DPS' | 'NFSe' | 'pedRegEvento' | 'evento'): void {
  conferirXmlFiscal(xml);
  if (!['DPS', 'NFSe', 'pedRegEvento', 'evento'].includes(tipo)) throw new Error('nfse_schema_desconhecido');
  if (!recursos) {
    recursos = Object.fromEntries(arquivos.map(nome => {
      const original = readFileSync(new URL(`../../schemas/nfse-1.01-20260727/${nome}`, import.meta.url));
      if (nome !== 'tiposSimples_v1.01.xsd') return [BASE + nome, original];
      // TSChaveNFSe publicou a posição da inscrição da NF-e (6), divergindo
      // de TSIdNFSe e de sua própria descrição (município 7 + ambiente + tipo).
      // Corrigimos só a cópia em memória, preservando bytes/hashes oficiais.
      const publicado = '<xs:pattern value="[0-9]{6}([0-9A-Z]{14})[0-9]{30}"/>';
      const texto = original.toString('utf8');
      if (texto.split(publicado).length !== 2) throw new Error('nfse_schema_requer_revisao');
      return [BASE + nome, Buffer.from(texto.replace(publicado, '<xs:pattern value="[0-9]{9}[0-9A-Z]{14}[0-9]{27}"/>'))];
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
