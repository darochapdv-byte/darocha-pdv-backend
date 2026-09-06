/**
 * Webservices oficiais NFC-e 4.00.
 * URLs: Portal NF-e / SEFAZ-SP / SVRS / SEFAZ-MS / SEFAZ-RS.
 * UF sem autorizador próprio cadastrado aqui usa SVRS quando a UF é da lista SVRS.
 * Não inventa URL: se a UF não estiver no mapa, emite erro explícito.
 */
const SVRS = {
  homologacao: {
    autorizacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    retAutorizacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
    consulta: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    status: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
    inutilizacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
    evento: 'https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
    qr: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
    urlChave: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
  },
  producao: {
    autorizacao: 'https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    retAutorizacao: 'https://nfce.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
    consulta: 'https://nfce.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    status: 'https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
    inutilizacao: 'https://nfce.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
    evento: 'https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
    qr: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
    urlChave: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
  },
};

const SP = {
  homologacao: {
    autorizacao: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx',
    retAutorizacao: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx',
    consulta: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx',
    status: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeStatusServico4.asmx',
    inutilizacao: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeInutilizacao4.asmx',
    evento: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRecepcaoEvento4.asmx',
    qr: 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode',
    urlChave: 'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta',
  },
  producao: {
    autorizacao: 'https://nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx',
    retAutorizacao: 'https://nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx',
    consulta: 'https://nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx',
    status: 'https://nfce.fazenda.sp.gov.br/ws/NFeStatusServico4.asmx',
    inutilizacao: 'https://nfce.fazenda.sp.gov.br/ws/NFeInutilizacao4.asmx',
    evento: 'https://nfce.fazenda.sp.gov.br/ws/NFeRecepcaoEvento4.asmx',
    qr: 'https://www.nfce.fazenda.sp.gov.br/qrcode',
    urlChave: 'https://www.nfce.fazenda.sp.gov.br/consulta',
  },
};

const MS = {
  homologacao: {
    autorizacao: 'https://hom.nfce.sefaz.ms.gov.br/ws/NFeAutorizacao4',
    retAutorizacao: 'https://hom.nfce.sefaz.ms.gov.br/ws/NFeRetAutorizacao4',
    consulta: 'https://hom.nfce.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4',
    status: 'https://hom.nfce.sefaz.ms.gov.br/ws/NFeStatusServico4',
    inutilizacao: 'https://hom.nfce.sefaz.ms.gov.br/ws/NFeInutilizacao4',
    evento: 'https://hom.nfce.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4',
    qr: 'http://www.dfe.ms.gov.br/nfce/qrcode',
    urlChave: 'http://www.dfe.ms.gov.br/nfce/consulta',
  },
  producao: {
    autorizacao: 'https://nfce.sefaz.ms.gov.br/ws/NFeAutorizacao4',
    retAutorizacao: 'https://nfce.sefaz.ms.gov.br/ws/NFeRetAutorizacao4',
    consulta: 'https://nfce.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4',
    status: 'https://nfce.sefaz.ms.gov.br/ws/NFeStatusServico4',
    inutilizacao: 'https://nfce.sefaz.ms.gov.br/ws/NFeInutilizacao4',
    evento: 'https://nfce.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4',
    qr: 'http://www.dfe.ms.gov.br/nfce/qrcode',
    urlChave: 'http://www.dfe.ms.gov.br/nfce/consulta',
  },
};

const RS = {
  homologacao: {
    autorizacao: 'https://nfce-homologacao.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    retAutorizacao: 'https://nfce-homologacao.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
    consulta: 'https://nfce-homologacao.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    status: 'https://nfce-homologacao.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
    inutilizacao: 'https://nfce-homologacao.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
    evento: 'https://nfce-homologacao.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
    qr: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
    urlChave: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
  },
  producao: {
    autorizacao: 'https://nfce.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    retAutorizacao: 'https://nfce.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
    consulta: 'https://nfce.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    status: 'https://nfce.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
    inutilizacao: 'https://nfce.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
    evento: 'https://nfce.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
    qr: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
    urlChave: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
  },
};

/** UFs cuja NFC-e é autorizada na SVRS (lista pública das SEFAZ). */
const SVRS_UFS = new Set(['AC','AL','AP','CE','DF','ES','PA','PB','PI','RJ','RN','RO','RR','SC','SE','TO']);

export const CUF = {
  AC:'12', AL:'27', AM:'13', AP:'16', BA:'29', CE:'23', DF:'53', ES:'32', GO:'52',
  MA:'21', MG:'31', MS:'50', MT:'51', PA:'15', PB:'25', PE:'26', PI:'22', PR:'41',
  RJ:'33', RN:'24', RO:'11', RR:'14', RS:'43', SC:'42', SE:'28', SP:'35', TO:'17',
};

export function resolveSefaz(uf, environment) {
  const u = String(uf || '').toUpperCase().slice(0, 2);
  const env = environment === 'producao' ? 'producao' : 'homologacao';
  if (!u || !CUF[u]) {
    return { error: 'UF inválida. Informe a UF da loja (ex. SP, CE, RS).' };
  }
  if (u === 'SP') return { uf: u, cUF: CUF[u], authorizer: 'SEFAZ-SP', env, urls: SP[env] };
  if (u === 'MS') return { uf: u, cUF: CUF[u], authorizer: 'SEFAZ-MS', env, urls: MS[env] };
  if (u === 'RS') return { uf: u, cUF: CUF[u], authorizer: 'SEFAZ-RS', env, urls: RS[env] };
  if (SVRS_UFS.has(u)) return { uf: u, cUF: CUF[u], authorizer: 'SVRS', env, urls: SVRS[env] };
  return {
    error: `A UF ${u} autoriza NFC-e em webservice próprio que ainda não está no mapa oficial deste build (AM, BA, GO, MG, MT, PE, PR). Use homologação SVRS/SP/MS/RS ou peça para cadastrar a URL oficial dessa UF.`,
    uf: u,
    cUF: CUF[u],
  };
}

export function soapEnvelope(innerXml, actionLocal) {
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">`
    + `<soap12:Body>`
    + `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/${actionLocal}">${innerXml}</nfeDadosMsg>`
    + `</soap12:Body></soap12:Envelope>`;
}

export function tag(xml, name) {
  const re = new RegExp(`<(?:[\\w]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w]+:)?${name}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}
