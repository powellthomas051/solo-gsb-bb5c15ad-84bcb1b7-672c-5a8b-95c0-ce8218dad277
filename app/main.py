"""FastAPI entry: REST API + WebSocket sync + static frontend."""
from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, sync
from .ws_manager import manager

app = FastAPI(title="剧场排练时序编排", version="1.0.0")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")

VALID_TARGETS = {"scene", "cue"}
VALID_OPS = {"add", "move", "update", "remove", "restore"}


# ---------- models ----------

class PlayIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class PlayRename(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class MemberIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    color: str = ""


class OpIn(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    client_id: str = Field(min_length=1, max_length=120)
    lamport: int = Field(ge=0)
    vector: dict[str, int] = Field(default_factory=dict)
    target: Literal["scene", "cue"]
    op: Literal["add", "move", "update", "remove", "restore"]
    entity_id: str = Field(min_length=1, max_length=120)
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None


class OpsBatch(BaseModel):
    ops: list[OpIn]


# ---------- REST: plays ----------

@app.post("/api/plays")
def api_create_play(body: PlayIn) -> dict[str, Any]:
    play = db.create_play(uuid.uuid4().hex[:12], body.name.strip())
    return play


@app.get("/api/plays")
def api_list_plays() -> list[dict[str, Any]]:
    plays = db.list_plays()
    names = db.member_name_map()
    out = []
    for p in plays:
        ops = db.all_ops(p["id"])
        st = sync.reduce_state(ops)
        out.append({
            **p,
            "scene_count": len(st["scenes"]),
            "cue_count": sum(len(v) for v in st["cues_by_scene"].values()),
            "conflict_count": len(st["conflicts"]),
            "online": len(manager.online_ids(p["id"])),
        })
    return out


@app.get("/api/plays/{play_id}")
def api_get_play(play_id: str) -> dict[str, Any]:
    play = db.get_play(play_id)
    if not play:
        raise HTTPException(404, "剧目不存在")
    ops = db.all_ops(play_id)
    st = sync.reduce_state(ops)
    names = db.member_name_map()
    return {
        "play": play,
        "state": st,
        "names": names,
        "online": manager.presence_snapshot(play_id),
        "seq_last": db.get_conn().execute(
            "SELECT COALESCE(MAX(seq), 0) AS s FROM ops WHERE play_id = ?", (play_id,)
        ).fetchone()["s"],
    }


@app.patch("/api/plays/{play_id}")
def api_rename_play(play_id: str, body: PlayRename) -> dict[str, Any]:
    play = db.get_play(play_id)
    if not play:
        raise HTTPException(404, "剧目不存在")
    db.rename_play(play_id, body.name.strip())
    return db.get_play(play_id)


# ---------- REST: members ----------

@app.post("/api/members")
def api_upsert_member(body: MemberIn) -> dict[str, str]:
    cid = uuid.uuid4().hex[:12]
    db.upsert_member(cid, body.name.strip(), body.color)
    return {"client_id": cid, "name": body.name.strip(), "color": body.color}


@app.post("/api/members/{client_id}")
def api_update_member(client_id: str, body: MemberIn) -> dict[str, str]:
    db.upsert_member(client_id, body.name.strip(), body.color)
    return {"client_id": client_id, "name": body.name.strip(), "color": body.color}


# ---------- REST: ops (catch-up / direct post) ----------

@app.get("/api/plays/{play_id}/ops")
def api_get_ops(play_id: str, after: int = 0) -> dict[str, Any]:
    if not db.get_play(play_id):
        raise HTTPException(404, "剧目不存在")
    ops = db.get_ops(play_id, after)
    row = db.get_conn().execute(
        "SELECT COALESCE(MAX(seq), 0) AS s FROM ops WHERE play_id = ?", (play_id,)
    ).fetchone()
    return {"ops": ops, "seq_last": row["s"]}


@app.post("/api/plays/{play_id}/ops")
async def api_post_op(play_id: str, body: OpIn) -> dict[str, Any]:
    play = db.get_play(play_id)
    if not play:
        raise HTTPException(404, "剧目不存在")
    op = body.model_dump()
    op["play_id"] = play_id
    inserted, seq = db.insert_op(op)
    if inserted:
        await manager.broadcast(play_id, {"type": "op", "seq": seq, "op": op})
    return {"ok": True, "inserted": inserted, "seq": seq}


# ---------- REST: import / export ----------

@app.get("/api/plays/{play_id}/export")
def api_export(play_id: str) -> dict[str, Any]:
    play = db.get_play(play_id)
    if not play:
        raise HTTPException(404, "剧目不存在")
    return sync.export_play(play, db.all_ops(play_id))


@app.post("/api/plays/import")
async def api_import(body: dict[str, Any]) -> dict[str, Any]:
    if body.get("format") != "theater-rehearsal/v1":
        raise HTTPException(400, "不支持的文件格式（需要 theater-rehearsal/v1）")
    src_play = body.get("play") or {}
    name = str(src_play.get("name") or "导入的剧目").strip()[:120]
    play_id = uuid.uuid4().hex[:12]
    db.create_play(play_id, name)

    raw_ops = body.get("ops")
    if not isinstance(raw_ops, list):
        raise HTTPException(400, "缺少 ops 列表")

    # Re-map every entity id so imports can never collide with existing plays.
    scene_map: dict[str, str] = {}
    cue_map: dict[str, str] = {}
    clean: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for i, raw in enumerate(raw_ops):
        if not isinstance(raw, dict):
            continue
        if raw.get("target") not in VALID_TARGETS or raw.get("op") not in VALID_OPS:
            continue
        oid = str(raw.get("id") or f"imp-{i}")[:120]
        if oid in seen_ids:
            continue
        seen_ids.add(oid)
        target = raw["target"]
        old_eid = str(raw.get("entity_id"))
        table = scene_map if target == "scene" else cue_map
        new_eid = table.setdefault(old_eid, uuid.uuid4().hex[:12])

        payload = dict(raw.get("payload") or {})
        if target == "cue" and payload.get("scene_id"):
            payload["scene_id"] = scene_map.get(payload["scene_id"], payload["scene_id"])

        clean.append({
            "id": f"imp:{oid}",
            "play_id": play_id,
            "client_id": str(raw.get("client_id", "import"))[:120],
            "lamport": int(raw.get("lamport", 0)),
            "vector": {str(k): int(v) for k, v in (raw.get("vector") or {}).items()},
            "target": target,
            "op": raw["op"],
            "entity_id": new_eid,
            "payload": payload,
            "created_at": raw.get("created_at"),
        })

    # If the export carried state instead of a complete add-log, synthesize
    # adds so the materialized timeline is still reconstructed.
    _ensure_state_adds(body.get("state"), clean, scene_map, cue_map)

    for o in clean:
        o["play_id"] = play_id

    inserted = db.insert_ops_bulk(clean)
    st = sync.reduce_state(db.all_ops(play_id))
    await manager.broadcast(play_id, {"type": "imported", "play_id": play_id})
    return {
        "play_id": play_id,
        "name": name,
        "inserted_ops": inserted,
        "total_ops": len(clean),
        "scene_count": len(st["scenes"]),
        "cue_count": sum(len(v) for v in st["cues_by_scene"].values()),
    }


def _ensure_state_adds(state: Any, clean: list[dict[str, Any]], scene_map: dict, cue_map: dict) -> None:
    """Backfill add ops from a materialized state snapshot when the op log is
    incomplete (e.g. hand-written JSON)."""
    if not isinstance(state, dict):
        return
    existing_entities = {(o["target"], o["entity_id"]) for o in clean if o["op"] == "add"}
    existing_ids = {o["id"] for o in clean}
    lamport = max((o["lamport"] for o in clean), default=0)

    def next_id(prefix: str) -> tuple[str, int]:
        nonlocal lamport
        lamport += 1
        return f"imp:state-{prefix}-{lamport}", lamport

    for s in state.get("scenes", []) or []:
        old = str(s.get("id"))
        new = scene_map.setdefault(old, uuid.uuid4().hex[:12])
        if ("scene", new) not in existing_entities:
            oid, lc = next_id("s")
            clean.append({
                "id": oid, "play_id": "", "client_id": "import", "lamport": lc, "vector": {},
                "target": "scene", "op": "add", "entity_id": new,
                "payload": {"name": s.get("name", "未命名场次"), "order": float(s.get("order", 0))},
                "created_at": None,
            })
    cues = state.get("cues")
    if isinstance(cues, dict):
        cue_iter = [c for lst in cues.values() for c in (lst or [])]
    elif isinstance(cues, list):
        cue_iter = cues
    else:
        cue_iter = []
    for c in cue_iter:
        old = str(c.get("id"))
        new = cue_map.setdefault(old, uuid.uuid4().hex[:12])
        if ("cue", new) not in existing_entities:
            scene_id = scene_map.get(str(c.get("scene_id")), str(c.get("scene_id", "")))
            oid, lc = next_id("c")
            clean.append({
                "id": oid, "play_id": "", "client_id": "import", "lamport": lc, "vector": {},
                "target": "cue", "op": "add", "entity_id": new,
                "payload": {
                    "scene_id": scene_id,
                    "name": c.get("name", "新动作/音效"),
                    "kind": c.get("kind", "action"),
                    "start": float(c.get("start", 0)),
                    "duration": float(c.get("duration", 5)),
                },
                "created_at": None,
            })


# ---------- WebSocket ----------

@app.websocket("/ws/{play_id}")
async def ws_endpoint(ws: WebSocket, play_id: str) -> None:
    play = db.get_play(play_id)
    if not play:
        await ws.close(code=4404)
        return
    await ws.accept()
    client: Any = None
    ping_task: asyncio.Task | None = None

    try:
        # First message must be hello.
        raw = await ws.receive_text()
        import json
        hello = json.loads(raw)
        if hello.get("type") != "hello":
            await ws.close(code=4400)
            return
        client_id = str(hello.get("client_id", ""))[:120]
        name = str(hello.get("name", "匿名"))[:60] or "匿名"
        color = str(hello.get("color", ""))[:20]
        if not client_id:
            await ws.close(code=4400)
            return

        db.upsert_member(client_id, name, color)
        client = manager.connect(play_id, client_id, name, color, ws)
        db.presence_online(play_id, client_id, name, color, client.conn_id)

        # Send snapshot + everything they are missing.
        after = int(hello.get("seq", 0))
        ops = db.get_ops(play_id, after)
        row = db.get_conn().execute(
            "SELECT COALESCE(MAX(seq), 0) AS s FROM ops WHERE play_id = ?", (play_id,)
        ).fetchone()
        await manager.send_json(ws, {
            "type": "welcome",
            "seq_last": row["s"],
            "ops": ops,
            "presence": manager.presence_snapshot(play_id),
            "you": client_id,
        })
        print("WS welcome sent", flush=True)
        await manager.broadcast(play_id, {
            "type": "presence",
            "members": manager.presence_snapshot(play_id),
            "join": {"client_id": client_id, "name": name, "color": color},
        })

        async def pinger() -> None:
            try:
                while True:
                    await asyncio.sleep(25)
                    await manager.send_json(ws, {"type": "ping"})
            except asyncio.CancelledError:
                pass

        ping_task = asyncio.create_task(pinger())

        while True:
            text = await ws.receive_text()
            msg = json.loads(text)
            mtype = msg.get("type")

            if mtype == "op":
                raw_op = msg.get("op") or {}
                if raw_op.get("target") not in VALID_TARGETS or raw_op.get("op") not in VALID_OPS:
                    await manager.send_json(ws, {"type": "error", "message": "非法操作", "ref": raw_op.get("id")})
                    continue
                cid = str(raw_op.get("client_id", client_id))[:120]
                op = {
                    "id": str(raw_op["id"])[:120],
                    "play_id": play_id,
                    "client_id": cid,
                    "lamport": int(raw_op.get("lamport", 0)),
                    "vector": {str(k): int(v) for k, v in (raw_op.get("vector") or {}).items()},
                    "target": raw_op["target"],
                    "op": raw_op["op"],
                    "entity_id": str(raw_op["entity_id"])[:120],
                    "payload": raw_op.get("payload", {}) or {},
                    "created_at": raw_op.get("created_at"),
                }
                inserted, seq = db.insert_op(op)
                await manager.send_json(ws, {"type": "ack", "op_id": op["id"], "seq": seq, "inserted": inserted})
                if inserted:
                    await manager.broadcast(play_id, {"type": "op", "seq": seq, "op": op})

            elif mtype == "ops":
                # Bulk flush of a reconnect queue.
                accepted = []
                for raw_op in msg.get("ops", []):
                    if raw_op.get("target") not in VALID_TARGETS or raw_op.get("op") not in VALID_OPS:
                        continue
                    op = {
                        "id": str(raw_op["id"])[:120],
                        "play_id": play_id,
                        "client_id": str(raw_op.get("client_id", client_id))[:120],
                        "lamport": int(raw_op.get("lamport", 0)),
                        "vector": {str(k): int(v) for k, v in (raw_op.get("vector") or {}).items()},
                        "target": raw_op["target"],
                        "op": raw_op["op"],
                        "entity_id": str(raw_op["entity_id"])[:120],
                        "payload": raw_op.get("payload", {}) or {},
                        "created_at": raw_op.get("created_at"),
                    }
                    inserted, seq = db.insert_op(op)
                    accepted.append({"op_id": op["id"], "seq": seq, "inserted": inserted})
                    if inserted:
                        await manager.broadcast(play_id, {"type": "op", "seq": seq, "op": op})
                await manager.send_json(ws, {"type": "ack_batch", "results": accepted})

            elif mtype == "hello":
                # Identity change on the same socket.
                name = str(msg.get("name", name))[:60]
                color = str(msg.get("color", color))[:20]
                client.name, client.color = name, color
                db.upsert_member(client_id, name, color)
                db.presence_online(play_id, client_id, name, color, client.conn_id)
                await manager.broadcast(play_id, {
                    "type": "presence", "members": manager.presence_snapshot(play_id)
                })

            elif mtype == "ping":
                db.presence_heartbeat(play_id, client_id)
                await manager.send_json(ws, {"type": "pong"})

    except WebSocketDisconnect:
        pass
    except Exception:
        # Unexpected protocol/parse errors: just clean up in finally.
        pass
    finally:
        if ping_task:
            ping_task.cancel()
        if client is not None:
            manager.disconnect(play_id, client)
            db.presence_offline(play_id, client.client_id, client.conn_id)
            await manager.broadcast(play_id, {
                "type": "presence",
                "members": manager.presence_snapshot(play_id),
                "leave": client.client_id,
            })


# ---------- static frontend (mounted last so /api wins) ----------

if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
