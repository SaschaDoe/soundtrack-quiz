#!/usr/bin/env node
/**
 * Werkzeug für die Soundtrack-Quiz-Listen.
 *
 *   node scripts/quiz.mjs check   drafts/drachen.json   # Links prüfen (existiert? einbettbar?), Dauer ergänzen
 *   node scripts/quiz.mjs publish drafts/drachen.json   # nach lists/ übernehmen + Index neu bauen
 *   node scripts/quiz.mjs publish drafts/drachen.json --push   # ... und per git committen + pushen
 *   node scripts/quiz.mjs index                         # nur lists/index.json neu bauen
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LISTS = path.join(ROOT, 'lists');

const videoIdFrom = (url) => {
  if (!url) return null;
  const s = String(url).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
};

const slugify = (s) => String(s).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, lokale Zeit

async function readJSON(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
}
async function writeJSON(file, data) {
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function oembed(id) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`;
  try {
    const res = await fetch(url);
    if (res.ok) return { ok: true, ...(await res.json()) };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Einbetten verboten' };
    if (res.status === 404 || res.status === 400) return { ok: false, reason: 'Video existiert nicht / privat' };
    return { ok: false, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: `Netzwerkfehler: ${e.message}` };
  }
}

/**
 * Fragt yt-dlp nach Dauer + Einbett-Erlaubnis. Liefert null, wenn yt-dlp nicht installiert ist,
 * { unavailable: true } wenn das Video von hier (z. B. Deutschland) nicht abspielbar ist.
 */
let ytCmd;
function ytInfo(id) {
  const candidates = ytCmd ? [ytCmd] : [['yt-dlp'], ['python', '-m', 'yt_dlp'], ['py', '-m', 'yt_dlp']];
  for (const cmd of candidates) {
    try {
      const out = execFileSync(cmd[0], [...cmd.slice(1), '--no-warnings', '--skip-download',
        '--print', '%(duration)s|%(playable_in_embed)s', `https://www.youtube.com/watch?v=${id}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
      ytCmd = cmd;
      const [dur, embed] = out.trim().split('|');
      return { duration: Math.round(Number(dur)) || null, embeddable: embed !== 'False' };
    } catch (e) {
      const err = String(e.stderr || '');
      if (/not available|unavailable|private|blocked|copyright/i.test(err)) { ytCmd = cmd; return { unavailable: true, reason: err.split('\n').find((l) => l.includes('ERROR')) || 'nicht verfügbar' }; }
      if (ytCmd) return null; // yt-dlp an sich funktioniert, anderer Fehler
    }
  }
  return null;
}

function validate(list) {
  const problems = [];
  if (!list.title) problems.push('Liste: "title" fehlt');
  if (!Array.isArray(list.tracks) || !list.tracks.length) problems.push('Liste: keine "tracks"');
  (list.tracks || []).forEach((t, i) => {
    const n = `Track ${i + 1}`;
    if (!t.work && !t.title) problems.push(`${n}: "work" oder "title" fehlt`);
    if (!videoIdFrom(t.url)) problems.push(`${n}: ungültiger YouTube-Link "${t.url}"`);
    if (t.end && Number(t.end) <= Number(t.start || 0)) problems.push(`${n}: "end" liegt vor "start"`);
  });
  return problems;
}

async function check(file, { fillDuration = true } = {}) {
  const list = await readJSON(file);
  const problems = validate(list);
  let changed = false;
  console.log(`\nPrüfe "${list.title}" (${(list.tracks || []).length} Tracks)\n`);
  for (const [i, t] of (list.tracks || []).entries()) {
    const id = videoIdFrom(t.url);
    if (!id) continue;
    const info = await oembed(id);
    const label = `${String(i + 1).padStart(2)}. ${t.work || t.title}`;
    if (!info.ok) {
      problems.push(`Track ${i + 1}: ${info.reason} (${id})`);
      console.log(`✗ ${label}\n     ${info.reason} – ${t.url}`);
      continue;
    }
    const yt = ytInfo(id);
    if (yt && yt.unavailable) {
      problems.push(`Track ${i + 1}: in diesem Land nicht abspielbar (${id})`);
      console.log(`✗ ${label}\n     Nicht abspielbar (Ländersperre/gelöscht) – ${t.url}`);
      continue;
    }
    if (yt && !yt.embeddable) {
      problems.push(`Track ${i + 1}: Einbetten verboten (${id})`);
      console.log(`✗ ${label}\n     Einbetten verboten – ${t.url}`);
      continue;
    }
    if (fillDuration && yt && yt.duration && t.duration !== yt.duration) { t.duration = yt.duration; changed = true; }
    console.log(`✓ ${label}\n     YouTube: "${info.title}" – ${info.author_name}${t.duration ? ` – ${Math.floor(t.duration / 60)}:${String(t.duration % 60).padStart(2, '0')}` : ''}`);
  }
  if (changed) { await writeJSON(file, list); console.log('\n(Dauer ergänzt und Datei gespeichert)'); }
  if (problems.length) {
    console.log(`\n${problems.length} Problem(e):\n - ${problems.join('\n - ')}`);
  } else {
    console.log('\nAlles in Ordnung.');
  }
  return { list, problems };
}

async function buildIndex() {
  await mkdir(LISTS, { recursive: true });
  const files = (await readdir(LISTS)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  const lists = [];
  for (const f of files) {
    const l = await readJSON(path.join(LISTS, f));
    lists.push({
      id: path.basename(f, '.json'),
      title: l.title,
      description: l.description || '',
      created: l.created || '',
      count: (l.tracks || []).length,
    });
  }
  lists.sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id));
  await writeJSON(path.join(LISTS, 'index.json'), { updated: new Date().toISOString(), lists });
  return lists;
}

async function publish(file, { push = false, force = false } = {}) {
  const { list, problems } = await check(file);
  const hard = problems.filter((p) => !/Netzwerkfehler/.test(p));
  if (hard.length && !force) {
    console.error('\nAbgebrochen – erst die Probleme beheben (oder mit --force trotzdem veröffentlichen).');
    process.exit(1);
  }
  list.created = list.created || today();
  list.id = list.id || `${list.created}-${slugify(list.theme || list.title)}`;
  await mkdir(LISTS, { recursive: true });
  const target = path.join(LISTS, `${list.id}.json`);
  await writeJSON(target, list);
  await writeJSON(file, list); // id/created auch im Entwurf festhalten -> erneutes Hochladen überschreibt statt dupliziert
  const lists = await buildIndex();
  console.log(`\nVeröffentlicht: lists/${list.id}.json  (insgesamt ${lists.length} Listen)`);

  if (push) {
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
    git('add', 'lists');
    try {
      git('commit', '-m', `Liste: ${list.title}`);
    } catch {
      console.log('(nichts Neues zu committen)');
    }
    git('push');
    console.log('Gepusht – GitHub Pages ist in ca. 1 Minute aktuell.');
  }
}

const [cmd, file, ...flags] = process.argv.slice(2);
const has = (f) => flags.includes(f) || file === f;
try {
  if (cmd === 'check' && file) {
    const { problems } = await check(file);
    process.exit(problems.length ? 1 : 0);
  } else if (cmd === 'publish' && file) {
    await publish(file, { push: has('--push'), force: has('--force') });
  } else if (cmd === 'index') {
    const lists = await buildIndex();
    console.log(`lists/index.json neu gebaut (${lists.length} Listen).`);
  } else {
    console.log('Benutzung:\n  node scripts/quiz.mjs check <entwurf.json>\n  node scripts/quiz.mjs publish <entwurf.json> [--push] [--force]\n  node scripts/quiz.mjs index');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error('Fehler:', e.message);
  process.exit(1);
}
