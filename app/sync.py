"""Canonical deterministic merge engine.

Every client and the server share exactly this logic (the browser ships a
line-for-line JavaScript mirror in static/js/sync.js).  Given the same set of
operations, everybody computes the same timeline order and the same conflicts.

Operation model
---------------
op = {
  "id":        "<client-id>-<counter>   globally unique",
  "play_id":   "...",
  "client_id": "author",
  "lamport":   42,                       # Lamport logical clock
  "vector":    {"a": 7, "b": 3},         # version vector on the author at send time
  "target":    "scene" | "cue",
  "op":        "add" | "move" | "update" | "remove" | "restore",
  "entity_id": "...",
  "payload":   {...},
}

Causality is decided by version vectors (v <= w).  When two ops on the same
entity are concurrent (vectors incomparable) and both write state, that is a
conflict the user can inspect.  Resolution is deterministic regardless:

  * total order tie-break: (lamport, client_id, op id)
  * among concurrent writes on one entity the winner is the one later in that
    total order, EXCEPT "remove" always wins over a concurrent non-remove
    (a deletion is never silently undone by a concurrent edit/move).
"""
from __future__ import annotations

from typing import Any

# ---- version vectors -------------------------------------------------------

def vec_le(a: dict[str, str | int], b: dict[str, str | int]) -> bool:
    """True iff vector a happens-before-or-equal vector b."""
    keys = set(a) | set(b)
    return all(int(a.get(k, 0)) <= int(b.get(k, 0)) for k in keys)


def vec_concurrent(a: dict[str, str | int], b: dict[str, str | int]) -> bool:
    return not vec_le(a, b) and not vec_le(b, a)


# ---- ordering --------------------------------------------------------------

def op_sort_key(op: dict[str, Any]) -> tuple[Any, ...]:
    return (int(op.get("lamport", 0)), str(op.get("client_id", "")), str(op.get("id", "")))


def sorted_ops(ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(ops, key=op_sort_key)


_WRITE_OPS = {"add", "move", "update", "remove", "restore"}


def _op_blocks(ordered: list[dict[str, Any]], idx: int, incoming: dict[str, Any]) -> list[dict[str, Any]]:
    """Earlier ops that causally block ``incoming``.

    Returns prior ops (in total order) whose vector is *not* <= incoming.vector.
    If the most recent such op on the entity is a removal, the incoming op is
    discarded: a concurrent move/edit must never resurrect a deleted element.
    Only an explicit "restore" (created after the user saw the tombstone,
    hence causally after the remove) passes through.
    """
    target = incoming["target"]
    entity_id = incoming["entity_id"]
    out: list[dict[str, Any]] = []
    for prior in ordered[:idx]:
        if (
            prior["target"] == target
            and prior["entity_id"] == entity_id
            and prior["op"] in _WRITE_OPS
            and vec_concurrent(prior.get("vector", {}), incoming.get("vector", {}))
        ):
            out.append(prior)
    return out


# ---- reduction -------------------------------------------------------------

def reduce_state(ops: list[dict[str, Any]]) -> dict[str, Any]:
    """Apply all ops deterministically. Returns scenes, cues and conflict map.

    Scenes: {id: record, ...} where record carries a "deleted" tombstone flag.
    Cues:   {id: record, ...} likewise; cues keep their scene_id.
    """
    scenes: dict[str, dict[str, Any]] = {}
    cues: dict[str, dict[str, Any]] = {}

    # Deduplicate by op id (replayed logs / bulk flushes may repeat an op),
    # then apply in the deterministic total order.
    unique: dict[str, dict[str, Any]] = {}
    for o in ops:
        unique[o["id"]] = o
    ordered = sorted_ops(list(unique.values()))

    for idx, o in enumerate(ordered):
        target = o.get("target")
        kind = o.get("op")
        eid = o.get("entity_id")
        p = o.get("payload", {}) or {}

        if kind == "add":
            blockers = _op_blocks(ordered, idx, o)
            # A concurrent add with the same entity_id (id-collision) loses:
            # skip it, conflict machinery flags it.
            if blockers:
                continue
            if target == "scene":
                scenes[eid] = {
                    "id": eid,
                    "name": p.get("name", "未命名场次"),
                    "order": float(p.get("order", 0)),
                    "created_lamport": int(o.get("lamport", 0)),
                    "client_id": o.get("client_id", ""),
                    "deleted": False,
                }
            elif target == "cue":
                cues[eid] = {
                    "id": eid,
                    "scene_id": p.get("scene_id", ""),
                    "name": p.get("name", "新动作/音效"),
                    "kind": p.get("kind", "action"),  # action | sound
                    "start": float(p.get("start", 0)),
                    "duration": float(p.get("duration", 5)),
                    "created_lamport": int(o.get("lamport", 0)),
                    "client_id": o.get("client_id", ""),
                    "deleted": False,
                }
            continue

        table = scenes if target == "scene" else cues if target == "cue" else None
        if table is None:
            continue
        rec = table.get(eid)

        if kind == "remove":
            blockers = _op_blocks(ordered, idx, o)
            if rec is None:
                if blockers:
                    # Tombstone for an entity added by a concurrent op we drop:
                    # still record the delete so it deterministically wins.
                    pass
                continue
            # Deterministic rule: concurrent removal against an existing
            # record always applies (remove beats concurrent move/update).
            rec["deleted"] = True
            continue

        if kind == "restore":
            # Restore is normally causally after the remove (user saw the
            # tombstone), so blockers is empty. A concurrent restore vs remove
            # is pathological and discarded in favour of the tombstone.
            blockers = _op_blocks(ordered, idx, o)
            if rec is None or any(b["op"] == "remove" for b in blockers):
                continue
            rec["deleted"] = False
            # A restore may also revive payload fields.
            if "name" in p:
                rec["name"] = p["name"]
            if target == "scene" and "order" in p:
                rec["order"] = float(p["order"])
            if target == "cue":
                if "start" in p:
                    rec["start"] = float(p["start"])
                if "duration" in p:
                    rec["duration"] = float(p["duration"])
                if "scene_id" in p:
                    rec["scene_id"] = p["scene_id"]
            continue

        # move / update on a live entity
        blockers = _op_blocks(ordered, idx, o)
        blocked_by_remove = any(b["op"] == "remove" for b in blockers)

        if rec is None or rec.get("deleted"):
            # Entity missing or tombstoned. If a concurrent remove exists the
            # delete-wins rule discards us. Causally-later edits on a tombstone
            # without having seen the entity are also ignored (no resurrection
            # without explicit restore).
            continue
        if blocked_by_remove:
            continue

        if kind == "move":
            if target == "scene":
                if "order" in p:
                    rec["order"] = float(p["order"])
            else:
                if "start" in p:
                    rec["start"] = float(p["start"])
                if "scene_id" in p:
                    rec["scene_id"] = p["scene_id"]
        elif kind == "update":
            if "name" in p:
                rec["name"] = p["name"]
            if target == "cue":
                if "kind" in p:
                    rec["kind"] = p["kind"]
                if "duration" in p:
                    rec["duration"] = float(p["duration"])
                if "start" in p:
                    rec["start"] = float(p["start"])
                if "scene_id" in p:
                    rec["scene_id"] = p["scene_id"]
            if target == "scene" and "order" in p:
                rec["order"] = float(p["order"])

    return _assemble(ordered, scenes, cues)


def _assemble(ordered, scenes: dict, cues: dict) -> dict[str, Any]:
    # Scene ordering: explicit float order, tie-break by creation lamport, then id.
    scene_list = sorted(
        scenes.values(),
        key=lambda s: (s["order"], s["created_lamport"], s["id"]),
    )

    # Cues are grouped inside their scene and sorted by start time,
    # tie-break created lamport then id.
    cues_by_scene: dict[str, list[dict[str, Any]]] = {}
    orphans: list[dict[str, Any]] = []
    for c in cues.values():
        if c.get("deleted"):
            continue
        if c["scene_id"] in scenes and not scenes[c["scene_id"]].get("deleted"):
            cues_by_scene.setdefault(c["scene_id"], []).append(c)
        else:
            orphans.append(c)
    for lst in cues_by_scene.values():
        lst.sort(key=lambda c: (c["start"], c["created_lamport"], c["id"]))
    orphans.sort(key=lambda c: (c["start"], c["created_lamport"], c["id"]))

    deleted_scenes = [s for s in scene_list if s.get("deleted")]
    deleted_cues = [c for c in cues.values() if c.get("deleted")]
    alive_scenes = [s for s in scene_list if not s.get("deleted")]

    return {
        "scenes": alive_scenes,
        "deleted_scenes": sorted(deleted_scenes, key=lambda s: (s["order"], s["created_lamport"], s["id"])),
        "cues_by_scene": cues_by_scene,
        "orphans": orphans,
        "deleted_cues": sorted(deleted_cues, key=lambda c: (c["start"], c["created_lamport"], c["id"])),
        "conflicts": detect_conflicts(ordered),
        "op_count": len(ordered),
    }


# ---- conflict detection ----------------------------------------------------

def detect_conflicts(ordered: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Group write ops per (target, entity). Pairs that are concurrent and
    divergent are unresolved until a later op causally supersedes them.
    """
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    seen: set[str] = set()
    for o in ordered:
        if o.get("op") in _WRITE_OPS and o["id"] not in seen:
            seen.add(o["id"])
            groups.setdefault((o["target"], o["entity_id"]), []).append(o)

    conflicts: dict[str, dict[str, Any]] = {}
    for (target, eid), group in groups.items():
        # final-state op = last in total order among writes
        terminal = sorted(group, key=op_sort_key)[-1]
        concurrent_with_terminal = [
            o for o in group
            if o["id"] != terminal["id"]
            and vec_concurrent(o.get("vector", {}), terminal.get("vector", {}))
        ]
        if not concurrent_with_terminal:
            continue

        # A later causally-aware op resolves the conflict (its vector dominates
        # both sides). terminal is the max in total order; if any earlier op
        # dominates terminal it would itself be terminal, so we only need to
        # check whether terminal causally dominates every concurrent sibling.
        unresolved = [o for o in concurrent_with_terminal if not vec_le(o["vector"], terminal["vector"])]
        if not unresolved:
            continue

        members = sorted(unresolved + [terminal], key=op_sort_key)
        kinds = sorted({m["op"] for m in members})

        # Winner: remove wins over concurrent non-remove; otherwise the op last
        # in the deterministic total order.
        removes = [m for m in members if m["op"] == "remove"]
        winner = removes[-1] if removes else terminal

        key = f"{target}:{eid}"
        conflicts[key] = {
            "target": target,
            "entity_id": eid,
            "kinds": kinds,
            "winner_op_id": winner["id"],
            "winner_client_id": winner["client_id"],
            "lamport": max(int(m.get("lamport", 0)) for m in members),
            "ops": [
                {
                    "op_id": m["id"],
                    "client_id": m["client_id"],
                    "kind": m["op"],
                    "lamport": int(m.get("lamport", 0)),
                    "payload": m.get("payload", {}),
                }
                for m in members
            ],
        }

    # Deterministic output order by key.
    return dict(sorted(conflicts.items()))


def export_play(play: dict[str, Any], ops: list[dict[str, Any]]) -> dict[str, Any]:
    state = reduce_state(ops)
    return {
        "format": "theater-rehearsal/v1",
        "exported_at": _utc_now_iso(),
        "play": play,
        "state": {
            "scenes": state["scenes"],
            "cues": {sid: lst for sid, lst in state["cues_by_scene"].items()},
        },
        "conflicts": state["conflicts"],
        "ops": ops,
    }


def _utc_now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")
