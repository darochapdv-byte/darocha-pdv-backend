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
  // Aceita tags com ou sem namespace (ex: nfe:xProd, xProd)
  const re = new RegExp(`<(?:[\\w.]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w.]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function allTags(xml, tag) {
  const re = new RegExp(`<(?:[\\w.]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.]+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function decodeMaybeBase64(str) {
  if (!str || typeof str !== 'string') return '';
  const s = str.trim();
  if (s.includes('<') && (s.includes('nfe') || s.includes('NFe') || s.includes('det'))) return s;
  // data URL ou base64 puro
  const b64 = s.replace(/^data:.*?;base64,/, '').replace(/\s/g, '');
  if (b64.length > 80 && /^[A-Za-z0-9+/=]+$/.test(b64.slice(0, 80))) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (decoded.includes('<')) return decoded;
    } catch (_) {}
  }
  return s;
}

function extractXmlFromBody(body) {
  if (!body || typeof body !== 'object') return '';
  const candidates = [
    body.xml,
    body.xml_content,
    body.xmlContent,
    body.content,
    body.file_content,
    body.fileContent,
    body.nfe_xml,
    body.raw_xml,
    body.data,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const decoded = decodeMaybeBase64(c);
      if (decoded && decoded.length >= 20) return decoded;
    }
  }
  return '';
}

function parseNfeXml(xml) {
  const items = [];
  const dets = allTags(xml, 'det');
  for (const det of dets) {
    const code = textContent(det, 'cProd');
    const ean = textContent(det, 'cEAN') || textContent(det, 'cEANTrib');
    const name = textContent(det, 'xProd');
    const qty = parseFloat(String(textContent(det, 'qCom') || '0').replace(',', '.')) || 0;
    const unit = textContent(det, 'uCom') || 'UN';
    const unitPrice = parseFloat(String(textContent(det, 'vUnCom') || '0').replace(',', '.')) || 0;
    const total = parseFloat(String(textContent(det, 'vProd') || '0').replace(',', '.')) || 0;
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

/** Normaliza itens vindos do front (tela de revisão) */
function normalizeClientItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((it) => {
      if (!it || typeof it !== 'object') return null;
      const name = String(it.name || it.xProd || it.product_name || it.nome || '').trim();
      const qty = Number(it.qty ?? it.quantity ?? it.qCom ?? it.quantidade ?? 0) || 0;
      const unit_cost = Number(
        it.unit_cost ?? it.cost ?? it.cost_price ?? it.vUnCom ?? it.custo ?? 0
      ) || 0;
      const sale_price = Number(
        it.sale_price ?? it.price ?? it.preco_venda ?? it.selling_price ?? 0
      ) || 0;
      const barcode = String(
        it.barcode || it.ean || it.cEAN || it.code_ean || ''
      ).trim();
      const code = String(it.code || it.cProd || it.sku || '').trim();
      if (!name && !barcode && !code) return null;
      return {
        code,
        barcode: barcode && barcode !== 'SEM GTIN' ? barcode : '',
        name: name || code || barcode || 'Produto NF-e',
        qty,
        unit: String(it.unit || it.uCom || 'UN'),
        unit_cost,
        total_cost: Number(it.total_cost ?? it.vProd ?? unit_cost * qty) || 0,
        sale_price,
        product_id: it.product_id || it.id || null,
      };
    })
    .filter(Boolean);
}

nfe.post('/fetch-nfe-xml', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const chave = String(body.chave || body.access_key || body.key || '').replace(/\D/g, '');
    const validation = validateAccessKey(chave);
    if (!validation.valid) return c.json({ found: false, message: validation.reason }, 400);

    // Integração SEFAZ/terceiros não configurada neste ambiente — front deve usar XML manual
    return c.json({
      found: false,
      message:
        'Busca automática pela chave não está disponível neste servidor. Baixe o XML no portal da SEFAZ/fornecedor e use "Importar XML Manualmente".',
      chave,
    });
  } catch (error) {
    return c.json({ found: false, message: error.message }, 500);
  }
});

nfe.post('/import-nfe', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) {
      return c.json({
        error: 'Sessão expirada. Faça login novamente para importar a NF-e.',
        code: 'session_expired',
      }, 401);
    }
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const xml = extractXmlFromBody(body);

    let parsed = null;
    if (xml && xml.length >= 40) {
      parsed = parseNfeXml(xml);
    }

    // Front já parseou e manda items + metadados (confirmação de entrada)
    const clientItems = normalizeClientItems(body.items || body.products || body.produtos || []);
    if ((!parsed || !parsed.items.length) && clientItems.length) {
      parsed = {
        nfe_key: String(body.nfe_key || body.chave || body.access_key || '').replace(/\D/g, '') || '',
        number: String(body.number || body.nNF || body.nf_number || ''),
        series: String(body.series || body.serie || ''),
        issuer_name: String(body.issuer_name || body.emitter || body.supplier_name || ''),
        issuer_cnpj: String(body.issuer_cnpj || body.cnpj || '').replace(/\D/g, ''),
        issued_at: body.issued_at || body.dhEmi || null,
        items: clientItems,
      };
    }

    if (!parsed || !parsed.items.length) {
      return c.json({
        error:
          'XML inválido ou vazio. Envie o arquivo XML completo ou confirme a entrada com a lista de produtos já revisada.',
        code: 'xml_or_items_required',
        hint: 'Se a tela já mostra os produtos, use Confirmar Entrada; o servidor agora aceita os itens da revisão.',
      }, 400);
    }

    // Na confirmação o front costuma mandar sale_price ajustado
    if (clientItems.length && parsed.items.length) {
      const byKey = new Map();
      for (const it of clientItems) {
        byKey.set(`${it.barcode}|${it.code}|${it.name}`, it);
      }
      parsed.items = parsed.items.map((it) => {
        const match =
          byKey.get(`${it.barcode}|${it.code}|${it.name}`) ||
          clientItems.find(
            (c) =>
              (it.barcode && c.barcode && it.barcode === c.barcode) ||
              (it.code && c.code && it.code === c.code) ||
              (it.name && c.name && it.name === c.name)
          );
        if (!match) return it;
        return {
          ...it,
          qty: match.qty || it.qty,
          unit_cost: match.unit_cost || it.unit_cost,
          sale_price: match.sale_price || it.sale_price || 0,
          product_id: match.product_id || it.product_id || null,
        };
      });
    }

    // Confirmar entrada = criar/atualizar produtos e estoque (padrão do fluxo de revisão)
    const createProducts = body.create_products !== false;
    const updateStock = body.update_stock !== false; // default true na confirmação
    const results = [];

    for (const it of parsed.items) {
      let productId = it.product_id || null;
      let currentStock = 0;

      // Busca por barcode na loja; se órfão, reivindica
      if (!productId && it.barcode) {
        let q = admin.from('product').select('id,stock,created_by').eq('barcode', it.barcode).limit(5);
        const { data: found } = await q;
        const mine = (found || []).find((p) => p.created_by === user.id);
        const orphan = (found || []).find((p) => !p.created_by);
        const pick = mine || orphan || null;
        if (pick) {
          productId = pick.id;
          currentStock = Number(pick.stock) || 0;
          if (!pick.created_by) {
            await admin.from('product').update({ created_by: user.id }).eq('id', pick.id);
          }
        }
      }

      // Busca por código interno
      if (!productId && it.code) {
        const { data: found } = await admin
          .from('product')
          .select('id,stock,created_by')
          .eq('code', it.code)
          .eq('created_by', user.id)
          .limit(1);
        if (found?.[0]) {
          productId = found[0].id;
          currentStock = Number(found[0].stock) || 0;
        }
      }

      const salePrice = Number(it.sale_price) || 0;
      const unitCost = Number(it.unit_cost) || 0;

      if (productId) {
        const patch = {
          cost: unitCost || undefined,
        };
        if (salePrice > 0) patch.sale_price = salePrice;
        if (it.name) patch.name = it.name;
        if (updateStock) patch.stock = currentStock + (Number(it.qty) || 0);
        // remove undefined
        Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
        if (Object.keys(patch).length) {
          await admin.from('product').update(patch).eq('id', productId);
        }
      } else if (createProducts && it.name) {
        const insertPayload = {
          name: it.name,
          barcode: it.barcode || '',
          code: it.code || '',
          cost: unitCost,
          stock: updateStock ? Number(it.qty) || 0 : 0,
          sale_price: salePrice,
          active: true,
          created_by: user.id,
          unit: (it.unit || 'UN').toLowerCase() === 'un' ? 'un' : it.unit || 'un',
        };
        const { data: created, error: cErr } = await admin
          .from('product')
          .insert(insertPayload)
          .select()
          .single();
        if (cErr) {
          // duplicata de barcode → atualiza
          if (it.barcode) {
            const { data: again } = await admin
              .from('product')
              .select('id,stock')
              .eq('barcode', it.barcode)
              .limit(1)
              .maybeSingle();
            if (again) {
              productId = again.id;
              const patch = {
                created_by: user.id,
                cost: unitCost,
                sale_price: salePrice || undefined,
              };
              if (updateStock) patch.stock = (Number(again.stock) || 0) + (Number(it.qty) || 0);
              Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
              await admin.from('product').update(patch).eq('id', productId);
            }
          }
          if (!productId) {
            results.push({ ...it, product_id: null, error: cErr.message });
            continue;
          }
        } else {
          productId = created?.id || null;
        }
      }

      results.push({ ...it, product_id: productId });
    }

    // Registro da importação (tabela pode não existir — não bloqueia)
    let importId = null;
    try {
      const { data: nfeRow } = await admin
        .from('nfe_import')
        .insert({
          nfe_key: parsed.nfe_key || null,
          number: parsed.number || null,
          series: parsed.series || null,
          issuer_name: parsed.issuer_name || null,
          issuer_cnpj: parsed.issuer_cnpj || null,
          issued_at: parsed.issued_at || null,
          items: results,
          xml_size: xml ? xml.length : 0,
          imported_by: user.id,
          created_by: user.id,
          status: 'imported',
        })
        .select()
        .single();
      importId = nfeRow?.id || null;
    } catch (e) {
      console.warn('nfe_import table skip', e?.message || e);
    }

    if (updateStock) {
      try {
        await admin.from('stock_entry').insert({
          type: 'nfe',
          nfe_import_id: importId,
          items: results,
          notes: `NF-e ${parsed.number || ''}`.trim(),
          created_by: user.id,
        });
      } catch (e) {
        console.warn('stock_entry skip', e?.message || e);
      }
    }

    return c.json({
      ok: true,
      success: true,
      nfe: parsed,
      import_id: importId,
      items: results,
      updated_stock: updateStock,
      message: `${results.length} item(ns) processado(s).`,
    });
  } catch (error) {
    console.error('import-nfe', error);
    return c.json({ error: error.message || 'Erro ao importar NF-e' }, 500);
  }
});

export default nfe;
