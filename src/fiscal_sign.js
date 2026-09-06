import crypto from 'crypto';
import forge from 'node-forge';

export function loadA1(pfxBase64, password) {
  const der = forge.util.decode64(String(pfxBase64 || '').replace(/\s/g, ''));
  const p12Asn1 = forge.asn1.fromDer(der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
  const bagsKey = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]
    || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag];
  const bagsCert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
  if (!bagsKey?.[0]?.key) throw new Error('Não achei a chave privada no A1. Confira o arquivo e a senha.');
  if (!bagsCert?.[0]?.cert) throw new Error('Não achei o certificado no A1.');
  const key = bagsKey[0].key;
  const cert = bagsCert[0].cert;
  return {
    privateKeyPem: forge.pki.privateKeyToPem(key),
    certPem: forge.pki.certificateToPem(cert),
    notAfter: cert.validity.notAfter,
    pfxBuffer: Buffer.from(String(pfxBase64 || '').replace(/\s/g, ''), 'base64'),
    password,
  };
}

function digestSha1B64(xml) {
  return crypto.createHash('sha1').update(xml, 'utf8').digest('base64');
}

/** Assina infNFe (RSA-SHA1 + enveloped) — padrão oficial da NF-e/NFC-e 4.00. */
export function signInfNFe(infNFeXml, a1, chave) {
  const digest = digestSha1B64(infNFeXml);
  const signedInfo =
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">`
    + `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>`
    + `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>`
    + `<Reference URI="#NFe${chave}">`
    + `<Transforms>`
    + `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>`
    + `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>`
    + `</Transforms>`
    + `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>`
    + `<DigestValue>${digest}</DigestValue>`
    + `</Reference></SignedInfo>`;

  const sign = crypto.createSign('RSA-SHA1');
  sign.update(signedInfo, 'utf8');
  const signatureValue = sign.sign(a1.privateKeyPem, 'base64');
  const certBody = String(a1.certPem)
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  const signature =
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">`
    + signedInfo
    + `<SignatureValue>${signatureValue}</SignatureValue>`
    + `<KeyInfo><X509Data><X509Certificate>${certBody}</X509Certificate></X509Data></KeyInfo>`
    + `</Signature>`;

  return `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">${infNFeXml}${signature}</NFe>`;
}
