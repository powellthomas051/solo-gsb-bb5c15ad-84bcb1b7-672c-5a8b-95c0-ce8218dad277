"""SQLite persistence: plays, members and the global operation log."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "..", "data", "theater.db"))

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        path = os.path.abspath(DB_PATH)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        conn = sqlite3.connect(path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _conn = conn
        _init_schema(conn)
    return _conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS plays (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS members (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '',
            last_seen TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ops (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            play_id TEXT NOT NULL,
            client_id TEXT NOT NULL,
            lamport INTEGER NOT NULL,
            vector TEXT NOT NULL,
            target TEXT NOT NULL,
            op TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ops_play ON ops(play_id, seq);

        CREATE TABLE IF NOT EXISTS presence (
            play_id TEXT NOT NULL,
            client_id TEXT NOT NULL,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '',
            conn_id INTEGER,
            last_seen TEXT NOT NULL,
            PRIMARY KEY (play_id, client_id)
        );
        """
    )
    conn.commit()


def _row_to_op(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "play_id": row["play_id"],
        "client_id": row["client_id"],
        "lamport": row["lamport"],
        "vector": json.loads(row["vector"]),
        "target": row["target"],
        "op": row["op"],
        "entity_id": row["entity_id"],
        "payload": json.loads(row["payload"]),
        "created_at": row["created_at"],
    }


# ---------- plays ----------

def create_play(play_id: str, name: str) -> dict[str, Any]:
    with _lock:
        get_conn().execute(
            "INSERT OR IGNORE INTO plays (id, name, created_at) VALUES (?, ?, ?)",
            (play_id, name, _now()),
        )
        get_conn().commit()
    return {"id": play_id, "name": name}


def list_plays() -> list[dict[str, Any]]:
    rows = get_conn().execute("SELECT id, name, created_at FROM plays ORDER BY created_at").fetchall()
    return [dict(r) for r in rows]


def get_play(play_id: str) -> dict[str, Any] | None:
    row = get_conn().execute("SELECT id, name FROM plays WHERE id = ?", (play_id,)).fetchone()
    return dict(row) if row else None


def rename_play(play_id: str, name: str) -> None:
    with _lock:
        get_conn().execute("UPDATE plays SET name = ? WHERE id = ?", (name, play_id))
        get_conn().commit()


# ---------- members ----------

def upsert_member(client_id: str, name: str, color: str = "") -> None:
    with _lock:
        conn = get_conn()
        conn.execute(
            """
            INSERT INTO members (id, name, color, last_seen) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                color = excluded.color,
                last_seen = excluded.last_seen
            """,
            (client_id, name, color, _now()),
        )
        conn.commit()


def member_name_map() -> dict[str, str]:
    rows = get_conn().execute("SELECT id, name FROM members").fetchall()
    return {r["id"]: r["name"] for r in rows}


# ---------- operations ----------

def insert_op(op: dict[str, Any]) -> tuple[bool, int]:
    """Insert an operation. Returns (inserted, seq). Duplicate ids are ignored."""
    with _lock:
        conn = get_conn()
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO ops
                (id, play_id, client_id, lamport, vector, target, op, entity_id, payload, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                op["id"],
                op["play_id"],
                op["client_id"],
                op["lamport"],
                json.dumps(op.get("vector", {}), separators=(",", ":")),
                op["target"],
                op["op"],
                op["entity_id"],
                json.dumps(op.get("payload", {}), separators=(",", ":")),
                op.get("created_at") or _now(),
            ),
        )
        conn.commit()
        if cur.rowcount == 0:
            row = conn.execute("SELECT seq FROM ops WHERE id = ?", (op["id"],)).fetchone()
            return False, row["seq"] if row else -1
        seq = cur.lastrowid
    return True, seq


def insert_ops_bulk(ops: list[dict[str, Any]]) -> int:
    """Bulk insert used by JSON import. Returns number of newly inserted ops."""
    inserted = 0
    with _lock:
        conn = get_conn()
        for op in ops:
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO ops
                    (id, play_id, client_id, lamport, vector, target, op, entity_id, payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    op["id"],
                    op["play_id"],
                    op["client_id"],
                    op["lamport"],
                    json.dumps(op.get("vector", {}), separators=(",", ":")),
                    op["target"],
                    op["op"],
                    op["entity_id"],
                    json.dumps(op.get("payload", {}), separators=(",", ":")),
                    op.get("created_at") or _now(),
                ),
            )
            inserted += cur.rowcount
        conn.commit()
    return inserted


def get_ops(play_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
    rows = get_conn().execute(
        "SELECT * FROM ops WHERE play_id = ? AND seq > ? ORDER BY seq",
        (play_id, after_seq),
    ).fetchall()
    return [_row_to_op(r) for r in rows]


def all_ops(play_id: str) -> list[dict[str, Any]]:
    return get_ops(play_id, 0)


# ---------- presence ----------

def presence_online(play_id: str, client_id: str, name: str, color: str, conn_id: int) -> None:
    with _lock:
        conn = get_conn()
        conn.execute(
            """
            INSERT INTO presence (play_id, client_id, name, color, conn_id, last_seen)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(play_id, client_id) DO UPDATE SET
                name = excluded.name,
                color = excluded.color,
                conn_id = excluded.conn_id,
                last_seen = excluded.last_seen
            """,
            (play_id, client_id, name, color, conn_id, _now()),
        )
        conn.commit()


def presence_offline(play_id: str, client_id: str, conn_id: int) -> None:
    with _lock:
        conn = get_conn()
        conn.execute(
            "DELETE FROM presence WHERE play_id = ? AND client_id = ? AND conn_id = ?",
            (play_id, client_id, conn_id),
        )
        conn.commit()


def presence_heartbeat(play_id: str, client_id: str) -> None:
    with _lock:
        conn = get_conn()
        conn.execute(
            "UPDATE presence SET last_seen = ? WHERE play_id = ? AND client_id = ?",
            (_now(), play_id, client_id),
        )
        conn.commit()


def presence_list(play_id: str) -> list[dict[str, Any]]:
    rows = get_conn().execute(
        "SELECT client_id, name, color, last_seen FROM presence WHERE play_id = ? ORDER BY name",
        (play_id,),
    ).fetchall()
    return [dict(r) for r in rows]
