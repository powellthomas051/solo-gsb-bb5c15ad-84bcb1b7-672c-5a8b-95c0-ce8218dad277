"""Convergence / determinism tests for the merge engine."""
from app.engine import build_view, client_seq, fold, snapshot, version_vector


def _op(seq, cid, typ, kind, elem, lamport, vv=None, payload=None, parent=None):
    op = {
        "opId": f"{seq}@{cid}",
        "type": typ,
        "kind": kind,
        "elemId": elem,
        "lamport": lamport,
        "clientId": cid,
        "vv": vv or {},
        "payload": payload or {},
    }
    if parent is not None:
        op["parent"] = parent
    return op


def _add(seq, cid, kind, elem, start, name=None, lamport=1, vv=None, parent=None):
    return _op(seq, cid, "add", kind, elem, lamport, vv or {cid: seq - 1},
               {"name": name or elem, "start": start, "duration": 5000}, parent)


def test_deterministic_concurrent_move_winner():
    """Two clients move the same element concurrently: same winner everywhere."""
    add = _add(1, "A", "scene", "s1", 0)
    m1 = _op(2, "A", "move", "scene", "s1", 2, {"A": 1}, {"start": 10000})
    m2 = _op(1, "B", "move", "scene", "s1", 2, {"B": 0}, {"start": 20000})

    # each client saw its own op first — but fold is order-independent
    v1 = build_view(fold([add, m1, m2]))
    v2 = build_view(fold([m2, add, m1]))
    assert v1["scenes"][0]["start"] == v2["scenes"][0]["start"]
    # total key tie-break: lamport equal (2) -> clientId 'A' < 'B' -> B wins
    assert v1["scenes"][0]["start"] == 20000
    assert len(v1["conflicts"]) == 1
    c = v1["conflicts"][0]
    assert c["kind"] == "edit" and c["field"] == "start"
    assert c["winnerClientId"] == "B"


def test_higher_lamport_wins():
    add = _add(1, "A", "scene", "s1", 0)
    m1 = _op(2, "B", "move", "scene", "s1", 5, {"A": 1, "B": 1}, {"start": 30000})
    m2 = _op(2, "A", "move", "scene", "s1", 4, {"A": 1}, {"start": 10000})
    v = build_view(fold([add, m1, m2]))
    assert v["scenes"][0]["start"] == 30000


def test_causal_move_no_conflict():
    """Move B causally supersedes move A (B's VV covers it): no conflict."""
    add = _add(1, "A", "scene", "s1", 0)
    m1 = _op(2, "A", "move", "scene", "s1", 2, {"A": 1}, {"start": 10000})
    m2 = _op(1, "B", "move", "scene", "s1", 3, {"A": 2, "B": 0}, {"start": 20000})
    v = build_view(fold([add, m1, m2]))
    assert v["scenes"][0]["start"] == 20000
    assert v["conflicts"] == []


def test_delete_vs_concurrent_edit_conflict():
    add = _add(1, "A", "scene", "s1", 0)
    move = _op(2, "A", "move", "scene", "s1", 2, {"A": 1}, {"start": 9000})
    dele = _op(1, "B", "delete", "scene", "s1", 2, {"B": 0})
    v = build_view(fold([add, move, dele]))
    # deterministic outcome: deleted
    assert v["elements"]["s1"]["deleted"] is True
    assert [c["kind"] for c in v["conflicts"]] == ["delete"]


def test_delete_then_causal_restore():
    add = _add(1, "A", "scene", "s1", 0)
    dele = _op(2, "A", "delete", "scene", "s1", 2, {"A": 1})
    # restore saw the delete -> alive, no conflict
    rest = _op(1, "B", "restore", "scene", "s1", 3, {"A": 2, "B": 0})
    v = build_view(fold([add, dele, rest]))
    assert v["elements"]["s1"]["deleted"] is False
    assert v["conflicts"] == []


def test_concurrent_delete_restore_flagged():
    add = _add(1, "A", "scene", "s1", 0)
    dele = _op(2, "A", "delete", "scene", "s1", 2, {"A": 1})
    rest = _op(1, "B", "restore", "scene", "s1", 2, {"B": 0})
    v = build_view(fold([add, dele, rest]))
    assert any(c["kind"] == "delete-restore" for c in v["conflicts"])


def test_action_orphan_hidden_but_scene_order_stable():
    sa = _add(1, "A", "scene", "scA", 20000)
    sb = _add(2, "A", "scene", "scB", 0, vv={"A": 1})
    act = _add(1, "B", "action", "ac1", 1000, lamport=3,
               vv={"A": 2, "B": 0}, parent="scB")
    v = build_view(fold([sa, sb, act]))
    assert [s["id"] for s in v["scenes"]] == ["scB", "scA"]
    assert [a["id"] for a in v["scenes"][0]["actions"]] == ["ac1"]


def test_stale_writer_dropped_by_self_vv():
    """A client's own later op dominates its earlier one automatically."""
    add = _add(1, "A", "scene", "s1", 0)
    m_old = _op(2, "A", "move", "scene", "s1", 2, {"A": 1}, {"start": 10000})
    m_new = _op(3, "A", "move", "scene", "s1", 3, {"A": 2}, {"start": 40000})
    v = build_view(fold([add, m_old, m_new]))
    assert v["scenes"][0]["start"] == 40000
    assert v["conflicts"] == []


def test_version_vector_and_incremental_sync():
    ops = [
        _add(1, "A", "scene", "s1", 0),
        _op(2, "A", "move", "scene", "s1", 2, {"A": 1}, {"start": 5000}),
        _add(1, "B", "sound", "sd1", 1000, lamport=3, vv={"A": 2, "B": 0}),
    ]
    vv = version_vector(ops)
    assert vv == {"A": 2, "B": 1}

    # client that has seen A:2,B:0 gets only B:1 back
    have = {"A": 2, "B": 0}
    missing = [o for o in ops if int(have.get(o["clientId"], 0)) < client_seq(o)]
    assert [o["opId"] for o in missing] == ["1@B"]

    # merging those missing ops converges to full snapshot
    partial = [o for o in ops if o not in missing]
    assert snapshot(partial + missing)["vv"] == vv


def test_three_way_partial_logs_converge():
    """Classic partition scenario: all peers end with identical view JSON."""
    add = _add(1, "A", "scene", "s1", 0)
    a_move = _op(2, "A", "move", "scene", "s1", 2, {"A": 1}, {"start": 7000})
    b_move = _op(1, "B", "move", "scene", "s1", 3, {"A": 1, "B": 0},
                 {"start": 12000})
    c_del = _op(1, "C", "delete", "scene", "s1", 4, {"A": 1, "C": 0})

    # disjoint delivery orders and partial views
    views = [
        build_view(fold([add, a_move, b_move, c_del])),
        build_view(fold([c_del, b_move, add, a_move])),
        build_view(fold([add, c_del, a_move, b_move])),
    ]
    import json
    canonical = json.dumps(views[0], sort_keys=True, ensure_ascii=False,
                           default=list)
    for v in views[1:]:
        assert json.dumps(v, sort_keys=True, ensure_ascii=False,
                          default=list) == canonical
    # delete concurrent with edits -> flagged and element deleted
    assert views[0]["elements"]["s1"]["deleted"] is True
    assert any(c["kind"] == "delete" for c in views[0]["conflicts"])
