/* Canonical deterministic merge engine — JavaScript mirror of app/sync.py.
 * Keep the two in sync: given identical op sets both must produce the same
 * total order, deletions and conflicts.
 */
(function (global) {
  'use strict';

  const WRITE_OPS = new Set(['add', 'move', 'update', 'remove', 'restore']);

  function int(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }

  function vecLe(a, b) {
    a = a || {};
    b = b || {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (int(a[k]) > int(b[k])) return false;
    }
    return true;
  }

  function vecConcurrent(a, b) {
    return !vecLe(a, b) && !vecLe(b, a);
  }

  function opSortKey(o) {
    return [int(o.lamport), String(o.client_id || ''), String(o.id || '')];
  }

  function sortedOps(ops) {
    return ops.slice().sort((a, b) => {
      const ka = opSortKey(a);
      const kb = opSortKey(b);
      for (let i = 0; i < 3; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    });
  }

  // Earlier writes on the same entity whose vector is incomparable with incoming.
  function opBlocks(ordered, idx, incoming) {
    const out = [];
    for (let i = 0; i < idx; i++) {
      const prior = ordered[i];
      if (
        prior.target === incoming.target &&
        prior.entity_id === incoming.entity_id &&
        WRITE_OPS.has(prior.op) &&
        vecConcurrent(prior.vector, incoming.vector)
      ) {
        out.push(prior);
      }
    }
    return out;
  }

  function reduceState(allOps) {
    const scenes = new Map(); // id -> record
    const cues = new Map();
    // deduplicate replayed ops by id, then apply in the deterministic order
    const unique = new Map();
    for (const o of allOps) unique.set(o.id, o);
    const ordered = sortedOps([...unique.values()]);

    for (let idx = 0; idx < ordered.length; idx++) {
      const o = ordered[idx];
      const target = o.target;
      const kind = o.op;
      const eid = o.entity_id;
      const p = o.payload || {};

      if (kind === 'add') {
        if (opBlocks(ordered, idx, o).length > 0) continue; // duplicate concurrent add loses
        if (target === 'scene') {
          scenes.set(eid, {
            id: eid,
            name: p.name != null ? p.name : '未命名场次',
            order: Number(p.order != null ? p.order : 0),
            created_lamport: int(o.lamport),
            client_id: o.client_id || '',
            deleted: false,
          });
        } else if (target === 'cue') {
          cues.set(eid, {
            id: eid,
            scene_id: p.scene_id || '',
            name: p.name != null ? p.name : '新动作/音效',
            kind: p.kind === 'sound' ? 'sound' : 'action',
            start: Number(p.start != null ? p.start : 0),
            duration: Number(p.duration != null ? p.duration : 5),
            created_lamport: int(o.lamport),
            client_id: o.client_id || '',
            deleted: false,
          });
        }
        continue;
      }

      const table = target === 'scene' ? scenes : target === 'cue' ? cues : null;
      if (!table) continue;
      const rec = table.get(eid);

      if (kind === 'remove') {
        if (!rec) continue;
        // Deterministic: concurrent remove always wins over move/update.
        rec.deleted = true;
        continue;
      }

      if (kind === 'restore') {
        const blockers = opBlocks(ordered, idx, o);
        if (!rec || blockers.some((b) => b.op === 'remove')) continue;
        rec.deleted = false;
        if (p.name != null) rec.name = p.name;
        if (target === 'scene' && p.order != null) rec.order = Number(p.order);
        if (target === 'cue') {
          if (p.start != null) rec.start = Number(p.start);
          if (p.duration != null) rec.duration = Number(p.duration);
          if (p.scene_id != null) rec.scene_id = p.scene_id;
        }
        continue;
      }

      // move / update
      const blockers = opBlocks(ordered, idx, o);
      if (blockers.some((b) => b.op === 'remove')) continue;
      if (!rec || rec.deleted) continue; // never resurrect without explicit restore

      if (kind === 'move') {
        if (target === 'scene') {
          if (p.order != null) rec.order = Number(p.order);
        } else {
          if (p.start != null) rec.start = Number(p.start);
          if (p.scene_id != null) rec.scene_id = p.scene_id;
        }
      } else if (kind === 'update') {
        if (p.name != null) rec.name = p.name;
        if (target === 'cue') {
          if (p.kind === 'sound' || p.kind === 'action') rec.kind = p.kind;
          if (p.duration != null) rec.duration = Number(p.duration);
          if (p.start != null) rec.start = Number(p.start);
          if (p.scene_id != null) rec.scene_id = p.scene_id;
        }
        if (target === 'scene' && p.order != null) rec.order = Number(p.order);
      }
    }

    return assemble(ordered, scenes, cues);
  }

  function detectConflicts(ordered) {
    const groups = new Map();
    for (const o of ordered) {
      if (!WRITE_OPS.has(o.op)) continue;
      const key = o.target + ':' + o.entity_id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    }

    const conflicts = {};
    for (const [key, group] of groups.entries()) {
      const sorted = group.slice().sort((a, b) => {
        const ka = opSortKey(a);
        const kb = opSortKey(b);
        for (let i = 0; i < 3; i++) {
          if (ka[i] < kb[i]) return -1;
          if (ka[i] > kb[i]) return 1;
        }
        return 0;
      });
      const terminal = sorted[sorted.length - 1];
      const concurrent = sorted.slice(0, -1).filter((o) => vecConcurrent(o.vector, terminal.vector));
      const unresolved = concurrent.filter((o) => !vecLe(o.vector, terminal.vector));
      if (unresolved.length === 0) continue;

      const members = sorted.filter(
        (m) => m === terminal || unresolved.some((u) => u.id === m.id)
      );
      const removes = members.filter((m) => m.op === 'remove');
      const winner = removes.length > 0 ? removes[removes.length - 1] : terminal;
      const [target, eid] = key.split(':');
      const kindsSet = new Set(members.map((m) => m.op));

      conflicts[key] = {
        target,
        entity_id: eid,
        kinds: [...kindsSet].sort(),
        winner_op_id: winner.id,
        winner_client_id: winner.client_id,
        lamport: members.reduce((mx, m) => Math.max(mx, int(m.lamport)), 0),
        ops: members.map((m) => ({
          op_id: m.id,
          client_id: m.client_id,
          kind: m.op,
          lamport: int(m.lamport),
          payload: m.payload || {},
        })),
      };
    }
    return conflicts;
  }

  function assemble(ordered, scenes, cues) {
    const sceneRecs = [...scenes.values()].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      if (a.created_lamport !== b.created_lamport) return a.created_lamport - b.created_lamport;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const cuesByScene = {};
    const orphans = [];
    for (const c of cues.values()) {
      if (c.deleted) continue;
      const scene = scenes.get(c.scene_id);
      if (scene && !scene.deleted) {
        (cuesByScene[c.scene_id] = cuesByScene[c.scene_id] || []).push(c);
      } else {
        orphans.push(c);
    }
    }
    const cueCmp = (a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.created_lamport !== b.created_lamport) return a.created_lamport - b.created_lamport;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
    for (const k of Object.keys(cuesByScene)) cuesByScene[k].sort(cueCmp);
    orphans.sort(cueCmp);

    return {
      scenes: sceneRecs.filter((s) => !s.deleted),
      deleted_scenes: sceneRecs.filter((s) => s.deleted),
      cues_by_scene: cuesByScene,
      orphans,
      deleted_cues: [...cues.values()].filter((c) => c.deleted).sort(cueCmp),
      conflicts: detectConflicts(ordered),
      op_count: ordered.length,
    };
  }

  global.Sync = {
    vecLe,
    vecConcurrent,
    opSortKey,
    sortedOps,
    reduceState,
    detectConflicts,
  };
})(window);
