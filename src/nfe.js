import { Hono } from 'hono';
import { admin } from './db.js';
import { requireUser, upsertSupplier } from './helpers.js';

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
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w.-]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function allTags(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function looksLikeXml(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  return t.length > 40 && t.includes('<') && /nfe|NFe|infNFe|<det[\s>]/i.test(t);
}

function decodeMaybeBase64(str) {
  if (!str || typeof str !== 'string') return '';
  let s = str.trim().replace(/^\uFEFF/, '');
  if (looksLikeXml(s)) return s;
  const b64 = s.replace(/^data:.*?;base64,/, '').replace(/\s/g, '');
  if (b64.length > 80 && /^[A-Za-z0-9+/=_-]+$/.test(b64.slice(0, 120))) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (looksLikeXml(decoded)) return decoded;
    } catch (_) {}
  }
  // URI encoded
  try {
    if (s.includes('%3C') || s.includes('%3c')) {
      const dec = decodeURIComponent(s);
      if (looksLikeXml(dec)) return dec;
    }
  } catch (_) {}
  return s;
}

/** Percorre objeto e acha a primeira string que parece XML de NF-e */
function findXmlDeep(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') {
    const d = decodeMaybeBase64(value);
    return looksLikeXml(d) ? d : '';
  }
  if (typeof value === 'object') {
    // File-like from JSON: { name, data, content, text }
    const preferred = ['xml', 'xml_content', 'xmlContent', 'content', 'data', 'text', 'file', 'nfe_xml', 'raw_xml', 'body'];
    for (const k of preferred) {
      if (value[k] != null) {
        const found = findXmlDeep(value[k], depth + 1);
        if (found) return found;
      }
    }
    for (const k of Object.keys(value)) {
      const found = findXmlDeep(value[k], depth + 1);
      if (found) return found;
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
      sale_price: 0,
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

function normalizeClientItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((it) => {
      if (!it || typeof it !== 'object') return null;
      const name = String(it.name || it.xProd || it.product_name || it.nome || '').trim();
      const qty = Number(it.qty ?? it.quantity ?? it.qCom ?? it.quantidade ?? 0) || 0;
      const unit_cost = Number(
        it.unit_cost ?? it.valorUnitario ?? it.cost ?? it.cost_price ?? it.vUnCom ?? it.custo ?? 0
      ) || 0;
      const sale_price = Number(
        it.sale_price ?? it.salePrice ?? it.price ?? it.preco_venda ?? it.selling_price ?? 0
      ) || 0;
      const barcode = String(it.barcode || it.ean || it.cEAN || it.code_ean || '').trim();
      const code = String(it.code || it.cProd || it.sku || it.reference || '').trim();
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

/** Lê body de JSON, texto XML ou multipart (arquivo) */
async function readImportPayload(c) {
  const ct = (c.req.header('content-type') || '').toLowerCase();
  let body = {};
  let xml = '';
  let rawText = '';

  try {
    if (ct.includes('multipart/form-data')) {
      const form = await c.req.parseBody({ all: true });
      body = { ...form };
      for (const [k, v] of Object.entries(form)) {
        if (typeof v === 'string' && looksLikeXml(decodeMaybeBase64(v))) {
          xml = decodeMaybeBase64(v);
          break;
        }
        // Hono File / Blob
        if (v && typeof v === 'object' && typeof v.text === 'function') {
          try {
            const t = await v.text();
            if (looksLikeXml(t)) {
              xml = t;
              break;
            }
            const d = decodeMaybeBase64(t);
            if (looksLikeXml(d)) {
              xml = d;
              break;
            }
          } catch (_) {}
        }
        if (v && typeof v === 'object' && v instanceof ArrayBuffer) {
          const t = Buffer.from(v).toString('utf8');
          if (looksLikeXml(t)) xml = t;
        }
      }
      if (!xml) xml = findXmlDeep(form);
    } else if (ct.includes('xml') || ct.includes('text/plain')) {
      rawText = await c.req.text();
      xml = decodeMaybeBase64(rawText);
      body = {};
    } else {
      // JSON ou body ambíguo
      rawText = await c.req.text();
      if (looksLikeXml(rawText)) {
        xml = decodeMaybeBase64(rawText);
      } else {
        try {
          body = rawText ? JSON.parse(rawText) : {};
        } catch {
          body = {};
          // às vezes vem xml puro sem content-type certo
          if (looksLikeXml(rawText)) xml = rawText;
        }
        if (!xml) xml = findXmlDeep(body);
      }
    }
  } catch (e) {
    console.warn('readImportPayload', e?.message || e);
  }

  return { body: body || {}, xml: xml || '' };
}

async function applyImport(user, parsed, { createProducts = true, updateStock = true, supplierId = null } = {}) {
  const results = [];
  let cadastrados = 0;
  let existentes = 0;
  let atualizados = 0;
  let totalEstoque = 0;
  let valorTotal = 0;

  for (const it of parsed.items) {
    let productId = it.product_id || null;
    let currentStock = 0;
    let wasExisting = false;
    let wasCreated = false;

    if (!productId && it.barcode) {
      const { data: found } = await admin
        .from('product')
        .select('id,stock,created_by')
        .eq('barcode', it.barcode)
        .limit(5);
      const mine = (found || []).find((p) => p.created_by === user.id);
      const orphan = (found || []).find((p) => !p.created_by);
      const pick = mine || orphan || null;
      if (pick) {
        productId = pick.id;
        currentStock = Number(pick.stock) || 0;
        wasExisting = true;
        if (!pick.created_by) {
          await admin.from('product').update({ created_by: user.id }).eq('id', pick.id);
        }
      }
    }

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
        wasExisting = true;
      }
    }

    // match by name within store
    if (!productId && it.name) {
      const { data: found } = await admin
        .from('product')
        .select('id,stock,created_by')
        .eq('name', it.name)
        .eq('created_by', user.id)
        .limit(1);
      if (found?.[0]) {
        productId = found[0].id;
        currentStock = Number(found[0].stock) || 0;
        wasExisting = true;
      }
    }

    const salePrice = Number(it.sale_price) || 0;
    const unitCost = Number(it.unit_cost) || 0;
    const qty = Number(it.qty) || 0;
    valorTotal += unitCost * qty;

    if (productId) {
      const patch = {};
      if (unitCost) {
        patch.cost = unitCost;
        atualizados += 1;
      }
      if (salePrice > 0) patch.sale_price = salePrice;
      if (it.name) patch.name = it.name;
      if (updateStock) {
        patch.stock = currentStock + qty;
        totalEstoque += qty;
      }
      if (Object.keys(patch).length) {
        await admin.from('product').update(patch).eq('id', productId);
      }
      existentes += 1;
    } else if (createProducts && it.name) {
      const insertPayload = {
        name: it.name,
        barcode: it.barcode || '',
        code: it.code || '',
        cost: unitCost,
        stock: updateStock ? qty : 0,
        sale_price: salePrice,
        active: true,
        created_by: user.id,
        unit: 'un',
      };
      const { data: created, error: cErr } = await admin.from('product').insert(insertPayload).select().single();
      if (cErr) {
        if (it.barcode) {
          const { data: again } = await admin
            .from('product')
            .select('id,stock')
            .eq('barcode', it.barcode)
            .limit(1)
            .maybeSingle();
          if (again) {
            productId = again.id;
            const patch = { created_by: user.id, cost: unitCost };
            if (salePrice > 0) patch.sale_price = salePrice;
            if (updateStock) {
              patch.stock = (Number(again.stock) || 0) + qty;
              totalEstoque += qty;
            }
            await admin.from('product').update(patch).eq('id', productId);
            existentes += 1;
            atualizados += 1;
          }
        }
        if (!productId) {
          results.push({ ...it, product_id: null, error: cErr.message });
          continue;
        }
      } else {
        productId = created?.id || null;
        wasCreated = true;
        cadastrados += 1;
        if (updateStock) totalEstoque += qty;
      }
    }

    results.push({ ...it, product_id: productId, was_existing: wasExisting, was_created: wasCreated });
  }

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
        imported_by: user.id,
        created_by: user.id,
        status: 'imported',
      })
      .select()
      .single();
    importId = nfeRow?.id || null;
  } catch (e) {
    console.warn('nfe_import skip', e?.message || e);
  }

  // Histórico de entradas: 1 linha por produto (mesmo formato do cadastro manual)
  if (updateStock && results.length) {
    const now = new Date();
    const entry_date = now.toISOString().slice(0, 10);
    const entry_time = now.toTimeString().slice(0, 5);
    const supplier = parsed.issuer_name || '';
    const invoice_number = String(parsed.number || '').trim();
    const invoice_series = String(parsed.series || '').trim();
    const nfe_key = String(parsed.nfe_key || '').trim();
    const invoice_label = invoice_number
      ? `NF ${invoice_number}${invoice_series ? ' · Série ' + invoice_series : ''}`
      : (nfe_key ? `Chave ${nfe_key.slice(0, 20)}…` : '');
    const user_name = user.full_name || user.email || '';

    for (const it of results) {
      if (!it.product_id) {
        console.warn('stock_entry skip item without product_id', it.name);
        continue;
      }
      const qty = Number(it.qty) || 0;
      const unit_cost = Number(it.unit_cost) || 0;
      const total_value = Math.round(qty * unit_cost * 100) / 100;
      const row = {
        product_id: it.product_id,
        product_name: it.name || '',
        barcode: it.barcode || '',
        supplier,
        supplier_id: supplierId || null,
        invoice_number: invoice_label || invoice_number || null,
        invoice_series: invoice_series || null,
        invoice_code: invoice_label || nfe_key || null,
        nfe_key: nfe_key || null,
        quantity: qty,
        unit_cost,
        total_value,
        notes: invoice_label ? `Entrada ${invoice_label}` : 'Entrada NF-e',
        entry_date,
        entry_time,
        user_id: user.id,
        user_name,
        status: 'ativa',
        created_by: user.id,
      };
      try {
        let { data, error } = await admin.from('stock_entry').insert(row).select('id').maybeSingle();
        if (error) {
          console.warn('stock_entry insert try1', error.message);
          // remove optional cols
          const slim = {
            product_id: row.product_id,
            product_name: row.product_name,
            barcode: row.barcode,
            supplier: row.supplier,
            invoice_number: row.invoice_number,
            quantity: row.quantity,
            unit_cost: row.unit_cost,
            total_value: row.total_value,
            notes: row.notes,
            entry_date: row.entry_date,
            entry_time: row.entry_time,
            user_id: row.user_id,
            user_name: row.user_name,
            status: 'ativa',
            created_by: row.created_by,
          };
          const r2 = await admin.from('stock_entry').insert(slim).select('id').maybeSingle();
          if (r2.error) console.warn('stock_entry insert try2', r2.error.message);
          else data = r2.data;
        }
        if (data?.id) {
          // ok
        }
      } catch (e) {
        console.warn('stock_entry exception', e?.message || e);
      }
    }
  }

  return {
    results,
    importId,
    stats: {
      encontrados: results.length,
      cadastrados,
      existentes,
      atualizados,
      totalEstoque,
      valorTotal: Math.round(valorTotal * 100) / 100,
    },
  };
}

nfe.post('/fetch-nfe-xml', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const chave = String(body.chave || body.access_key || body.key || '').replace(/\D/g, '');
    const validation = validateAccessKey(chave);
    if (!validation.valid) return c.json({ found: false, message: validation.reason }, 400);
    return c.json({
      found: false,
      message:
        'A SEFAZ não disponibiliza o XML só com a chave (exige certificado digital do emitente/destinatário). Baixe o XML no e-mail/portal do fornecedor ou na consulta da nota e use "Importar XML Manualmente".',
      chave,
      code: 'auto_fetch_unavailable',
    });
  } catch (error) {
    return c.json({ found: false, message: error.message }, 500);
  }
});

/** Só parseia o XML e devolve itens (para a tela de revisão) */
nfe.post('/parse-nfe', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) {
      return c.json({ error: 'Sessão expirada. Faça login novamente.', code: 'session_expired' }, 401);
    }
    const { body, xml } = await readImportPayload(c);
    if (!xml || !looksLikeXml(xml)) {
      return c.json({
        error: 'XML inválido ou vazio',
        code: 'xml_empty',
        hint: 'Selecione o arquivo .xml da NF-e (não PDF).',
      }, 400);
    }
    const parsed = parseNfeXml(xml);
    if (!parsed.items.length) {
      return c.json({ error: 'Nenhum item encontrado no XML', code: 'no_items' }, 400);
    }
    // margem padrão 30%
    parsed.items = parsed.items.map((it) => ({
      ...it,
      sale_price: it.unit_cost ? Math.round(it.unit_cost * 1.3 * 100) / 100 : 0,
    }));
    return c.json({ ok: true, nfe: parsed, items: parsed.items, xml_size: xml.length });
  } catch (error) {
    return c.json({ error: error.message }, 500);
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

    const { body, xml } = await readImportPayload(c);

    let parsed = null;
    if (xml && looksLikeXml(xml)) {
      parsed = parseNfeXml(xml);
    }

    const clientItems = normalizeClientItems(
      body.items || body.products || body.produtos || body.nfe?.items || []
    );

    if ((!parsed || !parsed.items.length) && clientItems.length) {
      const forn = body.nfe?.fornecedor;
      const fornName = typeof forn === 'object' ? forn?.nome || forn?.name || '' : forn || '';
      parsed = {
        nfe_key: String(body.nfe_key || body.chave || body.access_key || body.nfe?.chave || '').replace(/\D/g, ''),
        number: String(
          body.number || body.nNF || body.nf_number || body.nfe?.numero || body.nfe?.number || body.nfe?.nNF || ''
        ).trim(),
        series: String(
          body.series || body.serie || body.nfe?.serie || body.nfe?.series || body.nfe?.serie || ''
        ).trim(),
        issuer_name: String(
          body.issuer_name || body.emitter || body.supplier_name || body.nfe?.issuer_name || fornName || ''
        ),
        issuer_cnpj: String(body.issuer_cnpj || body.cnpj || body.nfe?.issuer_cnpj || forn?.cnpj || '').replace(/\D/g, ''),
        issued_at: body.issued_at || body.dhEmi || body.nfe?.issued_at || null,
        items: clientItems,
      };
    }

    // Se veio XML + items da revisão, mescla preços de venda
    if (parsed?.items?.length && clientItems.length) {
      parsed.items = parsed.items.map((it) => {
        const match = clientItems.find(
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
          product_id: match.product_id || null,
        };
      });
    }

    if (!parsed || !parsed.items.length) {
      return c.json({
        error: 'XML inválido ou vazio',
        code: 'xml_or_items_required',
        message:
          'Não recebemos o conteúdo do XML. Use um arquivo .xml da NF-e (não PDF/foto). Se a lista de produtos já apareceu, toque em Confirmar Entrada novamente.',
        received_keys: Object.keys(body || {}).slice(0, 20),
        xml_len: xml ? xml.length : 0,
      }, 400);
    }

    // parse-only: só devolve itens (quando front chama import só para ler)
    const parseOnly =
      body.parse_only === true ||
      body.dry_run === true ||
      body.preview === true ||
      body.update_stock === false && body.create_products === false;

    if (parseOnly) {
      parsed.items = parsed.items.map((it) => ({
        ...it,
        sale_price: it.sale_price || (it.unit_cost ? Math.round(it.unit_cost * 1.3 * 100) / 100 : 0),
      }));
      return c.json({ ok: true, nfe: parsed, items: parsed.items, preview: true });
    }

    // default: na importação completa atualiza estoque
    const createProducts = body.create_products !== false;
    const updateStock = body.update_stock !== false;

    // Cadastra/atualiza fornecedor automaticamente (CNPJ ou nome único na loja)
    let supplierId = null;
    try {
      supplierId = await upsertSupplier(user.id, {
        name: parsed.issuer_name,
        cnpj: parsed.issuer_cnpj,
        issuer_cnpj: parsed.issuer_cnpj,
      });
    } catch (e) {
      console.warn('supplier upsert on nfe', e?.message || e);
    }

    const { results, importId, stats } = await applyImport(user, parsed, {
      createProducts,
      updateStock,
      supplierId,
    });

    const fornecedor =
      parsed.issuer_name ||
      body.nfe?.fornecedor?.nome ||
      body.nfe?.fornecedor ||
      body.issuer_name ||
      '';
    const numero = parsed.number || body.nfe?.numero || body.number || '';
    const serie = parsed.series || body.nfe?.serie || body.series || '';

    // Front exige `summary` — sem isso mostra "Erro desconhecido"
    const summary = {
      fornecedor,
      numero,
      serie,
      encontrados: stats.encontrados,
      cadastrados: stats.cadastrados,
      existentes: stats.existentes,
      atualizados: stats.atualizados,
      totalEstoque: stats.totalEstoque,
      valorTotal: stats.valorTotal,
      dataImportacao: new Date().toISOString(),
      import_id: importId,
    };

    return c.json({
      ok: true,
      success: true,
      summary,
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



/**
 * Reconstrói histórico de entradas a partir de:
 * 1) nfe_import (se existir)
 * 2) produtos da loja sem nenhuma StockEntry (estoque já cadastrado antes)
 */
nfe.post('/repair-stock-entry-history', async (c) => {
  try {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!admin) return c.json({ error: 'db_unavailable' }, 503);

    const body = await c.req.json().catch(() => ({}));
    const includeProductsWithoutEntry = body.include_products !== false;

    // entradas já existentes (para não duplicar)
    const { data: existing } = await admin
      .from('stock_entry')
      .select('id,product_id,invoice_number,quantity,notes,created_by')
      .eq('created_by', user.id)
      .limit(5000);
    const existingKeys = new Set();
    for (const e of existing || []) {
      existingKeys.add(`${e.product_id}|${e.invoice_number || ''}|${e.quantity || 0}`);
      if (e.product_id) existingKeys.add(`prod:${e.product_id}`);
    }

    let fromNfe = 0;
    let fromProducts = 0;

    // 1) nfe_import
    try {
      const { data: imports } = await admin
        .from('nfe_import')
        .select('*')
        .or(`created_by.eq.${user.id},imported_by.eq.${user.id}`)
        .limit(500);
      for (const imp of imports || []) {
        const items = Array.isArray(imp.items) ? imp.items : [];
        const supplier = imp.issuer_name || '';
        const invoice_number = String(imp.number || '');
        const invoice_series = String(imp.series || '');
        const nfe_key = String(imp.nfe_key || '');
        const created = imp.created_at ? new Date(imp.created_at) : new Date();
        const entry_date = created.toISOString().slice(0, 10);
        const entry_time = created.toTimeString().slice(0, 5);

        for (const it of items) {
          const productId = it.product_id || null;
          if (!productId) continue;
          const qty = Number(it.qty || it.quantity || 0) || 0;
          const unit_cost = Number(it.unit_cost || it.cost || 0) || 0;
          const key = `${productId}|${invoice_number}|${qty}`;
          if (existingKeys.has(key)) continue;

          const row = {
            product_id: productId,
            product_name: it.name || it.product_name || '',
            barcode: it.barcode || '',
            supplier,
            invoice_number,
            invoice_series: invoice_series || null,
            nfe_key: nfe_key || null,
            quantity: qty,
            unit_cost,
            total_value: Math.round(qty * unit_cost * 100) / 100,
            notes: `Entrada NF-e ${invoice_number} (histórico reconstruído)`.trim(),
            entry_date,
            entry_time,
            user_id: user.id,
            user_name: user.full_name || user.email || '',
            status: 'ativa',
            created_by: user.id,
          };
          const { error } = await admin.from('stock_entry').insert(row);
          if (!error) {
            fromNfe += 1;
            existingKeys.add(key);
            existingKeys.add(`prod:${productId}`);
          } else {
            const slim = { ...row };
            delete slim.invoice_series;
            delete slim.nfe_key;
            const r2 = await admin.from('stock_entry').insert(slim);
            if (!r2.error) {
              fromNfe += 1;
              existingKeys.add(key);
              existingKeys.add(`prod:${productId}`);
            }
          }
        }
      }
    } catch (e) {
      console.warn('nfe_import backfill', e?.message || e);
    }

    // 2) produtos com estoque e sem nenhuma entrada
    if (includeProductsWithoutEntry) {
      const { data: products } = await admin
        .from('product')
        .select('id,name,barcode,code,stock,cost,sale_price,created_at,created_by')
        .eq('created_by', user.id)
        .limit(5000);

      for (const p of products || []) {
        if (existingKeys.has(`prod:${p.id}`)) continue;
        const stock = Number(p.stock) || 0;
        // mesmo com estoque 0, se o produto existe pode ter tido entrada; só registra se stock > 0
        // ou se nunca teve entrada — usuário pediu ver o que já cadastrou
        if (stock <= 0) continue;

        const unit_cost = Number(p.cost) || 0;
        const created = p.created_at ? new Date(p.created_at) : new Date();
        const row = {
          product_id: p.id,
          product_name: p.name || '',
          barcode: p.barcode || p.code || '',
          supplier: 'Cadastro / importação anterior',
          invoice_number: '',
          quantity: stock,
          unit_cost,
          total_value: Math.round(stock * unit_cost * 100) / 100,
          notes: 'Registro retrospectivo do estoque já existente (antes do histórico automático)',
          entry_date: created.toISOString().slice(0, 10),
          entry_time: created.toTimeString().slice(0, 5),
          user_id: user.id,
          user_name: user.full_name || user.email || '',
          status: 'ativa',
          created_by: user.id,
        };
        const { error } = await admin.from('stock_entry').insert(row);
        if (!error) {
          fromProducts += 1;
          existingKeys.add(`prod:${p.id}`);
        } else {
          console.warn('product backfill entry', error.message);
        }
      }
    }

    return c.json({
      ok: true,
      from_nfe_imports: fromNfe,
      from_products: fromProducts,
      total_created: fromNfe + fromProducts,
      message:
        fromNfe + fromProducts > 0
          ? `${fromNfe + fromProducts} entrada(s) adicionada(s) ao histórico.`
          : 'Nada novo para reconstruir (histórico já estava completo ou sem dados).',
    });
  } catch (error) {
    console.error('repair-stock-entry-history', error);
    return c.json({ error: error.message }, 500);
  }
});

export default nfe;
