// Launchpad Mini -> OBS + SPX-GC bridge
//
// Grid rows/cols are 1-based, row 1 = top row of the 8x8 pad grid.
// Top half = OBS, bottom half = SPX.
//   Row 1, pads 1-8 ...... OBS scenes 1-8 -> Preview (Studio mode)
//   Row 2, pads 1-8 ...... OBS scenes 1-8 -> Program (switch immediately)
//   Row 3, pads 5-8 ...... OBS quick transitions 1-4 (Preview -> Program with that transition)
// Scenes follow the OBS scene list order, top first.
//   Rows 6-7 ............. SPX select rundown item 1-16
//   Row 8, pad 1 ......... SPX Play (focused item)
//   Row 8, pad 2 ......... SPX Stop (focused item)
//   Row 8, pads 4-5 ...... SPX Previous / Next item
//   Row 8, pad 8 ......... SPX Panic (clear all layers)
//
// Usage:  node index.js            run
//         node index.js --list     list MIDI ports
//         node index.js --debug    also log raw MIDI input

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { OBSWebSocket } from 'obs-websocket-js';

const require = createRequire(import.meta.url);
const midi = require('@julusian/midi');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG = process.argv.includes('--debug');

// ---------------------------------------------------------------- config

const defaults = {
  obs: { url: 'ws://127.0.0.1:4455', password: '', scenes: [], transitions: [] },
  spx: { url: 'http://localhost:5656', apikey: '' },
  midi: { input: '', output: '' },
};
const configFile = path.join(__dirname, 'config.json');
const fileCfg = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
const cfg = {
  obs: { ...defaults.obs, ...fileCfg.obs },
  spx: { ...defaults.spx, ...fileCfg.spx },
  midi: { ...defaults.midi, ...fileCfg.midi },
};
if (process.env.OBS_PASSWORD) cfg.obs.password = process.env.OBS_PASSWORD;

const LAYOUT = {
  preview: { row: 1, cols: [1, 2, 3, 4, 5, 6, 7, 8] },
  program: { row: 2, cols: [1, 2, 3, 4, 5, 6, 7, 8] },
  transitions: { row: 3, cols: [5, 6, 7, 8] },
  spxItems: { rows: [6, 7], cols: [1, 2, 3, 4, 5, 6, 7, 8] },
  spxPlay: { row: 8, col: 1 },
  spxStop: { row: 8, col: 2 },
  spxPrev: { row: 8, col: 4 },
  spxNext: { row: 8, col: 5 },
  spxPanic: { row: 8, col: 8 },
};

// ---------------------------------------------------------------- launchpad models

// Mk3: Programmer mode, note = (9 - row) * 10 + col, LED colour = palette index.
// Mk1/Mk2: X-Y layout, note = (row - 1) * 16 + (col - 1), LED colour = red + 16 * green + 12.
const MODELS = {
  mk3: {
    match: /LPMiniMK3/i,
    // The second USB interface ("MIDIIN2/MIDIOUT2" on Windows) is the MIDI port used in Programmer mode.
    preferIn: /MIDIIN2/i,
    preferOut: /MIDIOUT2/i,
    toNote: (row, col) => (9 - row) * 10 + col,
    fromNote: (n) => ({ row: 9 - Math.floor(n / 10), col: n % 10 }),
    init: (out) => out.sendMessage([0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x0e, 0x01, 0xf7]), // Programmer mode
    clear: (out, api) => { for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) api.led(r, c, 'off'); },
    exit: (out) => out.sendMessage([0xf0, 0x00, 0x20, 0x29, 0x02, 0x0d, 0x0e, 0x00, 0xf7]), // back to Live mode
    colors: {
      off: 0, dimWhite: 1, white: 3, red: 5, dimRed: 7, orange: 9, dimOrange: 11, yellow: 13, dimYellow: 15,
      green: 21, dimGreen: 23, blue: 45, dimBlue: 47, purple: 49, dimPurple: 51,
    },
  },
  mk1: {
    match: /Launchpad Mini/i,
    preferIn: null,
    preferOut: null,
    toNote: (row, col) => (row - 1) * 16 + (col - 1),
    fromNote: (n) => ({ row: Math.floor(n / 16) + 1, col: (n % 16) + 1 }),
    init: (out) => out.sendMessage([0xb0, 0x00, 0x00]), // reset
    clear: (out) => out.sendMessage([0xb0, 0x00, 0x00]),
    exit: (out) => out.sendMessage([0xb0, 0x00, 0x00]),
    colors: {
      off: 12, dimWhite: 29, white: 63, red: 15, dimRed: 13, orange: 47, dimOrange: 29, yellow: 62, dimYellow: 29,
      green: 60, dimGreen: 28, blue: 63, dimBlue: 29, purple: 47, dimPurple: 29,
    },
  },
};

// Colour scheme
const COLORS = {
  sceneIdle: 'dimYellow',
  previewActive: 'green',   // tally convention: green = preview
  programActive: 'red',     //                   red   = program / on air
  transIdle: 'dimBlue',
  transRunning: 'blue',
  spxPlay: 'dimGreen',
  spxOnAir: 'green',
  spxStop: 'dimOrange',
  spxStopPressed: 'orange',
  spxNav: 'dimWhite',
  spxNavPressed: 'white',
  spxItem: 'dimPurple',
  spxItemFocused: 'purple',
  panic: 'dimRed',
  panicPressed: 'red',
  missing: 'off',
};

function listPorts() {
  const i = new midi.Input(), o = new midi.Output();
  console.log('MIDI inputs:');
  for (let k = 0; k < i.getPortCount(); k++) console.log(`  [${k}] ${i.getPortName(k)}`);
  console.log('MIDI outputs:');
  for (let k = 0; k < o.getPortCount(); k++) console.log(`  [${k}] ${o.getPortName(k)}`);
  i.closePort(); o.closePort();
}

function findPort(port, wanted, model, prefer) {
  const names = [];
  for (let k = 0; k < port.getPortCount(); k++) names.push(port.getPortName(k));
  if (wanted) return names.findIndex((n) => n.toLowerCase().includes(wanted.toLowerCase()));
  const candidates = names.map((n, k) => ({ n, k })).filter(({ n }) => model.match.test(n));
  if (!candidates.length) return -1;
  const preferred = prefer && candidates.find(({ n }) => prefer.test(n));
  return (preferred || candidates[0]).k;
}

function openLaunchpad(onPress) {
  const input = new midi.Input();
  const output = new midi.Output();

  let model = null, inIdx = -1, outIdx = -1;
  for (const m of Object.values(MODELS)) {
    inIdx = findPort(input, cfg.midi.input, m, m.preferIn);
    outIdx = findPort(output, cfg.midi.output, m, m.preferOut);
    if (inIdx >= 0 && outIdx >= 0) { model = m; break; }
  }
  if (!model) {
    console.error('Launchpad Mini not found. Is it plugged in and not in use by another app?');
    listPorts();
    process.exit(1);
  }

  input.openPort(inIdx);
  output.openPort(outIdx);
  console.log(`MIDI in:  ${input.getPortName(inIdx)}`);
  console.log(`MIDI out: ${output.getPortName(outIdx)}`);

  const api = {
    led(row, col, color) {
      const v = model.colors[color] ?? model.colors.off;
      output.sendMessage([0x90, model.toNote(row, col), v]);
    },
    close() {
      model.exit(output);
      input.closePort();
      output.closePort();
    },
  };

  input.on('message', (_dt, msg) => {
    if (DEBUG) console.log('MIDI', msg);
    const [status, note, vel] = msg;
    const type = status & 0xf0;
    if (type !== 0x90 || vel === 0) return; // grid pads: note-on with velocity > 0 = press
    const { row, col } = model.fromNote(note);
    if (row >= 1 && row <= 8 && col >= 1 && col <= 8) onPress(row, col);
  });

  model.init(output);
  model.clear(output, api);
  return api;
}

// ---------------------------------------------------------------- SPX

let spxOnAir = false;
let spxFocus = -1; // 0-based rundown position we last selected (-1 = unknown)

async function spxCall(endpoint) {
  const url = new URL(`/api/v1/${endpoint}`, cfg.spx.url);
  if (cfg.spx.apikey) url.searchParams.set('apikey', cfg.spx.apikey);
  try {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (body.error) console.warn(`SPX ${endpoint}: ${body.error}`);
    return !body.error && res.ok;
  } catch (err) {
    console.warn(`SPX ${endpoint} failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------- OBS

const obs = new OBSWebSocket();
let obsConnected = false;
let scenes = [];         // scene names mapped to pads 1-8
let transitions = [];    // transition names mapped to pads 1-4
let currentScene = '';
let currentPreview = '';
let studioMode = false;
let currentTransition = '';
let runningTransition = ''; // quick transition in progress

async function refreshObsState() {
  const sl = await obs.call('GetSceneList');
  // obs-websocket lists scenes bottom-up; reverse to match the OBS UI (top first).
  const all = [...sl.scenes].sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
  scenes = cfg.obs.scenes.length ? cfg.obs.scenes : all.slice(0, 8);
  currentScene = sl.currentProgramSceneName;
  currentPreview = sl.currentPreviewSceneName || '';
  studioMode = (await obs.call('GetStudioModeEnabled')).studioModeEnabled;

  const tl = await obs.call('GetSceneTransitionList');
  const allT = tl.transitions.map((t) => t.transitionName);
  transitions = cfg.obs.transitions.length ? cfg.obs.transitions : allT.slice(0, 4);
  currentTransition = tl.currentSceneTransitionName;
}

async function connectObs() {
  try {
    await obs.connect(cfg.obs.url, cfg.obs.password || undefined);
    obsConnected = true;
    connectObs.warned = false;
    await refreshObsState();
    console.log(`OBS connected. Scenes: ${scenes.join(', ') || '(none)'}`);
    console.log(`OBS transitions: ${transitions.join(', ') || '(none)'}`);
    render();
  } catch (err) {
    obsConnected = false;
    if (!connectObs.warned) console.warn(`OBS connect failed (${err.message}). Retrying every 5s...`);
    connectObs.warned = true;
    render();
    setTimeout(connectObs, 5000);
  }
}

obs.on('ConnectionClosed', () => {
  if (!obsConnected) return;
  obsConnected = false;
  console.warn('OBS disconnected. Reconnecting...');
  render();
  setTimeout(connectObs, 2000);
});
obs.on('CurrentProgramSceneChanged', (e) => { currentScene = e.sceneName; render(); });
obs.on('CurrentPreviewSceneChanged', (e) => { currentPreview = e.sceneName; render(); });
obs.on('StudioModeStateChanged', (e) => {
  studioMode = e.studioModeEnabled;
  if (!studioMode) currentPreview = '';
  refreshObsState().then(render).catch(() => {});
});
obs.on('CurrentSceneTransitionChanged', (e) => { if (!runningTransition) currentTransition = e.transitionName; });
for (const ev of ['SceneListChanged', 'SceneNameChanged', 'SceneCreated', 'SceneRemoved']) {
  obs.on(ev, () => refreshObsState().then(render).catch(() => {}));
}

async function obsCall(req, data) {
  if (!obsConnected) return console.warn('OBS not connected');
  try { await obs.call(req, data); } catch (err) { console.warn(`OBS ${req} failed: ${err.message}`); }
}

// Like OBS's Quick Transitions: run Preview -> Program with the given transition,
// then put the previously selected transition back.
async function quickTransition(name) {
  if (!obsConnected) return console.warn('OBS not connected');
  if (!studioMode) return console.warn('Quick transitions need Studio mode on in OBS');
  if (runningTransition) return;
  const previous = currentTransition;
  runningTransition = name;
  render();
  const finish = async () => {
    if (!runningTransition) return;
    obs.off('SceneTransitionEnded', finish);
    clearTimeout(fallback);
    if (previous && previous !== name) await obsCall('SetCurrentSceneTransition', { transitionName: previous });
    runningTransition = '';
    render();
  };
  const fallback = setTimeout(finish, 10000);
  try {
    if (name !== previous) await obs.call('SetCurrentSceneTransition', { transitionName: name });
    obs.on('SceneTransitionEnded', finish);
    await obs.call('TriggerStudioModeTransition');
  } catch (err) {
    console.warn(`OBS quick transition failed: ${err.message}`);
    await finish();
  }
}

// ---------------------------------------------------------------- pads

let lp;

function render() {
  if (!lp) return;
  // Both scene rows show the same tally: red = program, green = preview.
  const sceneColor = (name) =>
    !name ? COLORS.missing
      : name === currentScene ? COLORS.programActive
      : name === currentPreview ? COLORS.previewActive
      : COLORS.sceneIdle;
  LAYOUT.preview.cols.forEach((col, i) => {
    // Preview row is dark when Studio mode is off.
    lp.led(LAYOUT.preview.row, col, sceneColor(obsConnected && studioMode ? scenes[i] : undefined));
  });
  LAYOUT.program.cols.forEach((col, i) => {
    lp.led(LAYOUT.program.row, col, sceneColor(obsConnected ? scenes[i] : undefined));
  });
  LAYOUT.transitions.cols.forEach((col, i) => {
    const name = obsConnected && studioMode ? transitions[i] : undefined;
    lp.led(LAYOUT.transitions.row, col, !name ? COLORS.missing : name === runningTransition ? COLORS.transRunning : COLORS.transIdle);
  });

  spxItemPads().forEach(({ row, col }, i) => lp.led(row, col, i === spxFocus ? COLORS.spxItemFocused : COLORS.spxItem));
  lp.led(LAYOUT.spxPlay.row, LAYOUT.spxPlay.col, spxOnAir ? COLORS.spxOnAir : COLORS.spxPlay);
  lp.led(LAYOUT.spxStop.row, LAYOUT.spxStop.col, COLORS.spxStop);
  lp.led(LAYOUT.spxPrev.row, LAYOUT.spxPrev.col, COLORS.spxNav);
  lp.led(LAYOUT.spxNext.row, LAYOUT.spxNext.col, COLORS.spxNav);
  lp.led(LAYOUT.spxPanic.row, LAYOUT.spxPanic.col, COLORS.panic);
}

function spxItemPads() {
  return LAYOUT.spxItems.rows.flatMap((row) => LAYOUT.spxItems.cols.map((col) => ({ row, col })));
}

function flash(row, col, color) {
  lp.led(row, col, color);
  setTimeout(render, 200);
}

// Select a rundown item by position: jump to the first item, then step down.
// (SPX item IDs are timestamps, so position is what matches the pads.)
async function spxFocusIndex(index) {
  if (!(await spxCall('rundown/focusFirst'))) return;
  for (let k = 0; k < index; k++) await spxCall('rundown/focusNext');
  spxFocus = index;
}

async function onPress(row, col) {
  if (row === LAYOUT.preview.row && LAYOUT.preview.cols.includes(col)) {
    const name = scenes[LAYOUT.preview.cols.indexOf(col)];
    if (!name) return;
    if (!studioMode) return console.warn('Preview needs Studio mode on in OBS');
    console.log(`Preview -> ${name}`);
    await obsCall('SetCurrentPreviewScene', { sceneName: name });
    return;
  }
  if (row === LAYOUT.program.row && LAYOUT.program.cols.includes(col)) {
    const name = scenes[LAYOUT.program.cols.indexOf(col)];
    if (name) { console.log(`Program -> ${name}`); await obsCall('SetCurrentProgramScene', { sceneName: name }); }
    return;
  }
  if (row === LAYOUT.transitions.row && LAYOUT.transitions.cols.includes(col)) {
    const name = transitions[LAYOUT.transitions.cols.indexOf(col)];
    if (name) { console.log(`Quick transition -> ${name}`); await quickTransition(name); }
    return;
  }

  const itemIndex = spxItemPads().findIndex((p) => p.row === row && p.col === col);
  if (itemIndex >= 0) {
    console.log(`SPX select item ${itemIndex + 1}`);
    await spxFocusIndex(itemIndex);
    render();
    return;
  }
  if (row === LAYOUT.spxPlay.row && col === LAYOUT.spxPlay.col) {
    console.log('SPX play');
    if (await spxCall('item/play')) spxOnAir = true;
    render();
    return;
  }
  if (row === LAYOUT.spxStop.row && col === LAYOUT.spxStop.col) {
    console.log('SPX stop');
    flash(row, col, COLORS.spxStopPressed);
    if (await spxCall('item/stop')) spxOnAir = false;
    return;
  }
  if (row === LAYOUT.spxPrev.row && col === LAYOUT.spxPrev.col) {
    console.log('SPX previous item');
    flash(row, col, COLORS.spxNavPressed);
    if ((await spxCall('rundown/focusPrevious')) && spxFocus > 0) spxFocus--;
    return;
  }
  if (row === LAYOUT.spxNext.row && col === LAYOUT.spxNext.col) {
    console.log('SPX next item');
    flash(row, col, COLORS.spxNavPressed);
    if ((await spxCall('rundown/focusNext')) && spxFocus >= 0) spxFocus++;
    return;
  }
  if (row === LAYOUT.spxPanic.row && col === LAYOUT.spxPanic.col) {
    console.log('SPX PANIC');
    lp.led(row, col, COLORS.panicPressed);
    await spxCall('panic');
    spxOnAir = false;
    setTimeout(render, 300);
  }
}

// ---------------------------------------------------------------- main

if (process.argv.includes('--list')) {
  listPorts();
  process.exit(0);
}

lp = openLaunchpad((row, col) => {
  if (DEBUG) console.log(`Pad row ${row} col ${col}`);
  onPress(row, col).catch((err) => console.error(err));
});
render();
connectObs();

function shutdown() {
  console.log('\nShutting down.');
  try { lp.close(); } catch {}
  try { obs.disconnect(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('Launchpad bridge running. Ctrl+C to quit.');
