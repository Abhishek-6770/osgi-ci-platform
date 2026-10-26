#!/usr/bin/env node
/**
 * Northwind OMS smart-build planner.
 * Reads OSGi MANIFEST.MF and feature.xml metadata to plan changed builds and render graphs.
 * Eclipse PDE Build (headless Ant) compiles and packages the actual OSGi projects.
 * Uses only Node.js built-in modules; it does not compile or package bundles itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function log(message = '') { console.log(message); }
function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function walkFiles(dir, ignored = new Set(['.git', 'target', 'node_modules', '.idea'])) {
  if (!fs.existsSync(dir)) return [];
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(absolute, ignored));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}
function parseRootModules(root) {
  // Discover product domains from their PDE project layout, not from Maven POMs.
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !['.git', '.github', 'node_modules', 'target', 'tools', 'tests'].includes(entry.name))
    .map(entry => entry.name)
    .filter(name => {
      const base = path.join(root, name);
      return fs.existsSync(path.join(base, 'plugins')) || fs.existsSync(path.join(base, 'features'));
    })
    .sort();
}

/** Read OSGi headers and join continuation lines as required by MANIFEST.MF. */
export function parseManifest(text) {
  const headers = new Map();
  let current = '';
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (!line) continue;
    if (line.startsWith(' ') && current) {
      headers.set(current, `${headers.get(current) ?? ''}${line.slice(1)}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      current = line.slice(0, colon).trim().toLowerCase();
      headers.set(current, line.slice(colon + 1).trim());
    }
  }
  return headers;
}

/** Split OSGi comma-separated clauses without splitting quoted version ranges. */
export function splitOsgiClauses(value = '') {
  const clauses = [];
  let start = 0, quoted = false, escaped = false, square = 0, round = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quoted) { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    else if (!quoted) {
      if (char === '[') square++;
      else if (char === ']' && square) square--;
      else if (char === '(') round++;
      else if (char === ')' && round) round--;
      else if (char === ',' && square === 0 && round === 0) {
        const clause = value.slice(start, i).trim();
        if (clause) clauses.push(clause);
        start = i + 1;
      }
    }
  }
  const last = value.slice(start).trim();
  if (last) clauses.push(last);
  return clauses;
}
function clauseName(clause) { return clause.split(';', 1)[0].trim(); }
function ownerProduct(root, modules, file) {
  const relative = path.relative(root, file).replaceAll(path.sep, '/');
  const first = relative.split('/')[0];
  return modules.includes(first) ? first : null;
}
function isGlobImport(pattern) {
  return pattern.includes('*');
}
function packageProvider(packageName, exportedPackages) {
  if (exportedPackages.has(packageName)) return exportedPackages.get(packageName);
  if (!isGlobImport(packageName)) return null;
  const regex = new RegExp(`^${packageName.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  for (const [name, product] of exportedPackages) if (regex.test(name)) return product;
  return null;
}

export function discoverModel(root) {
  const modules = parseRootModules(root);
  const dependencies = new Map(modules.map(name => [name, new Set()]));
  const bundleToProduct = new Map();
  const exportedPackageToProduct = new Map();
  const manifests = walkFiles(root).filter(file => /\/plugins\/[^/]+\/META-INF\/MANIFEST\.MF$/.test(file.replaceAll(path.sep, '/'))).sort();
  const manifestRecords = [];

  for (const file of manifests) {
    const product = ownerProduct(root, modules, file);
    if (!product) continue;
    const headers = parseManifest(safeRead(file));
    const symbolicName = (headers.get('bundle-symbolicname') ?? '').split(';')[0].trim();
    if (symbolicName) bundleToProduct.set(symbolicName, product);
    for (const clause of splitOsgiClauses(headers.get('export-package') ?? '')) {
      const packageName = clauseName(clause);
      if (packageName && !exportedPackageToProduct.has(packageName)) exportedPackageToProduct.set(packageName, product);
    }
    manifestRecords.push({ file, product, headers });
  }

  for (const record of manifestRecords) {
    const { product, headers } = record;
    for (const clause of splitOsgiClauses(headers.get('import-package') ?? '')) {
      const provider = packageProvider(clauseName(clause), exportedPackageToProduct);
      if (provider && provider !== product) dependencies.get(product).add(provider);
    }
    for (const clause of splitOsgiClauses(headers.get('require-bundle') ?? '')) {
      const provider = bundleToProduct.get(clauseName(clause));
      if (provider && provider !== product) dependencies.get(product).add(provider);
    }
  }

  const featureFiles = walkFiles(root).filter(file => /\/features\/[^/]+\/feature\.xml$/.test(file.replaceAll(path.sep, '/'))).sort();
  const featureToProduct = new Map();
  const features = [];
  for (const file of featureFiles) {
    const product = ownerProduct(root, modules, file);
    const xml = safeRead(file);
    const id = xml.match(/<feature\b[^>]*\bid\s*=\s*["']([^"']+)["']/s)?.[1];
    if (!product || !id) continue;
    featureToProduct.set(id, product);
    features.push({ file, product, xml });
  }
  for (const feature of features) {
    for (const match of feature.xml.matchAll(/<import\b[^>]*\bfeature\s*=\s*["']([^"']+)["'][^>]*>/gs)) {
      const provider = featureToProduct.get(match[1]);
      if (provider && provider !== feature.product) dependencies.get(feature.product).add(provider);
    }
  }

  const edges = [];
  for (const [consumer, deps] of dependencies) {
    for (const dependency of deps) edges.push([dependency, consumer]); // dependency -> dependent
  }
  edges.sort((a, b) => modules.indexOf(a[0]) - modules.indexOf(b[0]) || modules.indexOf(a[1]) - modules.indexOf(b[1]));
  return { modules, dependencies, edges, bundleToProduct, exportedPackageToProduct, featureToProduct };
}

export function buildOrder(model, subset = new Set(model.modules)) {
  const selected = new Set([...subset].filter(name => model.dependencies.has(name)));
  const degree = new Map([...selected].map(node => [node, [...model.dependencies.get(node)].filter(dep => selected.has(dep)).length]));
  const queue = model.modules.filter(node => selected.has(node) && degree.get(node) === 0);
  const order = [];
  while (queue.length) {
    const node = queue.shift();
    order.push(node);
    for (const [dependency, dependent] of model.edges) {
      if (dependency !== node || !selected.has(dependent)) continue;
      degree.set(dependent, degree.get(dependent) - 1);
      if (degree.get(dependent) === 0) queue.push(dependent);
    }
  }
  if (order.length !== selected.size) {
    const cycle = [...selected].filter(node => !order.includes(node));
    throw new Error(`Dependency cycle detected between product modules: ${cycle.join(', ')}`);
  }
  return order;
}

export function affectedDependents(model, changedProducts) {
  const reverse = new Map(model.modules.map(name => [name, new Set()]));
  for (const [dependency, dependent] of model.edges) reverse.get(dependency).add(dependent);
  const selected = new Set([...changedProducts].filter(name => model.dependencies.has(name)));
  const queue = [...selected];
  while (queue.length) {
    const node = queue.shift();
    for (const dependent of reverse.get(node) ?? []) {
      if (!selected.has(dependent)) { selected.add(dependent); queue.push(dependent); }
    }
  }
  return selected;
}

export function allDependencyPaths(model, changedProducts) {
  const reverse = new Map(model.modules.map(name => [name, []]));
  for (const [dependency, dependent] of model.edges) reverse.get(dependency).push(dependent);
  const results = [];
  for (const source of model.modules.filter(name => changedProducts.has(name))) {
    function walk(current, route) {
      for (const next of reverse.get(current) ?? []) {
        if (route.includes(next)) continue;
        const nextRoute = [...route, next];
        results.push(nextRoute);
        walk(next, nextRoute);
      }
    }
    walk(source, [source]);
  }
  return results;
}

function discoverGitChanges(root, base) {
  const args = ['diff', '--name-only', '--diff-filter=ACDMRTUXB', base || 'HEAD', '--'];
  let tracked = '';
  try { tracked = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    throw new Error(`Could not compare changed files against '${base || 'HEAD'}'. Ensure the Git ref exists and checkout has full history. ${error.stderr?.toString().trim() || ''}`);
  }
  let untracked = '';
  try { untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }); } catch {}
  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/)
    .map(item => item.trim().replaceAll('\\', '/'))
    .filter(Boolean)
    // CI-generated files must never be treated as source changes on the next run.
    .filter(file => !file.startsWith('target/') && !file.startsWith('node_modules/')))].sort();
}

const GLOBAL_EXACT = new Set(['.github/actions/plan-osgi-build/osgi-smart-build.mjs', 'build.xml', 'build.properties']);
function isGlobalBuildChange(file) {
  return GLOBAL_EXACT.has(file) || file.startsWith('pde-build/') ||
    file.startsWith('.github/workflows/') || file.startsWith('.github/actions/');
}

export function classifyChangedPaths(root, model, changedPaths) {
  const changedProducts = new Set();
  const changedProjects = new Set();
  const globalPaths = [];
  const ignoredPaths = [];
  for (const raw of changedPaths) {
    const file = raw.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '');
    if (!file) continue;
    if (isGlobalBuildChange(file)) { globalPaths.push(file); continue; }
    const product = file.split('/')[0];
    if (!model.dependencies.has(product)) { ignoredPaths.push(file); continue; }
    const match = file.match(/^([^/]+)\/(plugins|features)\/([^/]+)(?:\/|$)/);
    const leaf = match ? path.join(root, match[1], match[2], match[3]) : '';
    const isPlugin = Boolean(match && match[2] === 'plugins' && fs.existsSync(path.join(leaf, 'META-INF', 'MANIFEST.MF')));
    const isFeature = Boolean(match && match[2] === 'features' && fs.existsSync(path.join(leaf, 'feature.xml')));
    if (match && (isPlugin || isFeature)) {
      changedProducts.add(match[1]);
      changedProjects.add(`${match[1]}/${match[2]}/${match[3]}`);
    } else {
      // Changes outside a leaf OSGi project do not map safely to a single bundle/feature.
      ignoredPaths.push(file);
    }
  }
  return { changedProducts, changedProjects: [...changedProjects].sort(), globalPaths, ignoredPaths };
}

function nodeId(name) { return `m_${name.replace(/[^A-Za-z0-9_]/g, '_')}`; }
function graphClass(product, changedProducts, selectedProducts, fullBuild) {
  if (changedProducts.has(product)) return 'changed';
  if (selectedProducts.has(product)) return 'selected';
  if (fullBuild) return 'full';
  return 'untouched';
}
function graphMermaid(model, changedProducts, selectedProducts, fullBuild, title) {
  const lines = [`---`, `title: ${title}`, `---`, `flowchart LR`];
  for (const product of model.modules) lines.push(`  ${nodeId(product)}["${product}"]`);
  for (const [from, to] of model.edges) lines.push(`  ${nodeId(from)} --> ${nodeId(to)}`);
  lines.push('', '  classDef changed fill:#fecaca,stroke:#b91c1c,stroke-width:3px,color:#111827;');
  lines.push('  classDef selected fill:#fef3c7,stroke:#b45309,stroke-width:2px,color:#111827;');
  lines.push('  classDef full fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#111827;');
  lines.push('  classDef untouched fill:#e5e7eb,stroke:#6b7280,color:#111827;');
  for (const product of model.modules) lines.push(`  class ${nodeId(product)} ${graphClass(product, changedProducts, selectedProducts, fullBuild)}`);
  return `${lines.join('\n')}\n`;
}
function quoteDot(value) { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'); }
function graphDot(model, changedProducts, selectedProducts, fullBuild, title) {
  const lines = ['digraph NorthwindOMS {', '  rankdir=LR;', `  label="${quoteDot(title)}";`, '  labelloc="t";', '  node [shape=box, style="rounded,filled", fontname="Helvetica"];', '  edge [color="#6b7280"];'];
  const colors = {
    changed: ['#fecaca', '#b91c1c'], selected: ['#fef3c7', '#b45309'],
    full: ['#dbeafe', '#2563eb'], untouched: ['#e5e7eb', '#6b7280'],
  };
  for (const product of model.modules) {
    const [fill, border] = colors[graphClass(product, changedProducts, selectedProducts, fullBuild)];
    lines.push(`  "${product}" [label="${product}", fillcolor="${fill}", color="${border}", penwidth=2];`);
  }
  for (const [from, to] of model.edges) {
    const emphasized = selectedProducts.has(from) && selectedProducts.has(to);
    lines.push(`  "${from}" -> "${to}"${emphasized ? ' [color="#b91c1c", penwidth=2.5]' : ''};`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
function renderSvg(dotFile) {
  try {
    execFileSync('dot', ['-Tsvg', dotFile, '-o', dotFile.replace(/\.dot$/, '.svg')], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}
function writeGithubOutput(outputFile, key, value) {
  if (!outputFile) return;
  fs.appendFileSync(outputFile, `${key}=${String(value)}\n`, 'utf8');
}

export function createPlan(root, options = {}) {
  const model = discoverModel(root);
  const scenario = options.scenario ?? 'changed';
  if (!['full', 'changed'].includes(scenario)) throw new Error(`Scenario must be 'full' or 'changed', not '${scenario}'.`);
  const changedPaths = options.changedPaths ?? discoverGitChanges(root, options.base ?? 'HEAD');
  const classified = classifyChangedPaths(root, model, changedPaths);
  const affectedProducts = affectedDependents(model, classified.changedProducts);
  const fullOrder = buildOrder(model);
  const changedOrder = buildOrder(model, affectedProducts);
  const fullBuild = scenario === 'full' || classified.globalPaths.length > 0;
  return {
    scenario, fullBuild, changedPaths, changedProducts: model.modules.filter(m => classified.changedProducts.has(m)),
    affectedProducts: model.modules.filter(m => affectedProducts.has(m)),
    changedProjects: classified.changedProjects, globalPaths: classified.globalPaths,
    ignoredPaths: classified.ignoredPaths, fullOrder, changedOrder, edges: model.edges,
    dependencyPaths: allDependencyPaths(model, classified.changedProducts), model,
  };
}

function renderReport(plan, outputDir) {
  const lines = [
    '# Northwind OMS — OSGi smart-build report', '',
    `- Requested scenario: **${plan.scenario}**`,
    `- Build engine: **Eclipse PDE Build** (headless Ant; no Maven/Tycho build).`,
    '- Graph arrow direction: **dependency → dependent** (left-to-right build flow).', '',
    '## Full-build scenario', '',
    'PDE Build compiles and packages the product features in the dependency order below.', '',
    'Expected product dependency order:', '',
    ...plan.fullOrder.map((name, index) => `${index + 1}. \`${name}\``), '',
    'Full dependency graph: `full-dependency-graph.svg` (also .mmd and .dot).', '',
    '## Changed-modules scenario', '',
    '### Detected changed files', '',
    ...(plan.changedPaths.length ? plan.changedPaths.map(file => `- \`${file}\``) : ['- No changed files detected.']), '',
    '### Detected changed product modules', '',
    ...(plan.changedProducts.length ? plan.changedProducts.map(name => `- \`${name}\``) : ['- None.']), '',
  ];
  if (plan.globalPaths.length) {
    lines.push('### Build configuration changes', '', ...plan.globalPaths.map(file => `- \`${file}\` forces a full reactor build.`), '');
  }
  lines.push('### Dependency chain from changed products', '');
  if (plan.dependencyPaths.length) lines.push(...plan.dependencyPaths.map(route => `- ${route.map(name => `\`${name}\``).join(' → ')}`), '');
  else lines.push('- No downstream path found for the detected product changes.', '');
  lines.push('### Product modules selected for rebuild', '');
  if (plan.affectedProducts.length) lines.push(...plan.changedOrder.map((name, index) => `${index + 1}. \`${name}\`${plan.changedProducts.includes(name) ? ' — changed' : ' — dependent rebuild'}`), '');
  else lines.push('- No OSGi leaf project changes detected; the changed-only build can be skipped.', '');
  if (plan.ignoredPaths.length) {
    lines.push('### Paths not mapped to an OSGi project', '', ...plan.ignoredPaths.map(file => `- \`${file}\``), '');
  }
  lines.push('### Changed OSGi projects selected', '');
  if (plan.changedProjects.length) lines.push(...plan.changedProjects.map(name => `- \`${name}\``), '');
  else lines.push('- None.', '');
  lines.push('Changed dependency graph: `changed-dependency-graph.svg` (also .mmd and .dot).', '',
    '## How the build runs', '',
    '- Full scenario: the pipeline invokes Eclipse PDE Build for every product feature in dependency order.',
    '- Changed scenario: the planner selects changed product modules and all downstream dependents, orders them topologically, and invokes PDE Build for those product features.',
    '- PDE Build uses each plug-in `META-INF/MANIFEST.MF`, `build.properties`, and each feature `feature.xml`; PDE determines plug-in compilation dependencies inside each feature build.',
    '- No Maven or Tycho command is run. Existing POMs in the repository are not used by this workflow.',
    '- A clean runner needs access to the source plug-ins/features and the Eclipse base platform; unchanged bundles required as compile-time dependencies are available from the staged source workspace / Eclipse base location.', '',
    '## Scope', '',
    'The workflow builds PDE plug-in and feature artifacts. It does not create a p2 update site unless the repository adds and configures the corresponding site feature/repository project.'
  );
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = { scenario: 'changed', base: 'HEAD', output: 'target/osgi-smart-build' };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--scenario') options.scenario = argv[++i];
    else if (value === '--base') options.base = argv[++i];
    else if (value === '--output') options.output = argv[++i];
    else if (value === '--changed-path') { options.changedPaths ??= []; options.changedPaths.push(argv[++i]); }
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}
function printHelp() {
  log('Usage: node .github/actions/plan-osgi-build/osgi-smart-build.mjs [--scenario changed|full] [--base <git-ref>] [--output <dir>] [--changed-path <path>]');
  log('Changed paths can be provided repeatedly for local dry-run planning. No build is run by this planner.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  const root = process.cwd();
  const outputDir = path.resolve(root, options.output);
  fs.mkdirSync(outputDir, { recursive: true });
  const plan = createPlan(root, options);
  const fullMmd = graphMermaid(plan.model, new Set(plan.changedProducts), new Set(plan.model.modules), true, 'Northwind OMS — Full build dependency graph');
  const changedMmd = graphMermaid(plan.model, new Set(plan.changedProducts), new Set(plan.affectedProducts), false, 'Northwind OMS — Changed-module dependency graph');
  const fullDot = graphDot(plan.model, new Set(plan.changedProducts), new Set(plan.model.modules), true, 'Northwind OMS — Full build dependency graph');
  const changedDot = graphDot(plan.model, new Set(plan.changedProducts), new Set(plan.affectedProducts), false, 'Northwind OMS — Changed-module dependency graph');
  fs.writeFileSync(path.join(outputDir, 'full-dependency-graph.mmd'), fullMmd);
  fs.writeFileSync(path.join(outputDir, 'changed-dependency-graph.mmd'), changedMmd);
  fs.writeFileSync(path.join(outputDir, 'full-dependency-graph.dot'), fullDot);
  fs.writeFileSync(path.join(outputDir, 'changed-dependency-graph.dot'), changedDot);
  const hasGraphviz = renderSvg(path.join(outputDir, 'full-dependency-graph.dot')) && renderSvg(path.join(outputDir, 'changed-dependency-graph.dot'));
  fs.writeFileSync(path.join(outputDir, 'report.md'), renderReport(plan, outputDir));
  fs.writeFileSync(path.join(outputDir, 'plan.json'), JSON.stringify({
    scenario: plan.scenario, fullBuild: plan.fullBuild, changedPaths: plan.changedPaths,
    changedProducts: plan.changedProducts, affectedProducts: plan.affectedProducts,
    changedProjects: plan.changedProjects, fullOrder: plan.fullOrder, changedOrder: plan.changedOrder,
    dependencyPaths: plan.dependencyPaths, edges: plan.edges, globalPaths: plan.globalPaths, ignoredPaths: plan.ignoredPaths,
  }, null, 2));

  log(`Scenario: ${plan.scenario}${plan.globalPaths.length ? ' (promoted to full build: build configuration changed)' : ''}`);
  log(`Detected changed files: ${plan.changedPaths.length}`);
  for (const file of plan.changedPaths) log(`  - ${file}`);
  log(`Detected changed product modules: ${plan.changedProducts.join(', ') || '(none)'}`);
  log(`Selected products in dependency order: ${plan.changedOrder.join(', ') || '(none)'}`);
  log('\nFull-build dependency order:');
  plan.fullOrder.forEach((name, index) => log(`  ${String(index + 1).padStart(2, '0')}. ${name}`));
  log('\nChanged-only product order:');
  if (!plan.changedOrder.length) log('  (no product build required)');
  else plan.changedOrder.forEach((name, index) => log(`  ${String(index + 1).padStart(2, '0')}. ${name}${plan.changedProducts.includes(name) ? ' [changed]' : ' [dependent]'}`));
  log('\nChanged leaf OSGi projects selected for PDE Build:');
  for (const project of plan.changedProjects) log(`  - ${project}`);
  log(`\nReports: ${outputDir}`);
  log(`  - report.md`);
  log(`  - full-dependency-graph.svg ${hasGraphviz ? '' : '(not rendered: Graphviz unavailable)'}`);
  log('  - changed-dependency-graph.svg');

  const outputFile = process.env.GITHUB_OUTPUT;
  writeGithubOutput(outputFile, 'full_build', plan.fullBuild ? 'true' : 'false');
  writeGithubOutput(outputFile, 'has_project_changes', plan.changedProjects.length ? 'true' : 'false');
  writeGithubOutput(outputFile, 'selected_projects', plan.changedProjects.join(','));
  writeGithubOutput(outputFile, 'changed_products', plan.changedProducts.join(','));
  writeGithubOutput(outputFile, 'affected_products', plan.affectedProducts.join(','));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => { console.error(`[ERROR] ${error.message}`); process.exitCode = 2; });
}
