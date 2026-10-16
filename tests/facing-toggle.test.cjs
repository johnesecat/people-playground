'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('spawn facing is one toggle that selects the spawn key used by Spawn', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.match(html, /data-facing="left"[^>]*aria-pressed="true"/);
    assert.match(html, /data-facing="right"[^>]*aria-pressed="false"/);
    assert.match(html, /data-spawn>Spawn</);
    assert.doesNotMatch(html, /data-action="spawnLeft"|data-action="spawnRight"/);
    const js = fs.readFileSync('TemplateData/mobile-controls.js', 'utf8');
    assert.match(js, /spawnLeft' : 'spawnRight'/);
    assert.match(js, /time: 'Space'[\s\S]*spawnLeft: 'KeyQ', spawnRight: 'KeyE'/);
    const css = fs.readFileSync('TemplateData/style.css', 'utf8');
    assert.match(css, /facing-toggle button\[aria-pressed="true"\][^}]*border: 3px solid/);
});
