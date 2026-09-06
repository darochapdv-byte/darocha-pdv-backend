import crypto from 'crypto';
import { CUF } from './fiscal_sefaz.js';
import { onlyDigits, mapPaymentCode } from './fiscal_helpers.js';

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}

function pad(n, len) {
  return String(n || '0').replace(/\D/g, '').padStart(len, '0').slice(-len);
}

export function accessKeyDv(base43) {
  let sum = 0;
  let w = 2;
  for (let i = base43.length - 1; i >= 0; i--) {
    sum += parseInt(base43[i], 10) * w;
    w = w === 9 ? 2 : w + 1;
  }
  const rest = sum % 11;
  return String(rest < 2 ? 0 : 11 - rest);
}

export function buildAccessKey({ cUF, cnpj, series, number, tpEmis, emittedAt, cNF }) {
  const d = emittedAt instanceof Date ? emittedAt : new Date();
  const aamm = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0');
  const base = pad(cUF, 2) + aamm + pad(cnpj, 14) + '65' + pad(series, 3) + pad(number, 9) + String(tpEmis || '1') + pad(cNF, 8);
  return base + accessKeyDv(base);
}

export function buildQrCode({ chave, tpAmb, cscId, csc, qrBase }) {
  const versao = '2';
  const id = String(cscId || '').replace(/\D/g, '') || '1';
  const raw = `${chave}|${versao}|${tpAmb}|${id}|${csc || ''}`;
  const hash = crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
  const base = String(qrBase || '').replace(/\?.*$/, '');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}p=${chave}|${versao}|${tpAmb}|${id}|${hash}`;
}

export function buildNfceXml({ cfg, sale, items, payments, number, series, chave, cUF, tpAmb, tpEmis, now, qrUrl, urlChave }) {
  const cnpj = onlyDigits(cfg.cnpj);
  const ie = String(cfg.ie || '').replace(/\D/g, '');
  const uf = String(cfg.address?.uf || '').toUpperCase();
  const cMun = onlyDigits(cfg.address?.cMun || cfg.cMun || cfg.address?.ibge || '').slice(0, 7);
  const emitName = esc((cfg.legal_name || '').slice(0, 60));
  const fantasia = esc((cfg.trade_name || cfg.legal_name || '').slice(0, 60));
  const dhEmi = now.toISOString().replace(/\.\d{3}Z$/, '-03:00');
  const crt = String(cfg.tax_regime || cfg.crt || '1').replace(/\D/g, '').slice(0, 1) || '1';
  const destDoc = onlyDigits(sale.customer_doc || '');
  const vNF = money(sale.total);
  const dets = [];
  let vProd = 0;
  items.forEach((it, idx) => {
    const q = Number(it.qty ?? it.quantity ?? 1) || 1;
    const p = Number(it.sale_price ?? it.unit_price ?? it.price ?? 0) || 0;
    const v = Math.round(q * p * 100) / 100;
    vProd += v;
    const ncm = onlyDigits(it.ncm || it.NCM).slice(0, 8);
    const cfop = onlyDigits(it.cfop || it.CFOP || '5102').slice(0, 4);
    const icms = crt === '1'
      ? `<ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>`
      : `<ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>${money(v)}</vBC><pICMS>0.00</pICMS><vICMS>0.00</vICMS></ICMS00></ICMS>`;
    dets.push(
      `<det nItem="${idx + 1}">`
      + `<prod>`
      + `<cProd>${esc(String(it.product_id || it.id || it.sku || (idx + 1)).slice(0, 60))}</cProd>`
      + `<cEAN>SEM GTIN</cEAN>`
      + `<xProd>${esc((it.name || it.product_name || 'Item').slice(0, 120))}</xProd>`
      + `<NCM>${ncm}</NCM>`
      + `<CFOP>${cfop}</CFOP>`
      + `<uCom>UN</uCom>`
      + `<qCom>${q.toFixed(4)}</qCom>`
      + `<vUnCom>${money(p)}</vUnCom>`
      + `<vProd>${money(v)}</vProd>`
      + `<cEANTrib>SEM GTIN</cEANTrib>`
      + `<uTrib>UN</uTrib>`
      + `<qTrib>${q.toFixed(4)}</qTrib>`
      + `<vUnTrib>${money(p)}</vUnTrib>`
      + `<indTot>1</indTot>`
      + `</prod>`
      + `<imposto><vTotTrib>0.00</vTotTrib>${icms}<PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS></imposto>`
      + `</det>`
    );
  });
  const pays = (payments && payments.length ? payments : [{ ...mapPaymentCode(sale.payment_method), vPag: sale.total }])
    .map((p) => `<detPag><tPag>${p.tPag || '99'}</tPag><vPag>${money(p.vPag)}</vPag></detPag>`)
    .join('');
  const dest = destDoc.length === 11
    ? `<dest><CPF>${destDoc}</CPF></dest>`
    : destDoc.length === 14
      ? `<dest><CNPJ>${destDoc}</CNPJ></dest>`
      : '';
  const xLgr = esc((cfg.address?.street || cfg.address?.xLgr || 'NAO INFORMADO').slice(0, 60));
  const nro = esc(String(cfg.address?.number || cfg.address?.nro || 'S/N').slice(0, 60));
  const xBairro = esc((cfg.address?.neighborhood || cfg.address?.xBairro || 'CENTRO').slice(0, 60));
  const xMun = esc((cfg.address?.city || cfg.address?.municipio || '').slice(0, 60));
  const cep = onlyDigits(cfg.address?.cep || '').slice(0, 8);

  const infNFe =
    `<infNFe Id="NFe${chave}" versao="4.00">`
    + `<ide>`
    + `<cUF>${cUF}</cUF>`
    + `<cNF>${chave.slice(35, 43)}</cNF>`
    + `<natOp>VENDA</natOp>`
    + `<mod>65</mod>`
    + `<serie>${Number(series) || 1}</serie>`
    + `<nNF>${Number(number)}</nNF>`
    + `<dhEmi>${dhEmi}</dhEmi>`
    + `<tpNF>1</tpNF>`
    + `<idDest>1</idDest>`
    + `<cMunFG>${cMun || cUF + '00000'}</cMunFG>`
    + `<tpImp>4</tpImp>`
    + `<tpEmis>${tpEmis || '1'}</tpEmis>`
    + `<cDV>${chave.slice(-1)}</cDV>`
    + `<tpAmb>${tpAmb}</tpAmb>`
    + `<finNFe>1</finNFe>`
    + `<indFinal>1</indFinal>`
    + `<indPres>1</indPres>`
    + `<procEmi>0</procEmi>`
    + `<verProc>DarochaPDV1.0</verProc>`
    + `</ide>`
    + `<emit>`
    + `<CNPJ>${cnpj}</CNPJ>`
    + `<xNome>${emitName}</xNome>`
    + `<xFant>${fantasia}</xFant>`
    + `<enderEmit>`
    + `<xLgr>${xLgr}</xLgr>`
    + `<nro>${nro}</nro>`
    + `<xBairro>${xBairro}</xBairro>`
    + `<cMun>${cMun || cUF + '00000'}</cMun>`
    + `<xMun>${xMun}</xMun>`
    + `<UF>${uf}</UF>`
    + `<CEP>${cep}</CEP>`
    + `<cPais>1058</cPais>`
    + `<xPais>BRASIL</xPais>`
    + `</enderEmit>`
    + `<IE>${ie}</IE>`
    + `<CRT>${crt}</CRT>`
    + `</emit>`
    + dest
    + dets.join('')
    + `<total><ICMSTot>`
    + `<vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson>`
    + `<vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>`
    + `<vProd>${money(vProd)}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc>`
    + `<vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS>`
    + `<vOutro>0.00</vOutro><vNF>${vNF}</vNF><vTotTrib>0.00</vTotTrib>`
    + `</ICMSTot></total>`
    + `<transp><modFrete>9</modFrete></transp>`
    + `<pag>${pays}</pag>`
    + `<infAdic><infCpl>NFC-e emitida pelo Darocha PDV</infCpl></infAdic>`
    + `<infRespTec><CNPJ>${cnpj}</CNPJ><xContato>${emitName.slice(0, 60)}</xContato><email>contato@darochapdv.com</email><fone>11999999999</fone></infRespTec>`
    + `</infNFe>`;

  return { infNFe, chave };
}

export { CUF };
