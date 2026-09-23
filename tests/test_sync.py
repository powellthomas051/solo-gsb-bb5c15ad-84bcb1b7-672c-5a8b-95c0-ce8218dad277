"""Concurrency scenarios for the canonical merge engine. Emits a JSON report
that the JS mirror is checked against (see run_consistency.sh)."""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import sync


def op(oid, cid, lamport, vec, target, kind, eid, payload=None):
    return {
        "id": oid, "play_id": "p1", "client_id": cid, "lamport": lamport,
        "vector": vec, "target": target, "op": kind, "entity_id": eid,
        "payload": payload or {},
    }


def signature(st):
    """Ordering-relevant projection of reduced state."""
    return {
        "scene_order": [(s["id"], s["order"], s["deleted"]) for s in
                        sorted(st["scenes"] + st["deleted_scenes"],
                               key=lambda s: (s["order"], s["created_lamport"], s["id"]))],
        "cues": sorted(
            [
                (c["id"], c["scene_id"], c["start"], c["duration"], c["deleted"])
                for c in list(st["cues_by_scene"].get("s1", [])) +
                          list(st["cues_by_scene"].get("s2", [])) +
                          st["orphans"] + st["deleted_cues"]
            ],
            key=lambda x: x[0],
        ),
        "conflicts": {
            k: {"kinds": v["kinds"], "winner": v["winner_op_id"], "n": len(v["ops"])}
            for k, v in st["conflicts"].items()
        },
    }


def scenario_add_then_concurrent_move_and_delete():
    return [
        op("a:1", "a", 1, {"a": 1}, "scene", "add", "s1", {"name": "一幕", "order": 1}),
        op("a:2", "a", 2, {"a": 2}, "cue", "add", "q1",
           {"scene_id": "s1", "name": "上场", "kind": "action", "start": 0, "duration": 5}),
        # b has seen add (vector a:2), then b moves
        op("b:1", "b", 4, {"a": 2, "b": 1}, "cue", "move", "q1", {"start": 20}),
        # a concurrently deletes (a has NOT seen b:1 -> vectors incomparable)
        op("a:3", "a", 3, {"a": 3}, "cue", "remove", "q1", {}),
    ]


def scenario_two_concurrent_moves():
    return [
        op("a:1", "a", 1, {"a": 1}, "scene", "add", "s1", {"name": "x", "order": 1}),
        op("a:2", "a", 2, {"a": 2}, "cue", "add", "q1",
           {"scene_id": "s1", "name": "c", "kind": "sound", "start": 0, "duration": 5}),
        op("b:1", "b", 4, {"a": 2, "b": 1}, "cue", "move", "q1", {"start": 20}),
        op("c:1", "c", 4, {"a": 2, "c": 1}, "cue", "move", "q1", {"start": 40}),
    ]


def scenario_causal_chain():
    # b sees a's move then edits — no conflict, final = 40
    return [
        op("a:1", "a", 1, {"a": 1}, "scene", "add", "s1", {"name": "x", "order": 1}),
        op("a:2", "a", 2, {"a": 2}, "cue", "add", "q1",
           {"scene_id": "s1", "name": "c", "kind": "action", "start": 0, "duration": 5}),
        op("a:3", "a", 3, {"a": 3}, "cue", "move", "q1", {"start": 20}),
        op("b:1", "b", 5, {"a": 3, "b": 1}, "cue", "move", "q1", {"start": 40}),
    ]


def scenario_restore_after_delete():
    return [
        op("a:1", "a", 1, {"a": 1}, "scene", "add", "s1", {"name": "x", "order": 1}),
        op("a:2", "a", 2, {"a": 2}, "cue", "add", "q1",
           {"scene_id": "s1", "name": "c", "kind": "action", "start": 0, "duration": 5}),
        op("a:3", "a", 3, {"a": 3}, "cue", "remove", "q1", {}),
        # restore causally after remove (a:3 <= a:4 vector)
        op("a:4", "a", 4, {"a": 4}, "cue", "restore", "q1",
           {"start": 12, "duration": 5, "scene_id": "s1", "name": "c"}),
    ]


def scenario_scene_reorder_concurrent():
    return [
        op("a:1", "a", 1, {"a": 1}, "scene", "add", "s1", {"name": "A", "order": 1}),
        op("a:2", "a", 2, {"a": 2}, "scene", "add", "s2", {"name": "B", "order": 2}),
        op("a:3", "a", 3, {"a": 3}, "scene", "add", "s3", {"name": "C", "order": 3}),
        # two clients swap order differently, concurrently
        op("b:1", "b", 5, {"a": 3, "b": 1}, "scene", "move", "s3", {"order": 0.5}),
        op("c:1", "c", 5, {"a": 3, "c": 1}, "scene", "move", "s1", {"order": 2.5}),
    ]


def scenario_op_shuffle_idempotent():
    base = scenario_two_concurrent_moves()
    # add duplicate ops (simulating replay) and shuffle arrival order
    dup = base + [base[2], base[1]]
    import random
    rng = random.Random(7)
    rng.shuffle(dup)
    return dup


def main():
    scenarios = {
        "move_vs_delete": scenario_add_then_concurrent_move_and_delete(),
        "two_concurrent_moves": scenario_two_concurrent_moves(),
        "causal_chain": scenario_causal_chain(),
        "restore": scenario_restore_after_delete(),
        "scene_reorder": scenario_scene_reorder_concurrent(),
        "shuffle_dedup": scenario_op_shuffle_idempotent(),
    }
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "scenarios.json"), "w", encoding="utf-8") as f:
        json.dump(scenarios, f, ensure_ascii=False)

    out = {}
    for name, ops in scenarios.items():
        st = sync.reduce_state(ops)
        out[name] = signature(st)
    with open(os.path.join(here, "py_report.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    expected = {
        # delete wins: q1 tombstoned, conflict flagged with winner = remove
        "move_vs_delete": {
            "q1_deleted": True,
            "conflict_kinds": ["move", "remove"],
        },
        "two_concurrent_moves": {
            "q1_start": 40.0,  # winner: c:1 > b:1 by client id tie-break? compare keys
            "has_conflict": True,
        },
        "causal_chain": {"q1_start": 40.0, "conflicts": 0},
        "restore": {"q1_alive": True, "q1_start": 12.0, "conflicts": 0},
        "scene_reorder": {"has_conflict": False},  # moves on different scenes
        "shuffle_dedup": {"q1_start": None},
    }

    def assert_eq(label, got, want):
        if got != want:
            raise AssertionError(f"{label}: got {got!r} want {want!r}")

    md = out["move_vs_delete"]
    assert_eq("move_vs_delete q1 deleted",
              [c for c in md["cues"] if c[0] == "q1"][0][4], True)
    assert_eq("move_vs_delete kinds", md["conflicts"]["cue:q1"]["kinds"], ["move", "remove"])
    assert_eq("move_vs_delete winner", md["conflicts"]["cue:q1"]["winner"], "a:3")

    tm = out["two_concurrent_moves"]
    q1 = [c for c in tm["cues"] if c[0] == "q1"][0]
    # total order: b:1 vs c:1 same lamport 4 -> 'b' < 'c', terminal = c:1 (start 40)
    assert_eq("concurrent moves winner start", q1[2], 40.0)
    assert_eq("concurrent moves conflict", "cue:q1" in tm["conflicts"], True)
    assert_eq("concurrent winner id", tm["conflicts"]["cue:q1"]["winner"], "c:1")

    cc = out["causal_chain"]
    q1 = [c for c in cc["cues"] if c[0] == "q1"][0]
    assert_eq("causal chain start", q1[2], 40.0)
    assert_eq("causal chain conflicts", len(cc["conflicts"]), 0)

    rs = out["restore"]
    q1 = [c for c in rs["cues"] if c[0] == "q1"][0]
    assert_eq("restore alive", q1[4], False)
    assert_eq("restore start", q1[2], 12.0)
    assert_eq("restore no conflicts", len(rs["conflicts"]), 0)

    sr = out["scene_reorder"]
    assert_eq("scene reorder no conflicts", len(sr["conflicts"]), 0)
    order = [s[0] for s in sr["scene_order"] if not s[2]]
    assert_eq("scene order", order, ["s3", "s2", "s1"])

    # shuffling + duplicate ops must converge to same as clean set
    clean = sync.reduce_state(scenario_two_concurrent_moves())
    shuf = sync.reduce_state(scenario_op_shuffle_idempotent())
    assert_eq("idempotent convergence", signature(shuf), signature(clean))

    print(json.dumps(out, indent=2, ensure_ascii=False))
    print("ALL PYTHON ASSERTIONS PASSED")


if __name__ == "__main__":
    main()
