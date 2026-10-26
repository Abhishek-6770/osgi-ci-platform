#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignored = new Set(['.git', '.github', 'target', 'node_modules', '.idea']);
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
function parseManifest(text) {
  const headers = new Map();
  let current = '';
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (!line) continue;
    if (line.startsWith(' ') && current) {
      headers.set(current, `${headers.get(current) ?? ''}${line.slice(1)}`);
    } else {
      const colon = line.indexOf(':');
      if (colon > 0) {
        current = line.slice(0, colon).trim().toLowerCase();
        headers.set(current, line.slice(colon + 1).trim());
      }
    }
  }
  return headers;
}
function clauses(value = '') {
  const out = [];
  let start = 0, quote = false, square = 0, round = 0, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && quote) { escaped = true; continue; }
    if (c === '"') quote = !quote;
    else if (!quote) {
      if (c === '[') square++;
      else if (c === ']' && square > 0) square--;
      else if (c === '(') round++;
      else if (c === ')' && round > 0) round--;
      else if (c === ',' && square === 0 && round === 0) {
        const c1 = value.slice(start, i).trim(); if (c1) out.push(c1);
        start = i + 1;
      }
    }
  }
  const tail = value.slice(start).trim(); if (tail) out.push(tail);
  return out;
}
const clauseName = value => value.split(';', 1)[0].trim();
const files = walk(root).map(file => file.replaceAll(path.sep, '/'));
const manifestFiles = files.filter(file => /\/plugins\/[^/]+\/META-INF\/MANIFEST\.MF$/.test(file));
const featureFiles = files.filter(file => /\/features\/[^/]+\/feature\.xml$/.test(file));
const errors = [];
const warnings = [];
const bundles = new Map();
const exports = new Map();
const bundleRecords = [];

for (const file of manifestFiles) {
  const headers = parseManifest(fs.readFileSync(file, 'utf8'));
  const rawName = headers.get('bundle-symbolicname') ?? '';
  const bsn = clauseName(rawName);
  const version = headers.get('bundle-version') ?? '';
  if (!bsn) errors.push(`${file}: missing Bundle-SymbolicName`);
  if (!version) errors.push(`${file}: missing Bundle-Version`);
  if (bsn) {
    if (bundles.has(bsn)) errors.push(`Duplicate Bundle-SymbolicName '${bsn}' in ${bundles.get(bsn)} and ${file}`);
    else bundles.set(bsn, file);
  }
  const record = { file, bsn, headers };
  bundleRecords.push(record);
  for (const clause of clauses(headers.get('export-package') ?? '')) {
    const packageName = clauseName(clause);
    if (!packageName) continue;
    if (!exports.has(packageName)) exports.set(packageName, []);
    exports.get(packageName).push({ bsn, file });
  }
}

// Fail on unresolved imports internal to this product namespace; external platform packages are resolved by the PDE target platform.
for (const record of bundleRecords) {
  for (const clause of clauses(record.headers.get('import-package') ?? '')) {
    const pkg = clauseName(clause);
    if (!pkg.startsWith('com.northwind.oms.')) continue;
    const providers = exports.get(pkg) ?? [];
    if (providers.length === 0) errors.push(`${record.file}: internal Import-Package '${pkg}' has no Export-Package provider`);
    else if (providers.length > 1) warnings.push(`${record.file}: internal Import-Package '${pkg}' has multiple exporters: ${providers.map(p => p.bsn).join(', ')}`);
  }
  for (const clause of clauses(record.headers.get('require-bundle') ?? '')) {
    const requested = clauseName(clause);
    if (requested.startsWith('com.northwind.oms.') && !bundles.has(requested)) {
      errors.push(`${record.file}: internal Require-Bundle '${requested}' has no matching Bundle-SymbolicName`);
    }
  }
}

const featureIds = new Map();
const featureRecords = [];
for (const file of featureFiles) {
  const xml = fs.readFileSync(file, 'utf8');
  const id = xml.match(/<feature\b[\s\S]*?\bid=["']([^"']+)/)?.[1];
  const version = xml.match(/<feature\b[\s\S]*?\bversion=["']([^"']+)/)?.[1];
  if (!id) errors.push(`${file}: missing feature id`);
  if (!version) errors.push(`${file}: missing feature version`);
  if (id) {
    if (featureIds.has(id)) errors.push(`Duplicate feature id '${id}' in ${featureIds.get(id)} and ${file}`);
    else featureIds.set(id, file);
  }
  featureRecords.push({ file, id, xml });
}
for (const feature of featureRecords) {
  for (const match of feature.xml.matchAll(/<plugin\b[^>]*\bid=["']([^"']+)["'][^>]*>/gs)) {
    const bundleId = match[1];
    if (bundleId.startsWith('com.northwind.oms.') && !bundles.has(bundleId)) {
      errors.push(`${feature.file}: feature plugin '${bundleId}' has no matching local bundle manifest`);
    }
  }
  for (const match of feature.xml.matchAll(/<import\b[^>]*\bfeature=["']([^"']+)["'][^>]*>/gs)) {
    const importedId = match[1];
    if (importedId.startsWith('com.northwind.oms.') && !featureIds.has(importedId)) {
      errors.push(`${feature.file}: internal imported feature '${importedId}' was not found`);
    }
  }
}

console.log('OSGi metadata validation');
console.log(`  Bundle manifests: ${manifestFiles.length}`);
console.log(`  Features: ${featureFiles.length}`);
console.log(`  Exported package names: ${exports.size}`);
console.log(`  Internal bundle identities: ${bundles.size}`);
for (const warning of warnings) console.warn(`WARN: ${warning}`);
for (const error of errors) console.error(`ERROR: ${error}`);
if (errors.length) {
  console.error(`OSGi metadata validation failed with ${errors.length} error(s).`);
  process.exit(1);
}
console.log(`OSGi metadata validation passed${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.`);
