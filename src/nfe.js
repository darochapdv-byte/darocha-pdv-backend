import { Hono } from 'hono';
import { admin } from './db.js';
import { requireUser } from './helpers.js';

const nfe = new Hono();

function validateAccessKey(chave) {
  const digits = (chave || '').replace(/\D/g, '');
  if (digits.length !== 44) return { valid: false, reason: 'A chave de acesso deve conter 44 dígitos.' };
  const base = digits.slice(0, 43);
  const check = digits[43];
  let sum = 0;
  let weight = 2;
  for (let i = base.length - 1; i >= 0; i--) {
    sum += parseInt(base[i], 10) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  const dv = rest < 2 ? 0 : 11 - rest;
  if (String(dv) !== check) return { valid: false, reason: 'Dígito verificador da chave de acesso inválido.' };
  return { valid: true };
}

function textContent(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function allTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function parseNfeXml(xml) {
  const items = [];
  const dets = allTags(xml, 'det');
  for (const det of dets) {
    const code = textContent(det, 'cProd');
    const ean = textContent(det, 'cEAN') || textContent(det, 'cEANTrib');
    const name = textContent(det, 'xProd');
    const qty = parseFloat(textContent(det, 'qCom') || '0') || 0;
    const unit = textContent(det, 'uCom') || 'UN';
    const unitPrice = parseFloat(textContent(det, 'vUnCom') || '0') || 0;
    const total = parseFloat(textContent(det, 'vProd') || '0') || 0;
    items.push({
      code,
      barcode: ean && ean !== 'SEM GTIN' ? ean : '',
      name,
      qty,
      unit,
      unit_cost: unitPrice,
      total_cost: total,
    });
  }
  return {
    nfe_key: textContent(xml, 'chNFe') || '',
    number: textContent(xml, 'nNF') || '',
    series: textContent(xml, 'serie') || '',
    issuer_name: textContent(xml, 'xNome') || '',
    issuer_cnpj: textContent(xml, 'CNPJ') || '',
    issued_at: textContent(xml, 'dhEmi') || textContent(xml, 'dEmi') || '',
    items,
  };
}

nfe.post('/fetch-nfe-xml', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const chave = String(body.chave || '').replace(/\D/g, '');
    const validation = validateAccessKey(chave);
    if (!validation.valid) return c.json({ found: false, message: validation.reason });

    const serviceUrl = process.env.NFE_XML_SERVICE_URL;
    if (!serviceUrl) {
      return c.json({
        found: false,
        message: 'Não foi possível buscar o XML automaticamente. Importe o arquivo XML manualmente.',
      });
    }

    const token = process.env.NFE_XML_SERVICE_TOKEN || '';
    const url = serviceUrl.includes('{chave}')
      ? serviceUrl.replace('{chave}', chave)
      : `${serviceUrl}${serviceUrl.includes('?') ? '&' : '?'}chave=${chave}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: 'application/xml, text/xml, */*',
        },
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        return c.json({ found: false, message: `Serviço retornou ${resp.status}. Importe o XML manualmente.` });
      }
      const xml = await resp.text();
      if (!xml.includes('NFe') && !xml.includes('nfeProc')) {
        return c.json({ found: false, message: 'Resposta não parece um XML de NF-e válido.' });
      }
      return c.json({ found: true, xml });
    } catch (e) {
      clearTimeout(timeout);
      return c.json({ found: false, message: e.message || 'Timeout ao buscar XML.' });
    }
  } catch (error) {
    return c.json({ found: false, message: error.message });
  }
});

nfe.post('/import-nfe', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const xml = body.xml || '';
    if (!xml || xml.length < 50) return c.json({ error: 'XML inválido ou vazio' }, 400);

    const parsed = parseNfeXml(xml);
    if (!parsed.items.length) {
      return c.json({ error: 'Nenhum item encontrado no XML' }, 400);
    }

    // Optional: create/update products and stock entry
    const createProducts = body.create_products !== false;
    const updateStock = body.update_stock === true;
    const results = [];

    for (const it of parsed.items) {
      let productId = null;
      if (it.barcode) {
        const { data } = await admin.from('product').select('id,stock').eq('barcode', it.barcode).limit(1);
        productId = data?.[0]?.id || null;
        if (productId && updateStock) {
          const cur = Number(data[0].stock) || 0;
          await admin.from('product').update({
            stock: cur + it.qty,
            cost_price: it.unit_cost || undefined,
          }).eq('id', productId);
        }
      }
      if (!productId && createProducts && it.name) {
        const { data: created } = await admin.from('product').insert({
          name: it.name,
          barcode: it.barcode || '',
          code: it.code || '',
          cost_price: it.unit_cost,
          stock: updateStock ? it.qty : 0,
          sale_price: 0,
          active: true,
        }).select().single();
        productId = created?.id || null;
      }
      results.push({ ...it, product_id: productId });
    }

    const { data: nfeRow } = await admin.from('nfe_import').insert({
      nfe_key: parsed.nfe_key,
      number: parsed.number,
      series: parsed.series,
      issuer_name: parsed.issuer_name,
      issuer_cnpj: parsed.issuer_cnpj,
      issued_at: parsed.issued_at || null,
      items: results,
      xml_size: xml.length,
      imported_by: user.id,
      status: 'imported',
    }).select().single();

    if (updateStock) {
      await admin.from('stock_entry').insert({
        type: 'nfe',
        nfe_import_id: nfeRow?.id,
        items: results,
        notes: `NF-e ${parsed.number}`,
        created_by: user.id,
      });
    }

    return c.json({
      ok: true,
      nfe: parsed,
      import_id: nfeRow?.id,
      items: results,
    });
  } catch (error) {
    console.error('import-nfe', error);
    return c.json({ error: error.message }, 500);
  }
});

export default nfe;
