"""Per-play WebSocket fan-out. Kept in-process: one container, SQLite stores
durable history so reconnecting clients can catch up from their last seq."""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket


@dataclass
class Client:
    client_id: str
    name: str
    color: str
    ws: WebSocket
    conn_id: int


@dataclass
class Room:
    play_id: str
    clients: dict[int, Client] = field(default_factory=dict)


class ConnectionManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self._next_conn = 0

    def room(self, play_id: str) -> Room:
        if play_id not in self.rooms:
            self.rooms[play_id] = Room(play_id)
        return self.rooms[play_id]

    def connect(self, play_id: str, client_id: str, name: str, color: str, ws: WebSocket) -> Client:
        room = self.room(play_id)
        self._next_conn += 1
        client = Client(client_id=client_id, name=name, color=color, ws=ws, conn_id=self._next_conn)
        room.clients[client.conn_id] = client
        return client

    def disconnect(self, play_id: str, client: Client) -> None:
        room = self.rooms.get(play_id)
        if room:
            room.clients.pop(client.conn_id, None)

    def online_ids(self, play_id: str) -> set[str]:
        room = self.rooms.get(play_id)
        if not room:
            return set()
        return {c.client_id for c in room.clients.values()}

    async def send_json(self, ws: WebSocket, message: dict[str, Any]) -> None:
        try:
            await ws.send_text(json.dumps(message, separators=(",", ":")))
        except Exception:
            pass

    async def broadcast(self, play_id: str, message: dict[str, Any]) -> None:
        room = self.rooms.get(play_id)
        if not room:
            return
        text = json.dumps(message, separators=(",", ":"))
        dead: list[int] = []
        for conn_id, c in list(room.clients.items()):
            try:
                await c.ws.send_text(text)
            except Exception:
                dead.append(conn_id)
        for conn_id in dead:
            room.clients.pop(conn_id, None)

    def presence_snapshot(self, play_id: str) -> list[dict[str, Any]]:
        room = self.rooms.get(play_id)
        if not room:
            return []
        seen: dict[str, dict[str, Any]] = {}
        for c in room.clients.values():
            seen[c.client_id] = {"client_id": c.client_id, "name": c.name, "color": c.color, "online": True}
        return sorted(seen.values(), key=lambda m: m["name"])


manager = ConnectionManager()
