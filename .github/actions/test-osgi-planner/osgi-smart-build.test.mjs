import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const plannerUrl = new URL('../plan-osgi-build/osgi-smart-build.mjs', import.meta.url);
if (!fs.existsSync(fileURLToPath(plannerUrl))) throw new Error(`Central planner not found at ${plannerUrl.href}`);
const {
  parseManifest, splitOsgiClauses, discoverModel, buildOrder,
  affectedDependents, classifyChangedPaths, createPlan,
} = await import(pathToFileURL(fileURLToPath(plannerUrl)).href);

// When this overlay is copied into the target repository, process.cwd() is the repo root.
const projectRoot = process.env.OSGI_PROJECT_ROOT || (process.env.GITHUB_WORKSPACE || process.cwd());

test('MANIFEST.MF continuation lines are joined', () => {
  const headers = parseManifest('Bundle-SymbolicName: com.example.bundle\nImport-Package: com.example.one,\n com.example.two;version="[1.0,2.0)"\n');
  assert.equal(headers.get('bundle-symbolicname'), 'com.example.bundle');
  assert.equal(headers.get('import-package'), 'com.example.one,com.example.two;version="[1.0,2.0)"');
});

test('OSGi clauses preserve commas inside version ranges', () => {
  assert.deepEqual(splitOsgiClauses('com.a;version="[1.0,2.0)", com.b;version="[3.0,4.0)"'), [
    'com.a;version="[1.0,2.0)"', 'com.b;version="[3.0,4.0)"',
  ]);
});

test('the product graph comes from OSGi manifest dependencies', () => {
  const model = discoverModel(projectRoot);
  assert.equal(model.modules.length, 9);
  assert.ok(model.edges.some(([from, to]) => from === 'catalog' && to === 'payment'));
  assert.ok(model.edges.some(([from, to]) => from === 'orders' && to === 'reporting'));
  assert.ok(model.edges.some(([from, to]) => from === 'shipping' && to === 'notification'));
});

test('full and changed product orders respect dependency direction', () => {
  const model = discoverModel(projectRoot);
  const order = buildOrder(model);
  assert.equal(order.length, 9);
  for (const [dependency, dependent] of model.edges) {
    assert.ok(order.indexOf(dependency) < order.indexOf(dependent), `${dependency} must precede ${dependent}`);
  }
  const changed = new Set(['catalog', 'orders', 'payment']);
  const affected = affectedDependents(model, changed);
  assert.deepEqual(new Set(affected), new Set(['catalog', 'orders', 'payment', 'shipping', 'notification', 'reporting']));
  const changedOrder = buildOrder(model, affected);
  assert.ok(changedOrder.indexOf('catalog') < changedOrder.indexOf('payment'));
  assert.ok(changedOrder.indexOf('shipping') < changedOrder.indexOf('notification'));
  assert.ok(changedOrder.indexOf('payment') < changedOrder.indexOf('reporting'));
  assert.ok(changedOrder.indexOf('orders') < changedOrder.indexOf('reporting'));
});

test('the sample files map to the correct changed PDE projects', () => {
  const model = discoverModel(projectRoot);
  const files = [
    'catalog/plugins/com.northwind.oms.core/src/com/northwind/oms/core/model/Money.java',
    'orders/plugins/com.northwind.oms.gateway/src/com/northwind/oms/gateway/OrderService.java',
    'payment/plugins/com.northwind.oms.payment/src/com/northwind/oms/payment/PaymentGateway.java',
  ];
  const result = classifyChangedPaths(projectRoot, model, files);
  assert.deepEqual(result.changedProducts, new Set(['catalog', 'orders', 'payment']));
  assert.deepEqual(result.changedProjects, [
    'catalog/plugins/com.northwind.oms.core',
    'orders/plugins/com.northwind.oms.gateway',
    'payment/plugins/com.northwind.oms.payment',
  ]);
  assert.equal(result.globalPaths.length, 0);
});

test('workflow or PDE build configuration changes safely promote to a full build', () => {
  const plan = createPlan(projectRoot, {
    scenario: 'changed',
    changedPaths: ['.github/workflows/smart-build.yml'],
  });
  assert.equal(plan.fullBuild, true);
  assert.ok(plan.globalPaths.includes('.github/workflows/smart-build.yml'));
});


test('Git change discovery ignores generated target output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osgi-smart-build-test-'));
  try {
    const plugin = path.join(root, 'catalog/plugins/com.example.catalog');
    const feature = path.join(root, 'catalog/features/com.example.catalog.feature');
    fs.mkdirSync(path.join(plugin, 'META-INF'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'src'), { recursive: true });
    fs.mkdirSync(feature, { recursive: true });
    fs.writeFileSync(path.join(plugin, 'META-INF/MANIFEST.MF'), [
      'Manifest-Version: 1.0',
      'Bundle-ManifestVersion: 2',
      'Bundle-SymbolicName: com.example.catalog',
      'Bundle-Version: 1.0.0',
      'Export-Package: com.example.catalog',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(plugin, 'src/Example.java'), 'package com.example.catalog;\nclass Example {}\n');
    fs.writeFileSync(path.join(feature, 'feature.xml'), '<feature id="com.example.catalog.feature" version="1.0.0"/>\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'ci-test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'OSGi Planner Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' });

    fs.appendFileSync(path.join(plugin, 'src/Example.java'), '// changed\n');
    fs.mkdirSync(path.join(root, 'target/osgi-smart-build'), { recursive: true });
    fs.writeFileSync(path.join(root, 'target/osgi-smart-build/report.md'), 'generated\n');

    const plan = createPlan(root, { scenario: 'changed', base: 'HEAD' });
    assert.deepEqual(plan.changedPaths, ['catalog/plugins/com.example.catalog/src/Example.java']);
    assert.deepEqual(plan.changedProducts, ['catalog']);
    assert.deepEqual(plan.changedProjects, ['catalog/plugins/com.example.catalog']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
