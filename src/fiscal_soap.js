import https from 'https';
import { URL } from 'url';
import { soapEnvelope, tag } from './fiscal_sefaz.js';

export function postSoap({ url, action, xml, pfx, passphrase, timeoutMs = 35000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = Buffer.from(xml, 'utf8');
    const agent = new https.Agent({
      pfx,
      passphrase,
      rejectUnauthorized: true,
    });
    const req = https.request({
      protocol: 'https:',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      agent,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8; action="' + action + '"',
        SOAPAction: action,
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, xml: text });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('Timeout no webservice da SEFAZ.'), { code: 'comunicacao' }));
    });
    req.on('error', (e) => reject(Object.assign(e, { code: 'comunicacao' })));
    req.write(body);
    req.end();
  });
}

export async function sefazAutoriza({ urls, nfeXml, lote, a1 }) {
  const envi =
    `<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">`
    + `<idLote>${lote}</idLote><indSinc>1</indSinc>${nfeXml}</enviNFe>`;
  const envelope = soapEnvelope(envi, 'NFeAutorizacao4');
  const res = await postSoap({
    url: urls.autorizacao,
    action: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
    xml: envelope,
    pfx: a1.pfxBuffer,
    passphrase: a1.password,
  });
  return parseRetorno(res.xml);
}

export async function sefazConsulta({ urls, chave, tpAmb, a1 }) {
  const cons =
    `<consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">`
    + `<tpAmb>${tpAmb}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${chave}</chNFe></consSitNFe>`;
  const envelope = soapEnvelope(cons, 'NFeConsultaProtocolo4');
  const res = await postSoap({
    url: urls.consulta,
    action: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4/nfeConsultaNF',
    xml: envelope,
    pfx: a1.pfxBuffer,
    passphrase: a1.password,
  });
  return parseRetorno(res.xml);
}

export async function sefazStatus({ urls, cUF, tpAmb, a1 }) {
  const cons =
    `<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">`
    + `<tpAmb>${tpAmb}</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ></consStatServ>`;
  const envelope = soapEnvelope(cons, 'NFeStatusServico4');
  const res = await postSoap({
    url: urls.status,
    action: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF',
    xml: envelope,
    pfx: a1.pfxBuffer,
    passphrase: a1.password,
  });
  return parseRetorno(res.xml);
}

export async function sefazCancela({ urls, chave, protocol, reason, tpAmb, orgao, a1 }) {
  const dh = new Date().toISOString().replace(/\.\d{3}Z$/, '-03:00');
  const infEvento =
    `<infEvento Id="ID110111${chave}01">`
    + `<cOrgao>${orgao}</cOrgao><tpAmb>${tpAmb}</tpAmb>`
    + `<CNPJ>${chave.slice(6, 20)}</CNPJ>`
    + `<chNFe>${chave}</chNFe>`
    + `<dhEvento>${dh}</dhEvento>`
    + `<tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>`
    + `<detEvento versao="1.00"><descEvento>Cancelamento</descEvento>`
    + `<nProt>${protocol}</nProt><xJust>${String(reason).slice(0, 255)}</xJust>`
    + `</detEvento></infEvento>`;
  const envEvento =
    `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>1</idLote>`
    + `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">${infEvento}</evento></envEvento>`;
  const envelope = soapEnvelope(envEvento, 'NFeRecepcaoEvento4');
  const res = await postSoap({
    url: urls.evento,
    action: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento',
    xml: envelope,
    pfx: a1.pfxBuffer,
    passphrase: a1.password,
  });
  return parseRetorno(res.xml);
}

export async function sefazInutiliza({ urls, cUF, tpAmb, cnpj, series, nIni, nFin, reason, ano, a1 }) {
  const y = String(ano || new Date().getFullYear()).slice(2);
  const id = `ID${cUF}${y}${cnpj}65${String(series).padStart(3, '0')}${String(nIni).padStart(9, '0')}${String(nFin).padStart(9, '0')}`;
  const inn =
    `<inutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">`
    + `<infInut Id="${id}">`
    + `<tpAmb>${tpAmb}</tpAmb><xServ>INUTILIZAR</xServ><cUF>${cUF}</cUF>`
    + `<ano>${y}</ano><CNPJ>${cnpj}</CNPJ><mod>65</mod>`
    + `<serie>${Number(series)}</serie><nNFIni>${Number(nIni)}</nNFIni><nNFFin>${Number(nFin)}</nNFFin>`
    + `<xJust>${String(reason).slice(0, 255)}</xJust>`
    + `</infInut></inutNFe>`;
  const envelope = soapEnvelope(inn, 'NFeInutilizacao4');
  const res = await postSoap({
    url: urls.inutilizacao,
    action: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4/nfeInutilizacaoNF',
    xml: envelope,
    pfx: a1.pfxBuffer,
    passphrase: a1.password,
  });
  return parseRetorno(res.xml);
}

export function parseRetorno(xml) {
  const cStat = tag(xml, 'cStat');
  const xMotivo = tag(xml, 'xMotivo');
  const chNFe = tag(xml, 'chNFe');
  const nProt = tag(xml, 'nProt');
  const nRec = tag(xml, 'nRec');
  const prot = tag(xml, 'protNFe') || '';
  return {
    raw: xml,
    cStat,
    xMotivo,
    chNFe,
    nProt,
    nRec,
    authorized: cStat === '100' || cStat === '150',
    rejected: !!cStat && !['100', '150', '103', '104', '105'].includes(cStat),
    processing: cStat === '103' || cStat === '105',
    prot,
  };
}

export { tag };
