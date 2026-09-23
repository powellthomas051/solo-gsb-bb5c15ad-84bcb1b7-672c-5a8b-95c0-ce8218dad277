// Cross-implementation check: run the same scenarios through the JS mirror
// and compare with Python-produced signatures (passed via JSON file).
const fs = require('fs');
const path = require('path');

const sandbox = {};
global.window = sandbox;
const code = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'sync.js'), 'utf8');
new Function('window', code)(sandbox);
const Sync = sandbox.Sync;

function signature(st) {
  const allCues = [];
  for (const sid of Object.keys(st.cues_by_scene)) allCues.push(...st.cues_by_scene[sid]);
  allCues.push(...st.orphans, ...st.deleted_cues);
  return {
    scene_order: st.scenes.concat(st.deleted_scenes)
      .sort((a, b) => (a.order - b.order) || (a.created_lamport - b.created_lamport) || (a.id < b.id ? -1 : 1))
      .map((s) => [s.id, s.order, s.deleted]),
    cues: allCues
      .map((c) => [c.id, c.scene_id, c.start, c.duration, c.deleted])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    conflicts: Object.fromEntries(Object.entries(st.conflicts).map(([k, v]) => [
      k,
      { kinds: v.kinds, winner: v.winner_op_id, n: v.ops.length },
    ])),
  };
}

let failures = 0;
const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'py_report.json'), 'utf8'));
for (const [name, ops] of Object.entries(scenarios)) {
  const st = Sync.reduceState(ops);
  const jsSig = signature(st);
  const pySig = report[name];
  if (JSON.stringify(jsSig) !== JSON.stringify(pySig)) {
    failures++;
    console.error('MISMATCH in', name);
    console.error('PY:', JSON.stringify(pySig));
    console.error('JS:', JSON.stringify(jsSig));
  } else {
    console.log('match:', name);
  }
}
process.exit(failures ? 1 : 0);
